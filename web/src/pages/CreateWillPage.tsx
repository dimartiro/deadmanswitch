import { useState, useEffect, useCallback } from "react";
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
import { ss58Address } from "@polkadot-labs/hdkd-helpers";

// Sibling parachain sovereign derivation (mirrors
// `polkadot_parachain_primitives::primitives::Sibling`):
//   b"sibl" ++ u32_le(2000) ++ pad-to-32-bytes
const ESTATE_SOVEREIGN_ON_ASSETHUB = (() => {
	const buf = new Uint8Array(32);
	buf.set(new TextEncoder().encode("sibl"), 0);
	new DataView(buf.buffer).setUint32(4, 2000, true);
	return ss58Address(buf);
})();

type PatternKind =
	| "Transfer"
	| "TransferAll"
	| "Proxy"
	| "MultisigProxy";

interface Entry {
	id: number;
	kind: PatternKind;
	// Transfer / TransferAll / Proxy
	dest: string;
	// Transfer
	amount: string;
	// MultisigProxy
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
			return {
				type: "TransferAll",
				value: { dest: entry.dest },
			};
		case "Proxy":
			return {
				type: "Proxy",
				value: { delegate: entry.dest },
			};
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

function IdentityBadge({ verified }: { verified: boolean }) {
	return verified ? (
		<span className="status-badge bg-accent-green/10 text-accent-green border border-accent-green/20">
			✓ verified
		</span>
	) : (
		<span className="status-badge bg-accent-red/10 text-accent-red border border-accent-red/20">
			✗ no identity
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

	return (
		<div>
			{label && (
				<div className="flex items-center justify-between mb-1">
					<label className="label">{label}</label>
					{value && verified !== undefined && (
						<IdentityBadge verified={verified} />
					)}
				</div>
			)}
			<select
				value={showCustom ? "__custom__" : value}
				onChange={(e) => {
					const v = e.target.value;
					if (v === "__custom__") {
						setShowCustom(true);
						onChange("");
					} else {
						setShowCustom(false);
						onChange(v);
					}
				}}
				className="input-field w-full mb-2"
			>
				<option value="" disabled>
					Select account...
				</option>
				{known.map((acc) => (
					<option key={acc.address} value={acc.address}>
						{acc.name}
					</option>
				))}
				<option value="__custom__">Custom address...</option>
			</select>
			{showCustom && (
				<input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder || "5Grwva..."}
					className="input-field w-full"
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
						className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5"
					>
						<span className="text-sm text-text-primary flex-1">
							{k ? k.name : `${addr.slice(0, 8)}...${addr.slice(-6)}`}
						</span>
						<IdentityBadge verified={isVerified(addr)} />
						<button
							onClick={() => remove(i)}
							className="text-xs text-accent-red hover:text-accent-red/80"
						>
							Remove
						</button>
					</div>
				);
			})}
			<select
				value=""
				onChange={(e) => add(e.target.value)}
				className="input-field w-full"
			>
				<option value="">Add delegate...</option>
				{known
					.filter((a) => !value.includes(a.address))
					.map((acc) => (
						<option key={acc.address} value={acc.address}>
							{acc.name}
						</option>
					))}
			</select>
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
	// Solo-node dev mode (no relay, no People Chain). Identity checks
	// are bypassed so create-will isn't gated on a registry that doesn't
	// exist in this topology.
	const bypassIdentity = peopleChainAvailable === false;
	const showAssetHub = assetHubAvailable === true;
	const { accounts, selected } = useAllAccounts();
	const [blockInterval, setBlockInterval] = useState("5");
	const [entries, setEntries] = useState<Entry[]>([newEntry()]);
	const [status, setStatus] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [ownerAhBalance, setOwnerAhBalance] = useState<number>(0);
	const [ownerAhLinked, setOwnerAhLinked] = useState<boolean>(false);
	const [verified, setVerified] = useState<Record<string, boolean>>({});

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

	// Collect every beneficiary address across all entries and query
	// pallet-identity for each. The result drives the per-row badges and
	// the "can submit?" gate.
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
		// Identity is queried from People Chain, not our own chain —
		// Estate Protocol doesn't host pallet-identity anymore.
		(async () => {
			try {
				const peopleClient = getPeopleChainClient();
				const peopleApi = peopleClient.getTypedApi(people_chain);
				const results = await Promise.all(
					allRecipients.map(async (addr) => {
						try {
							const info = await peopleApi.query.Identity.IdentityOf.getValue(addr, { at: "best" });
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
				// Ignore — if People Chain is unreachable, badges will read
				// "no identity" and submit stays blocked.
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
		setEntries((prev) =>
			prev.map((e) => (e.id === id ? { ...e, ...update } : e)),
		);
	}

	function removeEntry(id: number) {
		if (entries.length <= 1) return;
		setEntries((prev) => prev.filter((e) => e.id !== id));
	}

	async function handleSubmit() {
		if (!connected) {
			setStatus("Error: Not connected to chain");
			return;
		}
		setSubmitting(true);
		setStatus("Submitting...");
		try {
			if (!selected) throw new Error("No account selected");
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const signer = selected.signer;

			const bequests = entries.map(buildBequest);
			const tx = api.tx.EstateExecutor.create_will({
				bequests,
				block_interval: parseInt(blockInterval),
			});
			const result = await submitAndWait(tx, signer, client);
			if (result.ok) {
				setStatus(
					`Will registered in block #${result.block?.number ?? "?"}`,
				);
				setEntries([newEntry()]);
			} else {
				setStatus(`Error: ${result.errorMessage ?? "unknown"}`);
			}
		} catch (e) {
			console.error("Create will failed:", e);
			setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setSubmitting(false);
		}
	}

	const blockTime = useChainStore((s) => s.blockTime);
	const estimatedTime = Math.round((parseInt(blockInterval) || 0) * blockTime);

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title">Register a Will</h1>
				<p className="text-text-secondary">
					Declare how your estate is distributed if you stop sending heartbeats.
				</p>
			</div>

			{/* Owner */}
			<div className="card space-y-3">
				<h2 className="section-title">Owner Account</h2>
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

			{/* Settings */}
			<div className="card space-y-4">
				<h2 className="section-title">Settings</h2>
				<div>
					<label className="label">Heartbeat Interval (blocks)</label>
					<input
						type="number"
						value={blockInterval}
						onChange={(e) => setBlockInterval(e.target.value)}
						placeholder="100"
						className="input-field w-full md:w-64"
					/>
					<p className="text-xs text-text-muted mt-1">
						~{formatDuration(estimatedTime)} at {blockTime}s/block. After
						this many blocks without a heartbeat, the will auto-executes.
					</p>
				</div>
			</div>

			{/* Bequests */}
			<div className="card space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="section-title">Bequests</h2>
					<button
						onClick={() => setEntries([...entries, newEntry()])}
						className="btn-secondary text-xs"
					>
						+ add bequest
					</button>
				</div>
				<div className="space-y-3">
					{entries.map((entry, idx) => (
						<div
							key={entry.id}
							className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 space-y-3"
						>
							<div className="flex items-center justify-between">
								<span className="text-sm font-medium text-text-primary">
									#{idx + 1}
								</span>
								{entries.length > 1 && (
									<button
										onClick={() => removeEntry(entry.id)}
										className="text-xs text-accent-red hover:text-accent-red/80"
									>
										Remove
									</button>
								)}
							</div>

							<div>
								<label className="label">Pattern</label>
								<select
									value={entry.kind}
									onChange={(e) =>
										updateEntry(entry.id, {
											kind: e.target.value as PatternKind,
										})
									}
									className="input-field w-full"
								>
									<option value="Transfer">Transfer fixed amount</option>
									<option value="TransferAll">Transfer everything</option>
									<option value="Proxy">Grant proxy access</option>
									<option value="MultisigProxy">
										Grant multisig proxy access
									</option>
								</select>
							</div>

							{entry.kind === "Transfer" && (
								<>
									<AccountSelect
										label="Beneficiary on Asset Hub"
										value={entry.dest}
										onChange={(v) => updateEntry(entry.id, { dest: v })}
										verified={
											entry.dest ? isVerified(entry.dest) : undefined
										}
										excludeAddress={selected?.address}
									/>
									<div>
										<label className="label">
											Amount (ROC) — max {ownerAhBalance.toFixed(4)}
										</label>
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
												className="input-field flex-1"
											/>
											<button
												type="button"
												onClick={() =>
													updateEntry(entry.id, {
														amount: String(ownerAhBalance),
													})
												}
												className="btn-secondary text-xs"
											>
												Max
											</button>
										</div>
									</div>
								</>
							)}

							{entry.kind === "TransferAll" && (
								<AccountSelect
									label="Beneficiary on Asset Hub"
									value={entry.dest}
									onChange={(v) => updateEntry(entry.id, { dest: v })}
									verified={entry.dest ? isVerified(entry.dest) : undefined}
									excludeAddress={selected?.address}
								/>
							)}

							{entry.kind === "Proxy" && (
								<>
									<AccountSelect
										label="Delegate on Asset Hub"
										value={entry.dest}
										onChange={(v) => updateEntry(entry.id, { dest: v })}
										verified={entry.dest ? isVerified(entry.dest) : undefined}
										excludeAddress={selected?.address}
									/>
									<p className="text-xs text-text-muted">
										This account gains unrestricted proxy access to your
										Asset Hub account when the will fires.
									</p>
								</>
							)}

							{entry.kind === "MultisigProxy" && (
								<>
									<div>
										<label className="label">Delegates on Asset Hub</label>
										<DelegatesInput
											value={entry.delegates}
											onChange={(v) =>
												updateEntry(entry.id, { delegates: v })
											}
											isVerified={isVerified}
											excludeAddress={selected?.address}
										/>
										{entry.delegates.length < 2 && (
											<p className="text-xs text-accent-yellow mt-1">
												Multisig Proxy needs at least 2 delegates.
											</p>
										)}
									</div>
									<div>
										<label className="label">Threshold</label>
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
											className="input-field w-32"
										/>
										<p className="text-xs text-text-muted mt-1">
											Number of delegates required to approve actions as
											the multisig.
										</p>
									</div>
								</>
							)}

							<p className="text-xs text-text-muted">
								Bequests execute against <em>your</em> Asset Hub account.
								Make sure it's linked via the Accounts tab before creating
								a will.
							</p>
						</div>
					))}
				</div>
			</div>

			{/* Submit */}
			<div className="card space-y-3">
				{bypassIdentity && (
					<p className="text-xs text-accent-yellow">
						Identities support disabled — People Chain is unreachable, so
						identity checks are bypassed.
					</p>
				)}
				{!bypassIdentity && hasRecipients && !allRecipientsVerified && (
					<p className="text-xs text-accent-red">
						All beneficiaries must have a registered on-chain identity
						before you can submit. Head to the Accounts page to register.
					</p>
				)}
				{showAssetHub && !ownerAhLinked && (
					<p className="text-xs text-accent-red">
						Your account isn't linked to Asset Hub. All bequests run there
						as your proxy, so you can't create a will without the link.
						Head to the Accounts page and click "Link to Asset Hub".
					</p>
				)}
				<button
					onClick={handleSubmit}
					disabled={
						submitting ||
						!connected ||
						!hasRecipients ||
						!allRecipientsVerified ||
						(showAssetHub && !ownerAhLinked)
					}
					className="btn-primary w-full py-3"
				>
					{submitting ? "Creating..." : "Create Will"}
				</button>
				{status && (
					<p
						className={`text-sm font-medium ${
							status.startsWith("Error")
								? "text-accent-red"
								: status.startsWith("Will registered")
									? "text-accent-green"
									: "text-accent-yellow"
						}`}
					>
						{status}
					</p>
				)}
			</div>
		</div>
	);
}
