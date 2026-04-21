import { useState, useEffect, useCallback } from "react";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import { useAllAccounts } from "../hooks/useAllAccounts";
import { getClient } from "../hooks/useChain";
import { stack_template } from "@polkadot-api/descriptors";
import { formatDuration } from "../utils/format";
import { submitAndWait } from "../utils/tx";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bequest = any;

interface WillData {
	id: bigint;
	owner: string;
	bequestCount: number;
	blockInterval: number;
	expiryBlock: number;
	executedBlock: number;
	status: string;
	bequests: Bequest[];
}

function formatBalanceUnit(planck: bigint): string {
	const whole = planck / 1_000_000_000_000n;
	const frac = planck % 1_000_000_000_000n;
	if (frac === 0n) return whole.toString() + " UNIT";
	const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
	return `${whole}.${fracStr} UNIT`;
}

function truncateAddress(addr: string): string {
	return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function accountLabel(addr: string): string {
	const dev = devAccounts.find((a) => a.address === addr);
	return dev ? dev.name : truncateAddress(addr);
}

function renderBequest(bequest: Bequest): { title: string; detail: string } {
	const type = bequest.type as string;
	const value = bequest.value;
	switch (type) {
		case "Transfer":
			return {
				title: `Transfer ${formatBalanceUnit(value.amount)}`,
				detail: `to ${accountLabel(value.dest)}`,
			};
		case "TransferAll":
			return {
				title: "Transfer everything",
				detail: `to ${accountLabel(value.dest)}`,
			};
		case "Proxy":
			return {
				title: "Grant proxy access",
				detail: `to ${accountLabel(value.delegate)}`,
			};
		case "MultisigProxy": {
			const delegates = (value.delegates as string[])
				.map(accountLabel)
				.join(", ");
			return {
				title: `Grant multisig proxy (${value.threshold} of ${value.delegates.length})`,
				detail: delegates,
			};
		}
		default:
			return { title: `Unknown (${type})`, detail: "" };
	}
}

function recipientsOf(bequest: Bequest): string[] {
	const type = bequest.type as string;
	const value = bequest.value;
	switch (type) {
		case "Transfer":
		case "TransferAll":
			return [value.dest as string];
		case "Proxy":
			return [value.delegate as string];
		case "MultisigProxy":
			return value.delegates as string[];
		default:
			return [];
	}
}

export default function WillsPage() {
	const { wsUrl, connected, blockNumber, selectedAccount } = useChainStore();
	const { accounts, selected } = useAllAccounts();
	const [wills, setWills] = useState<WillData[]>([]);
	const [inheritanceIds, setInheritanceIds] = useState<bigint[]>([]);
	const [loading, setLoading] = useState(false);
	const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

	const fetchWills = useCallback(async () => {
		if (!connected) return;
		setLoading(true);
		try {
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const willEntries = await api.query.EstateExecutor.Wills.getEntries();
			const bequestEntries =
				await api.query.EstateExecutor.WillBequests.getEntries();

			const bequestsMap = new Map<string, Bequest[]>();
			for (const entry of bequestEntries) {
				const willId = String(entry.keyArgs[0]);
				bequestsMap.set(willId, entry.value as Bequest[]);
			}

			const items: WillData[] = willEntries.map((entry) => {
				const id = entry.keyArgs[0] as bigint;
				return {
					id,
					owner: entry.value.owner as string,
					bequestCount: entry.value.bequest_count as number,
					blockInterval: entry.value.block_interval as number,
					expiryBlock: entry.value.expiry_block as number,
					executedBlock: entry.value.executed_block as number,
					status: (entry.value.status as { type: string }).type,
					bequests: bequestsMap.get(String(id)) || [],
				};
			});

			items.sort((a, b) => Number(a.id) - Number(b.id));
			setWills(items);

			if (selected) {
				try {
					const ids = await api.apis.EstateExecutorApi.inheritances_of(
						selected.address,
					);
					setInheritanceIds(ids as bigint[]);
				} catch {
					setInheritanceIds([]);
				}
			} else {
				setInheritanceIds([]);
			}
		} catch (e) {
			console.error("Failed to fetch wills:", e);
		} finally {
			setLoading(false);
		}
	}, [connected, wsUrl, selected?.address]);

	useEffect(() => {
		fetchWills();
	}, [fetchWills, blockNumber]);

	async function handleAction(
		willId: bigint,
		action: "heartbeat" | "cancel",
	) {
		const key = `${willId}-${action}`;
		setActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
		try {
			if (!selected) throw new Error("No account selected");
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const signer = selected.signer;

			const tx =
				action === "heartbeat"
					? api.tx.EstateExecutor.heartbeat({ id: willId })
					: api.tx.EstateExecutor.cancel({ id: willId });

			const result = await submitAndWait(tx, signer);
			if (result.ok) {
				setActionStatus((s) => ({ ...s, [key]: "Success" }));
				fetchWills();
			} else {
				setActionStatus((s) => ({
					...s,
					[key]: `Error: ${result.errorMessage ?? "unknown"}`,
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

	const myWillsActive = wills.filter(
		(w) =>
			w.owner === currentAccount &&
			w.status === "Active" &&
			blockNumber <= w.expiryBlock,
	);
	const isInheritance = (w: WillData) =>
		inheritanceIds.some((id) => id === w.id);
	const inheritances = wills.filter(
		(w) =>
			isInheritance(w) &&
			w.owner !== currentAccount &&
			w.status === "Active" &&
			blockNumber <= w.expiryBlock,
	);
	const expiredWills = wills.filter(
		(w) => w.status === "Active" && blockNumber > w.expiryBlock,
	);
	const otherActive = wills.filter(
		(w) =>
			w.owner !== currentAccount &&
			!isInheritance(w) &&
			w.status === "Active" &&
			blockNumber <= w.expiryBlock,
	);
	const executedWills = wills.filter(
		(w) => w.status === "Executed" && w.owner === currentAccount,
	);

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title">Dashboard</h1>
				<p className="text-text-secondary">
					View all wills on the chain. Send heartbeats or cancel your own
					— expired wills auto-execute via the on-chain scheduler.
				</p>
			</div>

			{/* Account selector */}
			<div className="card space-y-3">
				<h2 className="section-title">Viewing as</h2>
				<div className="flex flex-wrap gap-2">
					{accounts.map((acc, i) => (
						<button
							key={acc.address}
							onClick={() =>
								useChainStore.getState().setSelectedAccount(i)
							}
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

			{loading && wills.length === 0 && (
				<div className="card animate-pulse">
					<div className="h-4 w-48 rounded bg-white/[0.06]" />
				</div>
			)}

			{!loading && wills.length === 0 && (
				<div className="card">
					<p className="text-text-muted">
						No wills found.{" "}
						<a
							href="#/create"
							className="text-polka-400 hover:text-polka-300"
						>
							Register one
						</a>
						.
					</p>
				</div>
			)}

			{/* Inheritances — wills naming the current account as beneficiary */}
			{inheritances.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title text-accent-blue">
						Inheritances (you are listed as beneficiary)
					</h2>
					<p className="text-xs text-text-muted -mt-2">
						Source:{" "}
						<span className="font-mono">
							EstateExecutorApi.inheritances_of
						</span>{" "}
						runtime API
					</p>
					{inheritances.map((w) => (
						<WillCard
							key={Number(w.id)}
							w={w}
							blockNumber={blockNumber}
							currentAccount={currentAccount}
							onAction={handleAction}
							actionStatus={actionStatus}
						/>
					))}
				</div>
			)}

			{myWillsActive.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title">My Wills</h2>
					{myWillsActive.map((w) => (
						<WillCard
							key={Number(w.id)}
							w={w}
							blockNumber={blockNumber}
							currentAccount={currentAccount}
							onAction={handleAction}
							actionStatus={actionStatus}
						/>
					))}
				</div>
			)}

			{otherActive.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title">Other Active Wills</h2>
					{otherActive.map((w) => (
						<WillCard
							key={Number(w.id)}
							w={w}
							blockNumber={blockNumber}
							currentAccount={currentAccount}
							onAction={handleAction}
							actionStatus={actionStatus}
						/>
					))}
				</div>
			)}

			{expiredWills.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title text-accent-yellow">
						Expired — Awaiting Scheduled Execution
					</h2>
					{expiredWills.map((w) => (
						<WillCard
							key={Number(w.id)}
							w={w}
							blockNumber={blockNumber}
							currentAccount={currentAccount}
							onAction={handleAction}
							actionStatus={actionStatus}
						/>
					))}
				</div>
			)}

			{executedWills.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title text-text-muted">Executed</h2>
					{executedWills.map((w) => (
						<WillCard
							key={Number(w.id)}
							w={w}
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

function WillCard({
	w,
	blockNumber,
	currentAccount,
	onAction,
	actionStatus,
}: {
	w: WillData;
	blockNumber: number;
	currentAccount: string;
	onAction: (id: bigint, action: "heartbeat" | "cancel") => void;
	actionStatus: Record<string, string>;
}) {
	const [expanded, setExpanded] = useState(false);
	const isOwner = w.owner === currentAccount;
	const isActive = w.status === "Active";
	const isExpired = isActive && blockNumber > w.expiryBlock;
	const blocksLeft = isActive ? w.expiryBlock - blockNumber : 0;
	const blockTime = useChainStore((s) => s.blockTime);
	const secondsLeft = Math.max(0, blocksLeft * blockTime);

	const ownerLabel = accountLabel(w.owner);

	// Derive beneficiaries client-side as the union of all bequest recipients.
	const allRecipients = Array.from(
		new Set(w.bequests.flatMap(recipientsOf)),
	);

	let statusBadge;
	if (w.status === "Executed") {
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
						#{Number(w.id)}
					</span>
					{statusBadge}
				</div>
				<span className="text-sm text-text-secondary">
					Owner:{" "}
					<span className="font-medium text-text-primary">{ownerLabel}</span>
				</span>
			</div>

			<div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
				<div
					onClick={() => w.bequests.length > 0 && setExpanded(!expanded)}
					className={w.bequests.length > 0 ? "cursor-pointer group" : ""}
				>
					<span className="text-text-muted">Bequests</span>
					<p className="font-mono text-text-primary">
						{w.bequestCount}
						{w.bequests.length > 0 && (
							<span className="text-text-muted group-hover:text-text-secondary ml-1">
								{expanded ? "▲" : "▼"}
							</span>
						)}
					</p>
				</div>
				<div>
					<span className="text-text-muted">Expiry Block</span>
					<p className="font-mono text-text-primary">#{w.expiryBlock}</p>
				</div>
				<div>
					<span className="text-text-muted">
						{w.status === "Executed" ? "Executed at" : "Countdown"}
					</span>
					<p
						className={`font-mono ${
							w.status === "Executed"
								? "text-text-primary"
								: isExpired
									? "text-accent-red"
									: blocksLeft < 10
										? "text-accent-yellow"
										: "text-text-primary"
						}`}
					>
						{w.status === "Executed"
							? `Block #${w.executedBlock}`
							: isExpired
								? `Expired ${Math.abs(blocksLeft)} blocks ago`
								: `${blocksLeft} blocks (~${formatDuration(secondsLeft)})`}
					</p>
				</div>
			</div>

			{allRecipients.length > 0 && (
				<div className="text-sm">
					<span className="text-text-muted">Beneficiaries: </span>
					<span className="text-text-primary text-xs">
						{allRecipients.map(accountLabel).join(", ")}
					</span>
				</div>
			)}

			{expanded && w.bequests.length > 0 && (
				<div className="space-y-2 pt-1">
					{w.bequests.map((bequest, i) => {
						const { title, detail } = renderBequest(bequest);
						return (
							<div
								key={i}
								className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-1"
							>
								<div className="flex items-center gap-2">
									<span className="text-xs font-medium text-accent-blue">
										#{i + 1}
									</span>
									<span className="text-sm font-semibold text-text-primary">
										{title}
									</span>
								</div>
								<p className="text-xs text-text-secondary">{detail}</p>
							</div>
						);
					})}
				</div>
			)}

			{isActive && isOwner && (
				<div className="flex gap-2 pt-1">
					{!isExpired && (
						<button
							onClick={() => onAction(w.id, "heartbeat")}
							className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-green/10 text-accent-green border border-accent-green/20 hover:bg-accent-green/20 transition-colors"
						>
							Heartbeat
						</button>
					)}
					<button
						onClick={() => onAction(w.id, "cancel")}
						className="px-3 py-1.5 rounded-lg text-xs font-medium bg-text-muted/10 text-text-secondary border border-text-muted/20 hover:bg-text-muted/20 transition-colors"
					>
						Cancel
					</button>
				</div>
			)}

			{["heartbeat", "cancel"].map((action) => {
				const key = `${w.id}-${action}`;
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
