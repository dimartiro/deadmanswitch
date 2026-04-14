import { useState, useEffect, useCallback } from "react";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import { useAllAccounts } from "../hooks/useAllAccounts";
import { getClient } from "../hooks/useChain";
import { stack_template } from "@polkadot-api/descriptors";
import { formatDispatchError, formatDuration } from "../utils/format";

interface SwitchData {
	id: bigint;
	owner: string;
	triggerReward: bigint;
	callCount: number;
	blockInterval: number;
	expiryBlock: number;
	status: string;
}

function formatBalance(planck: bigint): string {
	const whole = planck / 1_000_000_000_000n;
	const frac = planck % 1_000_000_000_000n;
	if (frac === 0n) return whole.toLocaleString();
	const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
	return `${whole.toLocaleString()}.${fracStr}`;
}

function truncateAddress(addr: string): string {
	return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

export default function SwitchesPage() {
	const { wsUrl, connected, blockNumber, selectedAccount } = useChainStore();
	const { accounts, selected } = useAllAccounts();
	const [switches, setSwitches] = useState<SwitchData[]>([]);
	const [loading, setLoading] = useState(false);
	const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

	const fetchSwitches = useCallback(async () => {
		if (!connected) return;
		setLoading(true);
		try {
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const entries = await api.query.DeadmanSwitchPallet.Switches.getEntries();
			const items: SwitchData[] = entries.map((entry) => ({
				id: entry.keyArgs[0] as bigint,
				owner: entry.value.owner as string,
				triggerReward: entry.value.trigger_reward as bigint,
				callCount: entry.value.call_count as number,
				blockInterval: entry.value.block_interval as number,
				expiryBlock: entry.value.expiry_block as number,
				status: (entry.value.status as { type: string }).type,
			}));
			items.sort((a, b) => Number(a.id) - Number(b.id));
			setSwitches(items);
		} catch (e) {
			console.error("Failed to fetch switches:", e);
		} finally {
			setLoading(false);
		}
	}, [connected, wsUrl]);

	useEffect(() => {
		fetchSwitches();
	}, [fetchSwitches, blockNumber]);

	async function handleAction(
		switchId: bigint,
		action: "heartbeat" | "trigger" | "cancel",
	) {
		const key = `${switchId}-${action}`;
		setActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
		try {
			if (!selected) throw new Error("No account selected");
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const signer = selected.signer;

			let tx;
			if (action === "heartbeat") {
				tx = api.tx.DeadmanSwitchPallet.heartbeat({ id: switchId });
			} else if (action === "trigger") {
				tx = api.tx.DeadmanSwitchPallet.trigger({ id: switchId });
			} else {
				tx = api.tx.DeadmanSwitchPallet.cancel({ id: switchId });
			}

			const result = await tx.signAndSubmit(signer);
			if (result.ok) {
				setActionStatus((s) => ({ ...s, [key]: "Success" }));
				fetchSwitches();
			} else {
				setActionStatus((s) => ({
					...s,
					[key]: `Error: ${formatDispatchError(result.dispatchError)}`,
				}));
			}
		} catch (e) {
			setActionStatus((s) => ({
				...s,
				[key]: `Error: ${e instanceof Error ? e.message : String(e)}`,
			}));
		}
	}

	const currentAccount = selected?.address ?? "";

	const mySwitchesActive = switches.filter(
		(s) => s.owner === currentAccount && s.status === "Active" && blockNumber <= s.expiryBlock,
	);
	const expiredSwitches = switches.filter(
		(s) => s.status === "Active" && blockNumber > s.expiryBlock,
	);
	const otherActive = switches.filter(
		(s) => s.owner !== currentAccount && s.status === "Active" && blockNumber <= s.expiryBlock,
	);
	const executedSwitches = switches.filter(
		(s) => s.status === "Executed" && s.owner === currentAccount,
	);

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title">Dashboard</h1>
				<p className="text-text-secondary">
					View all dedman switches. Send heartbeats, trigger expired ones, or
					cancel your own.
				</p>
			</div>

			{/* Account selector */}
			<div className="card space-y-3">
				<h2 className="section-title">Viewing as</h2>
				<div className="flex flex-wrap gap-2">
					{accounts.map((acc, i) => (
						<button
							key={acc.address}
							onClick={() => useChainStore.getState().setSelectedAccount(i)}
							className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
								selectedAccount === i
									? "bg-polka-500/20 text-white border border-polka-500/30"
									: "text-text-secondary hover:text-text-primary hover:bg-white/[0.04] border border-transparent"
							}`}
						>
							{acc.name}
						</button>
					))}
				</div>
				{selected && (
					<p className="text-xs text-text-muted font-mono">
						{selected.address}
					</p>
				)}
			</div>

			{loading && switches.length === 0 && (
				<div className="card animate-pulse">
					<div className="h-4 w-48 rounded bg-white/[0.06]" />
				</div>
			)}

			{!loading && switches.length === 0 && (
				<div className="card">
					<p className="text-text-muted">
						No switches found.{" "}
						<a href="#/create" className="text-polka-400 hover:text-polka-300">
							Create one
						</a>
						.
					</p>
				</div>
			)}

			{/* My active switches */}
			{mySwitchesActive.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title">My Switches</h2>
					{mySwitchesActive.map((sw) => (
						<SwitchCard
							key={Number(sw.id)}
							sw={sw}
							blockNumber={blockNumber}
							currentAccount={currentAccount}
							onAction={handleAction}
							actionStatus={actionStatus}
						/>
					))}
				</div>
			)}

			{/* Other active switches */}
			{otherActive.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title">Other Active Switches</h2>
					{otherActive.map((sw) => (
						<SwitchCard
							key={Number(sw.id)}
							sw={sw}
							blockNumber={blockNumber}
							currentAccount={currentAccount}
							onAction={handleAction}
							actionStatus={actionStatus}
						/>
					))}
				</div>
			)}

			{/* Expired — trigger opportunities */}
			{expiredSwitches.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title text-accent-red">
						Expired — Trigger to earn reward
					</h2>
					{expiredSwitches.map((sw) => (
						<SwitchCard
							key={Number(sw.id)}
							sw={sw}
							blockNumber={blockNumber}
							currentAccount={currentAccount}
							onAction={handleAction}
							actionStatus={actionStatus}
						/>
					))}
				</div>
			)}

			{/* Executed */}
			{executedSwitches.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title text-text-muted">Executed</h2>
					{executedSwitches.map((sw) => (
						<SwitchCard
							key={Number(sw.id)}
							sw={sw}
							blockNumber={blockNumber}
							currentAccount={currentAccount}
							onAction={handleAction}
							actionStatus={actionStatus}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function SwitchCard({
	sw,
	blockNumber,
	currentAccount,
	onAction,
	actionStatus,
}: {
	sw: SwitchData;
	blockNumber: number;
	currentAccount: string;
	onAction: (id: bigint, action: "heartbeat" | "trigger" | "cancel") => void;
	actionStatus: Record<string, string>;
}) {
	const isOwner = sw.owner === currentAccount;
	const isActive = sw.status === "Active";
	const isExpired = isActive && blockNumber > sw.expiryBlock;
	const blocksLeft = isActive ? sw.expiryBlock - blockNumber : 0;
	const blockTime = useChainStore((s) => s.blockTime);
	const secondsLeft = Math.max(0, blocksLeft * blockTime);

	const devAccount = devAccounts.find((a) => a.address === sw.owner);
	const ownerLabel = devAccount ? devAccount.name : truncateAddress(sw.owner);

	let statusBadge;
	if (sw.status === "Executed") {
		statusBadge = (
			<span className="status-badge bg-text-muted/10 text-text-muted border border-text-muted/20">
				Executed
			</span>
		);
	} else if (isExpired) {
		statusBadge = (
			<span className="status-badge bg-accent-red/10 text-accent-red border border-accent-red/20 animate-pulse-slow">
				Expired
			</span>
		);
	} else {
		statusBadge = (
			<span className="status-badge bg-accent-green/10 text-accent-green border border-accent-green/20">
				Active
			</span>
		);
	}

	return (
		<div className="card space-y-3">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<span className="text-lg font-semibold text-text-primary font-mono">
						#{Number(sw.id)}
					</span>
					{statusBadge}
				</div>
				<span className="text-sm text-text-secondary">
					Owner: <span className="font-medium text-text-primary">{ownerLabel}</span>
				</span>
			</div>

			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
				<div>
					<span className="text-text-muted">Calls</span>
					<p className="font-mono text-text-primary">{sw.callCount}</p>
				</div>
				<div>
					<span className="text-text-muted">Trigger Reward</span>
					<p className="font-mono text-text-primary">
						{formatBalance(sw.triggerReward)} UNIT
					</p>
				</div>
				<div>
					<span className="text-text-muted">Expiry Block</span>
					<p className="font-mono text-text-primary">#{sw.expiryBlock}</p>
				</div>
				<div>
					<span className="text-text-muted">Countdown</span>
					<p
						className={`font-mono ${
							isExpired
								? "text-accent-red"
								: blocksLeft < 10
									? "text-accent-yellow"
									: "text-text-primary"
						}`}
					>
						{sw.status === "Executed"
							? "—"
							: isExpired
								? `Expired ${Math.abs(blocksLeft)} blocks ago`
								: `${blocksLeft} blocks (~${formatDuration(secondsLeft)})`}
					</p>
				</div>
			</div>

			{/* Actions */}
			{isActive && (
				<div className="flex gap-2 pt-1">
					{isOwner && !isExpired && (
						<button
							onClick={() => onAction(sw.id, "heartbeat")}
							className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-green/10 text-accent-green border border-accent-green/20 hover:bg-accent-green/20 transition-colors"
						>
							Heartbeat
						</button>
					)}
					{isExpired && (
						<button
							onClick={() => onAction(sw.id, "trigger")}
							className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-red/10 text-accent-red border border-accent-red/20 hover:bg-accent-red/20 transition-colors"
						>
							Trigger — earn {formatBalance(sw.triggerReward)} UNIT
						</button>
					)}
					{isOwner && (
						<button
							onClick={() => onAction(sw.id, "cancel")}
							className="px-3 py-1.5 rounded-lg text-xs font-medium bg-text-muted/10 text-text-secondary border border-text-muted/20 hover:bg-text-muted/20 transition-colors"
						>
							Cancel
						</button>
					)}
				</div>
			)}

			{/* Action status */}
			{["heartbeat", "trigger", "cancel"].map((action) => {
				const key = `${sw.id}-${action}`;
				const status = actionStatus[key];
				if (!status) return null;
				return (
					<p
						key={key}
						className={`text-xs font-medium ${
							status.startsWith("Error")
								? "text-accent-red"
								: status === "Success"
									? "text-accent-green"
									: "text-accent-yellow"
						}`}
					>
						{action}: {status}
					</p>
				);
			})}
		</div>
	);
}
