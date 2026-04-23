import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { useChainStore } from "../store/chainStore";
import { useAllAccounts } from "../hooks/useAllAccounts";
import { getClient } from "../hooks/useChain";
import { stack_template } from "@polkadot-api/descriptors";
import {
	accountLabel,
	formatBalanceWithUnit,
	formatDuration,
} from "../utils/format";
import { submitAndWait } from "../utils/tx";
import { ss58Decode } from "@polkadot-labs/hdkd-helpers";
import { toast } from "../store/toastStore";

// Compare two SS58 addresses by their pubkey, ignoring the address's
// network prefix. Store-side addresses and on-chain addresses can be
// encoded with different SS58 prefixes and still refer to the same key.
function sameAccount(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	try {
		const [p1] = ss58Decode(a);
		const [p2] = ss58Decode(b);
		if (p1.length !== p2.length) return false;
		for (let i = 0; i < p1.length; i++) if (p1[i] !== p2[i]) return false;
		return true;
	} catch {
		return false;
	}
}

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

type FilterKey = "all" | "mine" | "inherits" | "expired" | "executed";

function renderBequest(bequest: Bequest): string {
	const type = bequest.type as string;
	const value = bequest.value;
	switch (type) {
		case "Transfer":
			return `Transfer ${formatBalanceWithUnit(value.amount)} to ${accountLabel(value.dest)}`;
		case "TransferAll":
			return `Transfer entire Asset Hub balance to ${accountLabel(value.dest)}`;
		case "Proxy":
			return `Grant ${accountLabel(value.delegate)} full proxy over Asset Hub account`;
		case "MultisigProxy": {
			const delegates = (value.delegates as string[])
				.map(accountLabel)
				.join(", ");
			return `Grant ${value.threshold}-of-${value.delegates.length} multisig (${delegates}) full proxy`;
		}
		default:
			return `Unknown (${type})`;
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
	const [loading, setLoading] = useState(false);
	const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState<FilterKey>("all");
	const [confirmingCancel, setConfirmingCancel] = useState<WillData | null>(null);

	const fetchWills = useCallback(async () => {
		if (!connected) return;
		setLoading(true);
		try {
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const willEntries = await api.query.EstateExecutor.Wills.getEntries({
				at: "best",
			});
			const bequestEntries =
				await api.query.EstateExecutor.WillBequests.getEntries({ at: "best" });

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

			items.sort((a, b) => Number(b.id) - Number(a.id));
			setWills(items);
		} catch (e) {
			console.error("Failed to fetch wills:", e);
		} finally {
			setLoading(false);
		}
	}, [connected, wsUrl]);

	useEffect(() => {
		fetchWills();
	}, [fetchWills, blockNumber]);

	async function handleAction(willId: bigint, action: "heartbeat" | "cancel") {
		const key = `${willId}-${action}`;
		const pastLabel = action === "heartbeat" ? "Heartbeat sent" : "Will cancelled";
		const failLabel = action === "heartbeat" ? "Heartbeat failed" : "Cancel failed";
		setPendingActions((s) => new Set(s).add(key));
		try {
			if (!selected) throw new Error("No account selected");
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const signer = selected.signer;
			const tx =
				action === "heartbeat"
					? api.tx.EstateExecutor.heartbeat({ id: willId })
					: api.tx.EstateExecutor.cancel({ id: willId });
			const result = await submitAndWait(tx, signer, client);
			if (result.ok) {
				toast.success(pastLabel);
				fetchWills();
			} else {
				toast.error(failLabel, result.errorMessage ?? "unknown");
			}
		} catch (e) {
			toast.error(
				failLabel,
				e instanceof Error ? e.message : String(e),
			);
		} finally {
			setPendingActions((s) => {
				const next = new Set(s);
				next.delete(key);
				return next;
			});
		}
	}

	const currentAccount = selected?.address ?? "";
	// Computed client-side from the same bequests we already have. Avoids
	// any mismatch between the runtime API's account-id encoding and the
	// SS58 address format the frontend holds.
	const isInheritance = (w: WillData) => {
		if (!currentAccount) return false;
		return w.bequests.some((b) =>
			recipientsOf(b).some((r) => sameAccount(r, currentAccount)),
		);
	};

	const counts = useMemo(() => {
		let active = 0;
		let executed = 0;
		let expired = 0;
		let mine = 0;
		let inherits = 0;
		for (const w of wills) {
			if (w.status === "Executed") executed++;
			else if (blockNumber > w.expiryBlock) expired++;
			else active++;
			if (sameAccount(w.owner, currentAccount)) mine++;
			if (isInheritance(w)) inherits++;
		}
		return { active, executed, expired, mine, inherits };
		// isInheritance reads currentAccount + wills, both in deps.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [wills, blockNumber, currentAccount]);

	const filtered = wills.filter((w) => {
		const isExpired = w.status === "Active" && blockNumber > w.expiryBlock;
		const isExec = w.status === "Executed";
		switch (filter) {
			case "mine":
				return sameAccount(w.owner, currentAccount);
			case "inherits":
				return isInheritance(w) && !sameAccount(w.owner, currentAccount);
			case "expired":
				return isExpired;
			case "executed":
				return isExec;
			default:
				return true;
		}
	});

	return (
		<div className="space-y-8 stagger">
			{/* Page header */}
			<div className="flex items-end justify-between gap-4 flex-wrap">
				<div>
					<div className="eyebrow mb-1">The Vault</div>
					<h1 className="h-display text-4xl md:text-5xl">
						All <span className="italic text-neon-500">wills</span>, on chain
					</h1>
					<p className="text-sm text-ink-500 mt-2">
						Every will registered through Estate Protocol, grouped by your
						relationship to them.
					</p>
				</div>
				<Link to="/create" className="btn-accent">
					New will
					<span>→</span>
				</Link>
			</div>

			{/* Top strip: stat cards (differentiated vs. rest of page) */}
			<section className="grid grid-cols-2 md:grid-cols-4 gap-3">
				<StatCard label="Active" value={counts.active} tone="estate" />
				<StatCard label="Expired" value={counts.expired} tone="danger" />
				<StatCard label="Executed" value={counts.executed} tone="brass" />
				<StatCard label="Yours" value={counts.mine} tone="neutral" />
			</section>

			{/* Control row */}
			<section className="card-padded">
				<div className="flex items-center justify-between flex-wrap gap-4">
					<div>
						<div className="eyebrow mb-1">Reading as</div>
						<div className="flex flex-wrap gap-2">
							{accounts.map((acc, i) => (
								<button
									key={acc.address}
									onClick={() =>
										useChainStore.getState().setSelectedAccount(i)
									}
									className={`text-sm px-3 py-1.5 rounded-full transition-all ${
										selectedAccount === i
											? "bg-ink-900 text-canvas shadow-soft"
											: "bg-muted text-ink-700 hover:bg-mist"
									}`}
								>
									{acc.name}
								</button>
							))}
						</div>
					</div>

					{selected && (
						<div className="hidden md:block">
							<div className="eyebrow mb-1 text-right">Signer</div>
							<div className="font-mono text-xs text-ink-500">
								{selected.address}
							</div>
						</div>
					)}
				</div>

				<div className="mt-5 pt-5 border-t border-hairline">
					<div className="eyebrow mb-2">Filter</div>
					<div className="flex flex-wrap gap-2">
						<FilterPill
							active={filter === "all"}
							onClick={() => setFilter("all")}
							count={wills.length}
						>
							Everything
						</FilterPill>
						<FilterPill
							active={filter === "mine"}
							onClick={() => setFilter("mine")}
							count={counts.mine}
						>
							Yours
						</FilterPill>
						<FilterPill
							active={filter === "inherits"}
							onClick={() => setFilter("inherits")}
							count={counts.inherits}
						>
							Name you
						</FilterPill>
						<FilterPill
							active={filter === "expired"}
							onClick={() => setFilter("expired")}
							count={counts.expired}
						>
							Expired
						</FilterPill>
						<FilterPill
							active={filter === "executed"}
							onClick={() => setFilter("executed")}
							count={counts.executed}
						>
							Executed
						</FilterPill>
					</div>
				</div>
			</section>

			{/* List */}
			<section>
				{loading && wills.length === 0 ? (
					<div className="card-padded text-center text-ink-500 text-sm py-12">
						Loading the vault…
					</div>
				) : filtered.length === 0 ? (
					<div className="card-padded text-center py-16">
						<div className="text-5xl mb-3">📜</div>
						<h3 className="h-section mb-1">Nothing here yet</h3>
						<p className="text-sm text-ink-500 max-w-xs mx-auto mb-5">
							{filter === "all"
								? "No wills have been registered yet."
								: "No wills match this filter right now."}
						</p>
						{filter === "all" && (
							<Link to="/create" className="btn-accent">
								Draft the first
							</Link>
						)}
					</div>
				) : (
					<div className="space-y-3">
						{filtered.map((w) => (
							<WillRow
								key={Number(w.id)}
								w={w}
								blockNumber={blockNumber}
								currentAccount={currentAccount}
								isInheritance={isInheritance(w)}
								onAction={handleAction}
								onRequestCancel={(will) => setConfirmingCancel(will)}
								pendingActions={pendingActions}
							/>
						))}
					</div>
				)}
			</section>

			{confirmingCancel && (
				<CancelConfirm
					will={confirmingCancel}
					pending={pendingActions.has(`${confirmingCancel.id}-cancel`)}
					onClose={() => setConfirmingCancel(null)}
					onConfirm={async () => {
						const id = confirmingCancel.id;
						setConfirmingCancel(null);
						await handleAction(id, "cancel");
					}}
				/>
			)}
		</div>
	);
}

function CancelConfirm({
	will,
	pending,
	onClose,
	onConfirm,
}: {
	will: WillData;
	pending: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape" && !pending) onClose();
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [onClose, pending]);

	return (
		<div
			className="fixed inset-0 z-[90] flex items-center justify-center p-4 animate-fade-in"
			role="dialog"
			aria-modal="true"
			aria-labelledby="cancel-confirm-title"
		>
			<div
				className="absolute inset-0 bg-canvas/80 backdrop-blur-sm"
				onClick={() => !pending && onClose()}
			/>
			<div
				className="relative card-padded w-[min(92vw,440px)] shadow-lifted animate-slide-up"
				style={{ borderRadius: "4px" }}
			>
				<div className="eyebrow mb-1 text-danger">Destructive</div>
				<h3 id="cancel-confirm-title" className="h-page mb-3">
					Cancel this will?
				</h3>
				<p className="text-sm text-ink-500 mb-4">
					Cancelling removes the will from the scheduler. The bequests will
					not execute, and this cannot be undone.
				</p>
				<dl className="grid grid-cols-2 gap-3 mb-5 text-sm bg-muted border border-hairline p-3" style={{ borderRadius: "3px" }}>
					<div>
						<div className="eyebrow mb-0.5">Owner</div>
						<div className="font-mono text-xs truncate">
							{accountLabel(will.owner)}
						</div>
					</div>
					<div>
						<div className="eyebrow mb-0.5">Instructions</div>
						<div className="font-mono text-xs">{will.bequestCount}</div>
					</div>
				</dl>
				<div className="flex gap-2 justify-end">
					<button
						onClick={onClose}
						disabled={pending}
						className="btn-outline btn-sm"
					>
						Keep it
					</button>
					<button
						onClick={onConfirm}
						disabled={pending}
						className="btn-danger btn-sm"
					>
						{pending ? "Cancelling…" : "Confirm cancel"}
					</button>
				</div>
			</div>
		</div>
	);
}

function StatCard({
	label,
	value,
	tone,
}: {
	label: string;
	value: number;
	tone: "estate" | "brass" | "danger" | "neutral";
}) {
	const text =
		tone === "estate"
			? "text-neon-500"
			: tone === "brass"
				? "text-fuchsia-500"
				: tone === "danger"
					? "text-danger"
					: "text-ink-900";
	return (
		<div className="stat">
			<div className="stat-label">{label}</div>
			<div className={`stat-value ${text}`}>{value}</div>
		</div>
	);
}

function FilterPill({
	active,
	onClick,
	count,
	children,
}: {
	active: boolean;
	onClick: () => void;
	count?: number;
	children: React.ReactNode;
}) {
	return (
		<button
			onClick={onClick}
			className={`text-sm rounded-full px-3 py-1.5 flex items-center gap-1.5 transition-all border ${
				active
					? "bg-neon-500/10 text-neon-500 border-neon-500/40 shadow-[0_0_12px_rgba(0,255,179,0.15)]"
					: "bg-muted text-ink-700 border-hairline hover:bg-mist hover:border-rule"
			}`}
		>
			<span>{children}</span>
			{count !== undefined && (
				<span
					className={`text-[0.7rem] rounded-full px-1.5 py-0.5 tabular font-mono ${
						active
							? "bg-neon-500/20 text-neon-500"
							: "bg-canvas text-ink-500"
					}`}
				>
					{count}
				</span>
			)}
		</button>
	);
}

function WillRow({
	w,
	blockNumber,
	currentAccount,
	isInheritance,
	onAction,
	onRequestCancel,
	pendingActions,
}: {
	w: WillData;
	blockNumber: number;
	currentAccount: string;
	isInheritance: boolean;
	onAction: (id: bigint, action: "heartbeat" | "cancel") => void;
	onRequestCancel: (will: WillData) => void;
	pendingActions: Set<string>;
}) {
	const [expanded, setExpanded] = useState(false);
	const isOwner = sameAccount(w.owner, currentAccount);
	const isActive = w.status === "Active";
	const isExpired = isActive && blockNumber > w.expiryBlock;
	const blocksLeft = isActive ? w.expiryBlock - blockNumber : 0;
	const blockTime = useChainStore((s) => s.blockTime);
	const secondsLeft = Math.max(0, blocksLeft * blockTime);

	const ownerLabel = accountLabel(w.owner);
	const allRecipients = Array.from(new Set(w.bequests.flatMap(recipientsOf)));

	const rowClass = isExpired
		? "row-accent row-accent-danger"
		: isInheritance && isActive
			? "row-accent row-accent-brass"
			: isOwner && isActive
				? "row-accent"
				: "row";

	let chip: React.ReactNode;
	if (w.status === "Executed") {
		chip = (
			<span className="chip-brass">
				<span className="dot" /> Executed
			</span>
		);
	} else if (isExpired) {
		chip = (
			<span className="chip-danger">
				<span className="dot" /> Expired
			</span>
		);
	} else {
		chip = (
			<span className="chip-positive">
				<span className="dot" /> Active
			</span>
		);
	}

	return (
		<article className={rowClass}>
			<button
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				aria-label={`${expanded ? "Collapse" : "Expand"} will by ${ownerLabel}, ${w.bequestCount} ${w.bequestCount === 1 ? "instruction" : "instructions"}`}
				className="w-full text-left flex items-center gap-4"
			>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2.5 mb-1 flex-wrap">
						{chip}
						{isInheritance && (
							<span className="chip-brass">Names you</span>
						)}
						{isOwner && isActive && (
							<span className="chip-estate">Yours</span>
						)}
					</div>
					<h3 className="h-card leading-tight truncate">
						{isOwner ? (
							<>Your will · {w.bequestCount} {w.bequestCount === 1 ? "instruction" : "instructions"}</>
						) : (
							<>
								{ownerLabel} · {w.bequestCount}{" "}
								{w.bequestCount === 1 ? "instruction" : "instructions"}
							</>
						)}
					</h3>
					{allRecipients.length > 0 && (
						<p className="text-sm text-ink-500 mt-1 truncate">
							To: {allRecipients.map(accountLabel).join(", ")}
						</p>
					)}
				</div>

				<div className="hidden md:flex flex-col items-end text-right">
					<div className="eyebrow mb-0.5">
						{w.status === "Executed" ? "Fired at" : isExpired ? "Status" : "Countdown"}
					</div>
					{w.status === "Executed" ? (
						<span className="font-mono text-sm tabular">
							№{w.executedBlock.toLocaleString()}
						</span>
					) : isExpired ? (
						<span className="text-sm font-medium text-danger">
							Awaiting scheduler
						</span>
					) : (
						<div>
							<span
								className={`font-semibold tabular ${blocksLeft < 10 ? "text-danger" : "text-ink-900"}`}
							>
								{formatDuration(secondsLeft)}
							</span>
							<div className="text-xs text-ink-500 tabular">
								{blocksLeft} blk
							</div>
						</div>
					)}
				</div>

				<span className="text-ink-400 text-sm ml-2">
					{expanded ? "▴" : "▾"}
				</span>
			</button>

			{expanded && (
				<div className="mt-4 pt-4 border-t border-hairline space-y-4 animate-slide-up">
					<dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
						<Field label="Owner" mono>
							{ownerLabel}
						</Field>
						<Field label="Expiry" mono>
							№{w.expiryBlock.toLocaleString()}
						</Field>
						<Field label="Interval">
							{w.blockInterval} blocks
						</Field>
						<Field label="Will id" mono>
							{Number(w.id)}
						</Field>
					</dl>

					{w.bequests.length > 0 && (
						<div>
							<div className="eyebrow mb-2">Instructions</div>
							<ol className="space-y-2">
								{w.bequests.map((bequest, i) => (
									<li
										key={i}
										className="flex gap-3 p-3 rounded-xl bg-muted"
									>
										<span className="font-mono text-xs text-ink-400 tabular pt-0.5">
											{String(i + 1).padStart(2, "0")}
										</span>
										<span className="text-sm">{renderBequest(bequest)}</span>
									</li>
								))}
							</ol>
						</div>
					)}

					{isActive && isOwner && (
						<div className="flex flex-wrap gap-2 pt-2">
							{!isExpired && (
								<button
									onClick={() => onAction(w.id, "heartbeat")}
									disabled={pendingActions.has(`${w.id}-heartbeat`)}
									className="btn-accent btn-sm"
								>
									{pendingActions.has(`${w.id}-heartbeat`)
										? "♥ Sending…"
										: "♥ Heartbeat"}
								</button>
							)}
							<button
								onClick={() => onRequestCancel(w)}
								disabled={pendingActions.has(`${w.id}-cancel`)}
								className="btn-danger btn-sm"
							>
								{pendingActions.has(`${w.id}-cancel`)
									? "Cancelling…"
									: "Cancel"}
							</button>
						</div>
					)}
				</div>
			)}
		</article>
	);
}

function Field({
	label,
	mono,
	children,
}: {
	label: string;
	mono?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div className="eyebrow mb-0.5">{label}</div>
			<div
				className={`${mono ? "font-mono tabular text-[0.85rem]" : ""} text-ink-900 truncate`}
			>
				{children}
			</div>
		</div>
	);
}
