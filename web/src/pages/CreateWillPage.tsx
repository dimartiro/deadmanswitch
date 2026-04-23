import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import { useAllAccounts } from "../hooks/useAllAccounts";
import {
	getClient,
	getPeopleChainClient,
	getAssetHubClient,
} from "../hooks/useChain";
import {
	stack_template,
	people_chain,
	asset_hub,
} from "@polkadot-api/descriptors";
import { formatDuration } from "../utils/format";
import { submitAndWait } from "../utils/tx";
import { ss58Address, ss58Decode } from "@polkadot-labs/hdkd-helpers";
import { Dropdown } from "../components/Dropdown";
import { toast } from "../store/toastStore";

// Mirrors the pallet-side limits in pallets/estate-executor so the UI
// rejects the same shapes the runtime would: MaxMultisigDelegates is 10,
// and the pallet requires >= 2 delegates + threshold in [1, delegates.len()].
const MAX_MULTISIG_DELEGATES = 10;
const MIN_MULTISIG_DELEGATES = 2;

function isValidSs58(addr: string): boolean {
	if (!addr) return false;
	try {
		ss58Decode(addr);
		return true;
	} catch {
		return false;
	}
}

function validateEntry(e: Entry): string | null {
	switch (e.kind) {
		case "Transfer": {
			if (!e.dest) return "Pick a beneficiary.";
			if (!isValidSs58(e.dest)) return "Beneficiary address is not a valid SS58 address.";
			const n = parseFloat(e.amount || "0");
			if (!(n > 0)) return "Amount must be greater than zero.";
			return null;
		}
		case "TransferAll":
			if (!e.dest) return "Pick a beneficiary.";
			if (!isValidSs58(e.dest)) return "Beneficiary address is not a valid SS58 address.";
			return null;
		case "Proxy":
			if (!e.dest) return "Pick a delegate.";
			if (!isValidSs58(e.dest)) return "Delegate address is not a valid SS58 address.";
			return null;
		case "MultisigProxy": {
			if (e.delegates.length < MIN_MULTISIG_DELEGATES)
				return `A multisig needs at least ${MIN_MULTISIG_DELEGATES} delegates.`;
			if (e.delegates.length > MAX_MULTISIG_DELEGATES)
				return `A multisig allows at most ${MAX_MULTISIG_DELEGATES} delegates.`;
			const bad = e.delegates.find((d) => !isValidSs58(d));
			if (bad) return "One of the delegate addresses is invalid.";
			const t = parseInt(e.threshold || "0");
			if (!(t >= 1)) return "Threshold must be at least 1.";
			if (t > e.delegates.length)
				return "Threshold can't exceed the number of delegates.";
			return null;
		}
	}
}

const ESTATE_SOVEREIGN_ON_ASSETHUB = (() => {
	const buf = new Uint8Array(32);
	buf.set(new TextEncoder().encode("sibl"), 0);
	new DataView(buf.buffer).setUint32(4, 2000, true);
	return ss58Address(buf);
})();

type PatternKind = "Transfer" | "TransferAll" | "Proxy" | "MultisigProxy";

interface Entry {
	id: number;
	kind: PatternKind;
	dest: string;
	amount: string;
	delegates: string[];
	threshold: string;
}

let nextEntryId = 0;

function newEntry(): Entry {
	return {
		id: nextEntryId++,
		kind: "TransferAll",
		dest: "",
		amount: "",
		delegates: [],
		threshold: "2",
	};
}

const PATTERN_META: Record<
	PatternKind,
	{ label: string; description: string; emoji: string }
> = {
	Transfer: {
		label: "Transfer",
		description: "Send a fixed amount of ROC from Asset Hub",
		emoji: "↗",
	},
	TransferAll: {
		label: "Transfer all",
		description: "Send the entire Asset Hub balance",
		emoji: "⇉",
	},
	Proxy: {
		label: "Grant proxy",
		description: "Grant full proxy over your Asset Hub account",
		emoji: "🗝",
	},
	MultisigProxy: {
		label: "Grant multisig proxy",
		description: "M-of-N multisig gains full proxy",
		emoji: "⛨",
	},
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildBequest(entry: Entry): any {
	switch (entry.kind) {
		case "Transfer":
			return {
				type: "Transfer",
				value: {
					dest: entry.dest,
					amount: BigInt(Math.floor(parseFloat(entry.amount || "0") * 1e12)),
				},
			};
		case "TransferAll":
			return { type: "TransferAll", value: { dest: entry.dest } };
		case "Proxy":
			return { type: "Proxy", value: { delegate: entry.dest } };
		case "MultisigProxy":
			return {
				type: "MultisigProxy",
				value: {
					delegates: entry.delegates,
					threshold: parseInt(entry.threshold || "2"),
				},
			};
	}
}

function IdentityChip({ verified }: { verified: boolean }) {
	return verified ? (
		<span className="chip-positive">
			<span className="dot" /> verified
		</span>
	) : (
		<span className="chip-danger">
			<span className="dot" /> unverified
		</span>
	);
}

function AccountSelect({
	value,
	onChange,
	label,
	placeholder,
	verified,
	excludeAddress,
}: {
	value: string;
	onChange: (v: string) => void;
	label?: string;
	placeholder?: string;
	verified?: boolean;
	excludeAddress?: string;
}) {
	const walletAccounts = useChainStore((s) => s.walletAccounts);
	const known = [
		...devAccounts.map((a) => ({ name: a.name, address: a.address })),
		...walletAccounts.map((a) => ({
			name: `${a.name} (${a.source})`,
			address: a.address,
		})),
	].filter((a) => a.address !== excludeAddress);
	const isKnown = known.some((a) => a.address === value);
	const isCustom = value !== "" && !isKnown;
	const [showCustom, setShowCustom] = useState(isCustom);

	const options = [
		...known.map((a) => ({
			value: a.address,
			label: a.name,
			hint: `${a.address.slice(0, 6)}…${a.address.slice(-4)}`,
		})),
		{ value: "__custom__", label: "By address…" },
	];

	return (
		<div>
			{label && (
				<div className="flex items-baseline justify-between mb-1.5">
					<label className="eyebrow">{label}</label>
					{value && verified !== undefined && (
						<IdentityChip verified={verified} />
					)}
				</div>
			)}
			<Dropdown
				value={showCustom ? "__custom__" : value}
				onChange={(v) => {
					if (v === "__custom__") {
						setShowCustom(true);
						onChange("");
					} else {
						setShowCustom(false);
						onChange(v);
					}
				}}
				options={options}
				placeholder="Select an account…"
			/>
			{showCustom && (
				<input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder || "5Grwva…"}
					className="input-mono mt-2"
				/>
			)}
		</div>
	);
}

function DelegatesInput({
	value,
	onChange,
	isVerified,
	excludeAddress,
}: {
	value: string[];
	onChange: (v: string[]) => void;
	isVerified: (addr: string) => boolean;
	excludeAddress?: string;
}) {
	const walletAccounts = useChainStore((s) => s.walletAccounts);
	const known = [
		...devAccounts.map((a) => ({ name: a.name, address: a.address })),
		...walletAccounts.map((a) => ({
			name: `${a.name} (${a.source})`,
			address: a.address,
		})),
	].filter((a) => a.address !== excludeAddress);

	function add(addr: string) {
		if (!addr || value.includes(addr)) return;
		onChange([...value, addr]);
	}
	function remove(idx: number) {
		onChange(value.filter((_, i) => i !== idx));
	}

	return (
		<div className="space-y-2">
			{value.map((addr, i) => {
				const k = known.find((a) => a.address === addr);
				return (
					<div
						key={i}
						className="flex items-center justify-between gap-3 rounded-xl bg-muted border border-hairline px-3 py-2"
					>
						<span className="text-sm font-medium">
							{k ? k.name : `${addr.slice(0, 8)}…${addr.slice(-6)}`}
						</span>
						<div className="flex items-center gap-2">
							<IdentityChip verified={isVerified(addr)} />
							<button onClick={() => remove(i)} className="btn-ghost btn-sm">
								Remove
							</button>
						</div>
					</div>
				);
			})}
			<Dropdown
				value=""
				onChange={(v) => add(v)}
				placeholder="Add a delegate…"
				options={known
					.filter((a) => !value.includes(a.address))
					.map((acc) => ({
						value: acc.address,
						label: acc.name,
						hint: `${acc.address.slice(0, 6)}…${acc.address.slice(-4)}`,
					}))}
			/>
		</div>
	);
}

export default function CreateWillPage() {
	const {
		wsUrl,
		connected,
		selectedAccount,
		blockNumber,
		peopleChainAvailable,
		assetHubAvailable,
	} = useChainStore();
	const bypassIdentity = peopleChainAvailable === false;
	const showAssetHub = assetHubAvailable === true;
	const { accounts, selected } = useAllAccounts();
	const [intervalAmount, setIntervalAmount] = useState("20");
	const [intervalUnit, setIntervalUnit] = useState<
		"s" | "min" | "h" | "d" | "w" | "mo" | "y"
	>("s");
	const [entries, setEntries] = useState<Entry[]>([newEntry()]);
	const [submitting, setSubmitting] = useState(false);
	const [ownerAhBalance, setOwnerAhBalance] = useState<number>(0);
	const [ownerAhLinked, setOwnerAhLinked] = useState<boolean>(false);
	const [verified, setVerified] = useState<Record<string, boolean>>({});
	const navigate = useNavigate();

	const fetchAhBalance = useCallback(async () => {
		if (!selected || !showAssetHub) {
			setOwnerAhBalance(0);
			setOwnerAhLinked(false);
			return;
		}
		try {
			const client = getAssetHubClient();
			const api = client.getTypedApi(asset_hub);
			const [info, proxies] = await Promise.all([
				api.query.System.Account.getValue(selected.address, { at: "best" }),
				api.query.Proxy.Proxies.getValue(selected.address, { at: "best" }),
			]);
			setOwnerAhBalance(Number(info.data.free) / 1e12);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const [delegates] = proxies as any;
			setOwnerAhLinked(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(delegates as any[]).some(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(d: any) => d.delegate === ESTATE_SOVEREIGN_ON_ASSETHUB,
				),
			);
		} catch {
			setOwnerAhBalance(0);
			setOwnerAhLinked(false);
		}
	}, [selected?.address, showAssetHub]);

	useEffect(() => {
		fetchAhBalance();
	}, [fetchAhBalance, blockNumber]);

	const allRecipients = Array.from(
		new Set(
			entries.flatMap((e) => {
				if (e.kind === "MultisigProxy") return e.delegates;
				return e.dest ? [e.dest] : [];
			}),
		),
	);

	useEffect(() => {
		if (allRecipients.length === 0) return;
		if (bypassIdentity) return;
		let cancelled = false;
		(async () => {
			try {
				const peopleClient = getPeopleChainClient();
				const peopleApi = peopleClient.getTypedApi(people_chain);
				const results = await Promise.all(
					allRecipients.map(async (addr) => {
						try {
							const info = await peopleApi.query.Identity.IdentityOf.getValue(
								addr,
								{ at: "best" },
							);
							return [addr, info !== undefined] as const;
						} catch {
							return [addr, false] as const;
						}
					}),
				);
				if (!cancelled) {
					setVerified(Object.fromEntries(results));
				}
			} catch {
				/* people chain unreachable */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [allRecipients.join(","), blockNumber, bypassIdentity]);

	function isVerified(addr: string): boolean {
		if (bypassIdentity) return true;
		return !!verified[addr];
	}

	const allRecipientsVerified = allRecipients.every(isVerified);
	const hasRecipients = allRecipients.length > 0;

	function updateEntry(id: number, update: Partial<Entry>) {
		setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...update } : e)));
	}
	function removeEntry(id: number) {
		if (entries.length <= 1) return;
		setEntries((prev) => prev.filter((e) => e.id !== id));
	}

	async function handleSubmit() {
		if (!connected) {
			toast.error("Not connected", "Open the connection panel and dial a node.");
			return;
		}
		setSubmitting(true);
		try {
			if (!selected) throw new Error("No account selected");
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const signer = selected.signer;
			const bequests = entries.map(buildBequest);
			const tx = api.tx.EstateExecutor.create_will({
				bequests,
				block_interval: blockInterval,
			});
			const result = await submitAndWait(tx, signer, client);
			if (result.ok) {
				const blockNum = result.block?.number;
				toast.success(
					"Will registered",
					blockNum !== undefined ? `Sealed in block №${blockNum}` : undefined,
				);
				setEntries([newEntry()]);
				setTimeout(() => navigate("/dashboard"), 800);
			} else {
				toast.error("Registration failed", result.errorMessage ?? "unknown");
			}
		} catch (e) {
			console.error("Create will failed:", e);
			toast.error(
				"Registration failed",
				e instanceof Error ? e.message : String(e),
			);
		} finally {
			setSubmitting(false);
		}
	}

	const blockTime = useChainStore((s) => s.blockTime);
	const UNIT_SECONDS: Record<typeof intervalUnit, number> = {
		s: 1,
		min: 60,
		h: 3600,
		d: 86400,
		w: 604800,
		mo: 2592000,
		y: 31536000,
	};
	const estimatedTime = Math.max(
		0,
		Math.round(parseFloat(intervalAmount || "0") * UNIT_SECONDS[intervalUnit]),
	);
	const blockInterval = Math.max(1, Math.round(estimatedTime / blockTime));
	const entryErrors = entries.map(validateEntry);
	const allEntriesValid = entryErrors.every((e) => e === null);
	const canSubmit =
		!submitting &&
		connected &&
		hasRecipients &&
		allRecipientsVerified &&
		allEntriesValid &&
		(!showAssetHub || ownerAhLinked);

	return (
		<div className="space-y-6 stagger">
			{/* Page header */}
			<div>
				<div className="eyebrow mb-1">Draft</div>
				<h1 className="h-display text-4xl md:text-5xl">
					Compose a <span className="italic text-neon-500">will</span>
				</h1>
				<p className="text-sm text-ink-500 mt-2 max-w-xl">
					Pick an owner, a heartbeat interval, and one or more instructions.
					Silence longer than the interval fires the will automatically.
				</p>
			</div>

			{/* STEP 1 — Owner */}
			<Panel
				step="01"
				title="Sign as"
				description="Whichever account signs will be the will's owner and the only one who can heartbeat or cancel."
			>
				<div className="flex flex-wrap gap-2">
					{accounts.map((acc, i) => (
						<button
							key={acc.address}
							onClick={() =>
								useChainStore.getState().setSelectedAccount(i)
							}
							className={`text-sm px-4 py-2 rounded-full transition-all ${
								selectedAccount === i
									? "bg-ink-900 text-canvas shadow-soft"
									: "bg-muted text-ink-700 hover:bg-mist"
							}`}
						>
							{acc.name}
						</button>
					))}
				</div>
				{selected && (
					<div className="mt-3 grid md:grid-cols-2 gap-3">
						<Field label="Address" mono>
							{selected.address}
						</Field>
						{showAssetHub && (
							<Field label="Asset Hub balance">
								<span className="tabular font-medium">
									{ownerAhBalance.toFixed(4)} ROC
								</span>
							</Field>
						)}
					</div>
				)}
			</Panel>

			{/* STEP 2 — Heartbeat */}
			<Panel
				step="02"
				title="Heartbeat interval"
				description="Length of silence after which the will executes. Send a heartbeat any time to reset."
				variant="heartbeat"
			>
				<div className="grid md:grid-cols-2 gap-6 items-start">
					<div>
						<label className="eyebrow mb-1.5 block">Duration</label>
						<div className="flex items-stretch gap-2 mb-3">
							<input
								type="number"
								min="1"
								step="1"
								value={intervalAmount}
								onChange={(e) => setIntervalAmount(e.target.value)}
								className="input-mono w-28"
							/>
							<Dropdown
								className="flex-1"
								value={intervalUnit}
								onChange={(v) => setIntervalUnit(v as typeof intervalUnit)}
								options={[
									{ value: "s", label: "seconds" },
									{ value: "min", label: "minutes" },
									{ value: "h", label: "hours" },
									{ value: "d", label: "days" },
									{ value: "w", label: "weeks" },
									{ value: "mo", label: "months" },
									{ value: "y", label: "years" },
								]}
							/>
						</div>
						<div className="flex flex-wrap gap-1.5">
							{[
								{ label: "1h", amount: "1", unit: "h" as const },
								{ label: "1d", amount: "1", unit: "d" as const },
								{ label: "1w", amount: "1", unit: "w" as const },
								{ label: "1mo", amount: "1", unit: "mo" as const },
								{ label: "1y", amount: "1", unit: "y" as const },
							].map((p) => {
								const active =
									intervalAmount === p.amount && intervalUnit === p.unit;
								return (
									<button
										key={p.label}
										onClick={() => {
											setIntervalAmount(p.amount);
											setIntervalUnit(p.unit);
										}}
										className={`btn-outline btn-sm ${active ? "text-neon-500 border-neon-500/40 bg-neon-500/5" : ""}`}
										type="button"
									>
										{p.label}
									</button>
								);
							})}
						</div>
					</div>
					<div className="rounded-2xl p-5 bg-neon-500/5 border border-neon-500/20">
						<div className="eyebrow text-neon-500 mb-1">Time to execution</div>
						<div className="h-display text-4xl text-neon-500">
							{formatDuration(estimatedTime)}
						</div>
						<p className="text-xs text-neon-500/70 mt-2 font-mono">
							= {blockInterval.toLocaleString()} blocks · at {blockTime}s/block
						</p>
					</div>
				</div>
			</Panel>

			{/* STEP 3 — Instructions */}
			<Panel
				step="03"
				title="Instructions"
				description="Actions that will run on Asset Hub as your proxy. Multiple instructions are dispatched in order."
				variant="instructions"
				action={
					<button
						onClick={() => setEntries([...entries, newEntry()])}
						className="btn-outline btn-sm"
					>
						+ Add instruction
					</button>
				}
			>
				<div className="space-y-4">
					{entries.map((entry, idx) => {
						const entryError = entryErrors[idx];
						return (
						<div
							key={entry.id}
							className="card-muted p-5"
						>
							<div className="flex items-center justify-between mb-4">
								<div className="flex items-center gap-2">
									<span className="font-mono text-xs text-ink-400 tabular">
										{String(idx + 1).padStart(2, "0")}
									</span>
									<span className="text-xs text-ink-500">
										{PATTERN_META[entry.kind].description}
									</span>
								</div>
								{entries.length > 1 && (
									<button
										onClick={() => removeEntry(entry.id)}
										className="btn-ghost btn-sm"
									>
										Remove
									</button>
								)}
							</div>

							{/* Pattern picker — segmented buttons */}
							<div className="flex gap-1 flex-wrap mb-4 p-1 rounded-full bg-paper border border-hairline w-fit">
								{(Object.keys(PATTERN_META) as PatternKind[]).map((k) => (
									<button
										key={k}
										onClick={() => updateEntry(entry.id, { kind: k })}
										className={`text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-all ${
											entry.kind === k
												? "bg-neon-500 text-canvas"
												: "text-ink-500 hover:text-ink-900"
										}`}
									>
										<span>{PATTERN_META[k].emoji}</span>
										{PATTERN_META[k].label}
									</button>
								))}
							</div>

							<div className="space-y-4">
								{entry.kind === "Transfer" && (
									<>
										<AccountSelect
											label="Beneficiary"
											value={entry.dest}
											onChange={(v) => updateEntry(entry.id, { dest: v })}
											verified={entry.dest ? isVerified(entry.dest) : undefined}
											excludeAddress={selected?.address}
										/>
										<div>
											<div className="flex items-baseline justify-between mb-1.5">
												<label className="eyebrow">Amount (ROC)</label>
												<span className="text-xs text-ink-500">
													balance{" "}
													<span className="font-mono tabular">
														{ownerAhBalance.toFixed(4)}
													</span>
												</span>
											</div>
											<div className="flex gap-2">
												<input
													type="number"
													min="0"
													max={ownerAhBalance}
													value={entry.amount}
													onChange={(e) =>
														updateEntry(entry.id, {
															amount: String(
																Math.min(
																	parseFloat(e.target.value) || 0,
																	ownerAhBalance,
																),
															),
														})
													}
													placeholder="1"
													className="input-mono flex-1"
												/>
												<button
													onClick={() =>
														updateEntry(entry.id, {
															amount: String(ownerAhBalance),
														})
													}
													className="btn-outline btn-sm"
												>
													Max
												</button>
											</div>
										</div>
									</>
								)}

								{entry.kind === "TransferAll" && (
									<AccountSelect
										label="Beneficiary"
										value={entry.dest}
										onChange={(v) => updateEntry(entry.id, { dest: v })}
										verified={entry.dest ? isVerified(entry.dest) : undefined}
										excludeAddress={selected?.address}
									/>
								)}

								{entry.kind === "Proxy" && (
									<>
										<AccountSelect
											label="Delegate"
											value={entry.dest}
											onChange={(v) => updateEntry(entry.id, { dest: v })}
											verified={entry.dest ? isVerified(entry.dest) : undefined}
											excludeAddress={selected?.address}
										/>
										<p className="text-xs text-ink-500 leading-relaxed">
											From the moment of execution, this account may act as you
											on Asset Hub — any call type, unrestricted.
										</p>
									</>
								)}

								{entry.kind === "MultisigProxy" && (
									<>
										<div>
											<label className="eyebrow mb-1.5 block">Delegates</label>
											<DelegatesInput
												value={entry.delegates}
												onChange={(v) =>
													updateEntry(entry.id, { delegates: v })
												}
												isVerified={isVerified}
												excludeAddress={selected?.address}
											/>
											{entry.delegates.length < 2 && (
												<p className="text-xs text-caution mt-1">
													A multisig needs at least two delegates.
												</p>
											)}
										</div>
										<div>
											<label className="eyebrow mb-1.5 block">Threshold</label>
											<div className="flex items-center gap-2">
												<input
													type="number"
													min="1"
													max={entry.delegates.length || 2}
													value={entry.threshold}
													onChange={(e) =>
														updateEntry(entry.id, {
															threshold: e.target.value,
														})
													}
													className="input-mono w-20"
												/>
												<span className="text-sm text-ink-500">
													of {entry.delegates.length || "…"} delegates must sign
												</span>
											</div>
										</div>
									</>
								)}
							</div>

							{entryError && (
								<p className="text-xs text-danger mt-3 flex items-start gap-1.5">
									<span className="shrink-0">⚠</span>
									<span>{entryError}</span>
								</p>
							)}
						</div>
						);
					})}
				</div>
			</Panel>

			{/* Submit */}
			<section className="card-padded bg-neon-50/30 border-neon-500/20">
				<div className="flex items-start justify-between flex-wrap gap-4">
					<div className="flex-1 min-w-[260px]">
						<div className="eyebrow text-neon-500 mb-1">Review & sign</div>
						<h3 className="h-page">Ready to register?</h3>
						<p className="text-sm text-ink-500 mt-1 max-w-lg">
							Execution is scheduled at creation — no keeper required.
						</p>
						{bypassIdentity && (
							<p className="text-xs text-caution mt-3">
								⚠ Identities are bypassed — People Chain unreachable, so
								beneficiaries are not verified.
							</p>
						)}
						{!bypassIdentity && hasRecipients && !allRecipientsVerified && (
							<p className="text-xs text-danger mt-3">
								⚠ At least one beneficiary lacks identity. Register them in{" "}
								<a href="#/accounts" className="underline">
									Accounts
								</a>
								.
							</p>
						)}
						{showAssetHub && !ownerAhLinked && (
							<p className="text-xs text-danger mt-3">
								⚠ Your account isn't linked to Asset Hub. Link it in{" "}
								<a href="#/accounts" className="underline">
									Accounts
								</a>{" "}
								first.
							</p>
						)}
					</div>
					<div className="flex flex-col items-end gap-2">
						<button
							onClick={handleSubmit}
							disabled={!canSubmit}
							className="btn-accent"
						>
							{submitting ? "Sealing…" : "Sign & register"}
						</button>
					</div>
				</div>
			</section>
		</div>
	);
}

function Panel({
	step,
	title,
	description,
	children,
	action,
	variant,
}: {
	step: string;
	title: string;
	description: string;
	children: React.ReactNode;
	action?: React.ReactNode;
	variant?: "heartbeat" | "instructions";
}) {
	const accent =
		variant === "heartbeat"
			? "border-neon-500/20 bg-gradient-to-br from-paper to-neon-500/5/40"
			: variant === "instructions"
				? "border-fuchsia-500/20 bg-gradient-to-br from-paper to-fuchsia-500/5/30"
				: "";
	return (
		<section className={`card-padded ${accent}`}>
			<div className="flex items-start justify-between gap-4 flex-wrap mb-5">
				<div className="flex items-start gap-4">
					<div className="flex flex-col items-center justify-center w-10 h-10 rounded-full bg-ink-900 text-canvas shrink-0">
						<span className="font-mono text-xs tabular">{step}</span>
					</div>
					<div>
						<h2 className="h-section">{title}</h2>
						<p className="text-sm text-ink-500 mt-0.5 max-w-lg">
							{description}
						</p>
					</div>
				</div>
				{action}
			</div>
			{children}
		</section>
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
				className={`${mono ? "font-mono tabular text-[0.85rem]" : "text-sm"} text-ink-900 truncate`}
			>
				{children}
			</div>
		</div>
	);
}
