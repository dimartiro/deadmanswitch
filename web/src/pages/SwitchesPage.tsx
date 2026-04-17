import { useState, useEffect, useCallback } from "react";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import { useAllAccounts } from "../hooks/useAllAccounts";
import { getClient } from "../hooks/useChain";
import { stack_template } from "@polkadot-api/descriptors";
import { formatDispatchError, formatDuration } from "../utils/format";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";

interface DecodedCall {
	pallet: string;
	call: string;
	args: Record<string, unknown>;
}

interface SwitchData {
	id: bigint;
	owner: string;
	callCount: number;
	blockInterval: number;
	expiryBlock: number;
	executedBlock: number;
	status: string;
	calls: DecodedCall[];
}

function formatCallArgs(args: Record<string, unknown>): string {
	const replacer = (_key: string, value: unknown) =>
		typeof value === "bigint" ? value.toString() : value;
	return JSON.stringify(args, replacer, 2);
}

function decodeMultiAddress(bytes: Uint8Array, offset: number): { address: string; size: number } {
	const tag = bytes[offset]; // 0 = Id (32 bytes)
	if (tag === 0) {
		const pubkey = bytes.slice(offset + 1, offset + 33);
		return { address: ss58Address(pubkey), size: 33 };
	}
	return { address: "Unknown MultiAddress type " + tag, size: 1 };
}

function decodeCompactU128(bytes: Uint8Array, offset: number): { value: bigint; size: number } {
	const mode = bytes[offset] & 0b11;
	if (mode === 0) return { value: BigInt(bytes[offset] >> 2), size: 1 };
	if (mode === 1) {
		const v = (bytes[offset] | (bytes[offset + 1] << 8)) >> 2;
		return { value: BigInt(v), size: 2 };
	}
	if (mode === 2) {
		const v = (bytes[offset] | (bytes[offset + 1] << 8) |
			(bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 2;
		return { value: BigInt(v), size: 4 };
	}
	// Big integer mode
	const len = (bytes[offset] >> 2) + 4;
	let val = 0n;
	for (let i = len; i > 0; i--) {
		val = (val << 8n) | BigInt(bytes[offset + i]);
	}
	return { value: val, size: 1 + len };
}

function decodeCallArgs(palletIdx: number, callIdx: number, argBytes: Uint8Array): Record<string, unknown> {
	try {
		// Balances.transfer_allow_death (10, 0): MultiAddress dest + Compact<u128> value
		if (palletIdx === 10 && callIdx === 0) {
			const dest = decodeMultiAddress(argBytes, 0);
			const value = decodeCompactU128(argBytes, dest.size);
			return { dest: dest.address, value: formatBalanceUnit(value.value) };
		}
		// Balances.transfer_all (10, 4): MultiAddress dest + bool keep_alive
		if (palletIdx === 10 && callIdx === 4) {
			const dest = decodeMultiAddress(argBytes, 0);
			const keepAlive = argBytes[dest.size] === 1;
			return { dest: dest.address, keep_alive: keepAlive };
		}
		// Proxy.add_proxy (60, 1): MultiAddress delegate + ProxyType + u32 delay
		if (palletIdx === 60 && callIdx === 1) {
			const delegate = decodeMultiAddress(argBytes, 0);
			const proxyType = argBytes[delegate.size]; // 0=Any, 1=Transfers
			const proxyTypeNames: Record<number, string> = { 0: "Any", 1: "Transfers" };
			return {
				delegate: delegate.address,
				proxy_type: proxyTypeNames[proxyType] || `Unknown(${proxyType})`,
			};
		}
		// System.remark (0, 1): Vec<u8> remark
		if (palletIdx === 0 && callIdx === 1) {
			const len = decodeCompactU128(argBytes, 0);
			const remarkBytes = argBytes.slice(len.size, len.size + Number(len.value));
			const text = new TextDecoder().decode(remarkBytes);
			return { message: text };
		}
	} catch {
		// Fall through to hex
	}
	return { encoded: "0x" + Array.from(argBytes).map(b => b.toString(16).padStart(2, "0")).join("") };
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
			const switchEntries = await api.query.DeadmanSwitchPallet.Switches.getEntries();
			const callEntries = await api.query.DeadmanSwitchPallet.SwitchCalls.getEntries();

			// Decode stored calls by pallet/call index
			const PALLET_NAMES: Record<number, string> = {
				0: "System", 1: "ParachainSystem", 2: "Timestamp",
				10: "Balances", 11: "TransactionPayment", 15: "Sudo",
				50: "DeadmanSwitchPallet", 60: "Proxy", 61: "Multisig", 90: "Revive",
			};
			const CALL_NAMES: Record<string, Record<number, string>> = {
				System: { 0: "fill_block", 1: "remark", 7: "remark_with_event" },
				Balances: { 0: "transfer_allow_death", 1: "force_transfer", 3: "transfer_keep_alive", 4: "transfer_all" },
				Proxy: { 0: "proxy", 1: "add_proxy", 2: "remove_proxy" },
				Multisig: { 0: "as_multi_threshold_1", 1: "as_multi", 2: "approve_as_multi" },
				DeadmanSwitchPallet: { 0: "create_switch", 1: "heartbeat", 2: "execute_switch", 3: "cancel" },
			};

			const callsMap = new Map<string, DecodedCall[]>();
			for (const entry of callEntries) {
				const switchId = String(entry.keyArgs[0]);
				const decoded: DecodedCall[] = [];
				for (const callBinary of entry.value) {
					try {
						const bytes = callBinary.asBytes();
						const palletIdx = bytes[0];
						const callIdx = bytes[1];
						const palletName = PALLET_NAMES[palletIdx] || `Pallet(${palletIdx})`;
						const callName = CALL_NAMES[palletName]?.[callIdx] || `call(${callIdx})`;
						decoded.push({
							pallet: palletName,
							call: callName,
							args: decodeCallArgs(palletIdx, callIdx, bytes.slice(2)),
						});
					} catch {
						decoded.push({ pallet: "Unknown", call: "decode failed", args: {} });
					}
				}
				callsMap.set(switchId, decoded);
			}

			const items: SwitchData[] = switchEntries.map((entry) => {
				const id = entry.keyArgs[0] as bigint;
				return {
					id,
					owner: entry.value.owner as string,
					callCount: entry.value.call_count as number,
					blockInterval: entry.value.block_interval as number,
					expiryBlock: entry.value.expiry_block as number,
					executedBlock: entry.value.executed_block as number,
					status: (entry.value.status as { type: string }).type,
					calls: callsMap.get(String(id)) || [],
				};
			});

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
		action: "heartbeat" | "cancel",
	) {
		const key = `${switchId}-${action}`;
		setActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
		try {
			if (!selected) throw new Error("No account selected");
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const signer = selected.signer;

			const tx =
				action === "heartbeat"
					? api.tx.DeadmanSwitchPallet.heartbeat({ id: switchId })
					: api.tx.DeadmanSwitchPallet.cancel({ id: switchId });

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
					View all dedman switches. Send heartbeats or cancel your own —
					expired switches auto-execute via the on-chain scheduler.
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

			{/* Expired — awaiting scheduler */}
			{expiredSwitches.length > 0 && (
				<div className="space-y-3">
					<h2 className="section-title text-accent-yellow">
						Expired — Awaiting Scheduled Execution
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
	onAction: (id: bigint, action: "heartbeat" | "cancel") => void;
	actionStatus: Record<string, string>;
}) {
	const [expanded, setExpanded] = useState(false);
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

			<div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
				<div
					onClick={() => sw.calls.length > 0 && setExpanded(!expanded)}
					className={sw.calls.length > 0 ? "cursor-pointer group" : ""}
				>
					<span className="text-text-muted">Calls</span>
					<p className="font-mono text-text-primary">
						{sw.callCount}
						{sw.calls.length > 0 && (
							<span className="text-text-muted group-hover:text-text-secondary ml-1">
								{expanded ? "▲" : "▼"}
							</span>
						)}
					</p>
				</div>
				<div>
					<span className="text-text-muted">Expiry Block</span>
					<p className="font-mono text-text-primary">#{sw.expiryBlock}</p>
				</div>
				<div>
					<span className="text-text-muted">
						{sw.status === "Executed" ? "Executed at" : "Countdown"}
					</span>
					<p
						className={`font-mono ${
							sw.status === "Executed"
								? "text-text-primary"
								: isExpired
									? "text-accent-red"
									: blocksLeft < 10
										? "text-accent-yellow"
										: "text-text-primary"
						}`}
					>
						{sw.status === "Executed"
							? `Block #${sw.executedBlock}`
							: isExpired
								? `Expired ${Math.abs(blocksLeft)} blocks ago`
								: `${blocksLeft} blocks (~${formatDuration(secondsLeft)})`}
					</p>
				</div>
			</div>

			{/* Expanded calls detail */}
			{expanded && sw.calls.length > 0 && (
				<div className="space-y-2 pt-1">
					{sw.calls.map((call, i) => (
						<div
							key={i}
							className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-1"
						>
							<div className="flex items-center gap-2">
								<span className="text-xs font-medium text-accent-blue">
									#{i + 1}
								</span>
								<span className="text-sm font-semibold text-text-primary">
									{call.pallet}.{call.call}
								</span>
							</div>
							<pre className="text-xs text-text-secondary font-mono overflow-x-auto whitespace-pre-wrap break-all">
								{formatCallArgs(call.args)}
							</pre>
						</div>
					))}
				</div>
			)}

			{/* Actions */}
			{isActive && isOwner && (
				<div className="flex gap-2 pt-1">
					{!isExpired && (
						<button
							onClick={() => onAction(sw.id, "heartbeat")}
							className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-green/10 text-accent-green border border-accent-green/20 hover:bg-accent-green/20 transition-colors"
						>
							Heartbeat
						</button>
					)}
					<button
						onClick={() => onAction(sw.id, "cancel")}
						className="px-3 py-1.5 rounded-lg text-xs font-medium bg-text-muted/10 text-text-secondary border border-text-muted/20 hover:bg-text-muted/20 transition-colors"
					>
						Cancel
					</button>
				</div>
			)}

			{/* Action status */}
			{["heartbeat", "cancel"].map((action) => {
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
