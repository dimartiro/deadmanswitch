import { useState, useEffect, useCallback } from "react";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import { getClient } from "../hooks/useChain";
import { stack_template } from "@polkadot-api/descriptors";
import { formatDispatchError } from "../utils/format";
import { Binary } from "polkadot-api";
import { getSs58AddressInfo } from "@polkadot-api/substrate-bindings";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import { blake2b } from "blakejs";

const CUSTOM_VALUE = "__custom__";

function AccountSelect({
	value,
	onChange,
	label,
	placeholder,
}: {
	value: string;
	onChange: (v: string) => void;
	label: string;
	placeholder?: string;
}) {
	const isDevAccount = devAccounts.some((a) => a.address === value);
	const isCustom = value !== "" && !isDevAccount;
	const [showCustom, setShowCustom] = useState(isCustom);

	function handleSelect(e: React.ChangeEvent<HTMLSelectElement>) {
		const v = e.target.value;
		if (v === CUSTOM_VALUE) {
			setShowCustom(true);
			onChange("");
		} else {
			setShowCustom(false);
			onChange(v);
		}
	}

	return (
		<div>
			<label className="label">{label}</label>
			<select
				value={showCustom ? CUSTOM_VALUE : value}
				onChange={handleSelect}
				className="input-field w-full mb-2"
			>
				<option value="" disabled>
					Select account...
				</option>
				{devAccounts.map((acc) => (
					<option key={acc.address} value={acc.address}>
						{acc.name} ({acc.address.slice(0, 8)}...{acc.address.slice(-6)})
					</option>
				))}
				<option value={CUSTOM_VALUE}>Custom address...</option>
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

function deriveMultisigAccount(addresses: string[], threshold: number): string {
	const pubkeys = addresses.map((addr) => {
		const info = getSs58AddressInfo(addr);
		if (!info.isValid) throw new Error("Invalid address: " + addr);
		return info.publicKey;
	});
	pubkeys.sort((a, b) => {
		for (let i = 0; i < 32; i++) {
			if (a[i] !== b[i]) return a[i] - b[i];
		}
		return 0;
	});
	const buf = new Uint8Array(1 + pubkeys.length * 32 + 2);
	buf[0] = pubkeys.length * 4;
	let offset = 1;
	for (const pk of pubkeys) {
		buf.set(pk, offset);
		offset += 32;
	}
	buf[offset] = threshold & 0xff;
	buf[offset + 1] = (threshold >> 8) & 0xff;
	const hash = blake2b(buf, undefined, 32);
	return ss58Address(new Uint8Array(hash));
}

type CallType = "remark" | "transfer" | "transfer_all" | "add_proxy" | "multisig_proxy" | "multisig_transfer";

interface CallEntry {
	id: number;
	type: CallType;
	// remark
	message?: string;
	// transfer / transfer_all / add_proxy / remove_proxy
	dest?: string;
	// transfer
	amount?: string;
	// multisig_proxy / multisig_transfer
	signatories?: string;
	threshold?: string;
}

let nextCallId = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildRuntimeCall(api: any, entry: CallEntry) {
	switch (entry.type) {
		case "remark":
			return api.tx.System.remark({
				remark: Binary.fromText(entry.message || ""),
			});
		case "transfer":
			return api.tx.Balances.transfer_allow_death({
				dest: entry.dest || "",
				value: BigInt(Math.floor(parseFloat(entry.amount || "0") * 1e12)),
			});
		case "transfer_all":
			return api.tx.Balances.transfer_all({
				dest: entry.dest || "",
				keep_alive: false,
			});
		case "add_proxy":
			return api.tx.Proxy.add_proxy({
				delegate: entry.dest || "",
				proxy_type: { type: "Any", value: undefined },
				delay: 0,
			});
		case "multisig_proxy": {
			const sigList = (entry.signatories || "").split(",").map((s) => s.trim()).filter(Boolean);
			const threshold = parseInt(entry.threshold || "2");
			const multisigAddr = deriveMultisigAccount(sigList, threshold);
			return api.tx.Proxy.add_proxy({
				delegate: multisigAddr,
				proxy_type: { type: "Any", value: undefined },
				delay: 0,
			});
		}
		case "multisig_transfer": {
			const sigList = (entry.signatories || "").split(",").map((s) => s.trim()).filter(Boolean);
			const threshold = Math.max(2, parseInt(entry.threshold || "2"));
			const innerCall = api.tx.Balances.transfer_allow_death({
				dest: entry.dest || "",
				value: BigInt(Math.floor(parseFloat(entry.amount || "0") * 1e12)),
			});
			return api.tx.Multisig.as_multi({
				threshold,
				other_signatories: sigList,
				maybe_timepoint: undefined,
				call: innerCall.decodedCall,
				max_weight: { ref_time: 1_000_000_000n, proof_size: 100_000n },
			});
		}
		default:
			throw new Error(`Unknown call type: ${entry.type}`);
	}
}

export default function CreateSwitchPage() {
	const { wsUrl, connected, selectedAccount } = useChainStore();
	const [calls, setCalls] = useState<CallEntry[]>([
		{ id: nextCallId++, type: "remark", message: "" },
	]);
	const [blockInterval, setBlockInterval] = useState("100");
	const [triggerReward, setTriggerReward] = useState("1");
	const [status, setStatus] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [ownerBalance, setOwnerBalance] = useState<number>(0);

	const fetchBalance = useCallback(async () => {
		if (!connected) return;
		try {
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const addr = devAccounts[selectedAccount].address;
			const info = await api.query.System.Account.getValue(addr);
			setOwnerBalance(Number(info.data.free) / 1e12);
		} catch {
			setOwnerBalance(0);
		}
	}, [connected, wsUrl, selectedAccount]);

	useEffect(() => {
		fetchBalance();
	}, [fetchBalance]);

	function addCall(type: CallType) {
		setCalls([...calls, { id: nextCallId++, type }]);
	}

	function removeCall(id: number) {
		if (calls.length <= 1) return;
		setCalls(calls.filter((c) => c.id !== id));
	}

	function updateCall(id: number, update: Partial<CallEntry>) {
		setCalls(calls.map((c) => (c.id === id ? { ...c, ...update } : c)));
	}

	async function handleSubmit() {
		if (!connected) {
			setStatus("Error: Not connected to chain");
			return;
		}

		setSubmitting(true);
		setStatus("Submitting...");

		try {
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const signer = devAccounts[selectedAccount].signer;

			const runtimeCalls = calls.map((entry) => {
				const tx = buildRuntimeCall(api, entry);
				return tx.decodedCall;
			});

			const intervalBlocks = parseInt(blockInterval);
			const rewardPlanck = BigInt(
				Math.floor(parseFloat(triggerReward) * 1e12),
			);

			const tx = api.tx.DeadmanSwitchPallet.create_switch({
				calls: runtimeCalls,
				block_interval: intervalBlocks,
				trigger_reward: rewardPlanck,
			});

			const result = await tx.signAndSubmit(signer);

			if (result.ok) {
				setStatus(`Switch created in block #${result.block.number}`);
				// Reset form
				setCalls([{ id: nextCallId++, type: "remark", message: "" }]);
			} else {
				setStatus(`Error: ${formatDispatchError(result.dispatchError)}`);
			}
		} catch (e) {
			console.error("Create switch failed:", e);
			setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setSubmitting(false);
		}
	}

	const estimatedTime = Math.round((parseInt(blockInterval) || 0) * 6);
	const estimatedMinutes = Math.round(estimatedTime / 60);

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title">Create Switch</h1>
				<p className="text-text-secondary">
					Set up calls to execute if you stop sending heartbeats.
				</p>
			</div>

			{/* Account selector */}
			<div className="card space-y-3">
				<h2 className="section-title">Owner Account</h2>
				<div className="flex gap-2">
					{devAccounts.map((acc, i) => (
						<button
							key={i}
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
			</div>

			{/* Calls */}
			<div className="card space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="section-title">Calls (executed on trigger)</h2>
					<div className="flex flex-wrap gap-2">
						<button onClick={() => addCall("remark")} className="btn-secondary text-xs">
							+ Remark
						</button>
						<button onClick={() => addCall("transfer")} className="btn-secondary text-xs">
							+ Transfer
						</button>
						<button onClick={() => addCall("transfer_all")} className="btn-secondary text-xs">
							+ Transfer All
						</button>
						<button onClick={() => addCall("add_proxy")} className="btn-secondary text-xs">
							+ Add Proxy
						</button>
						<button onClick={() => addCall("multisig_proxy")} className="btn-secondary text-xs">
							+ Multisig Proxy
						</button>
						<button onClick={() => addCall("multisig_transfer")} className="btn-secondary text-xs">
							+ Multisig Transfer
						</button>
					</div>
				</div>

				<div className="space-y-3">
					{calls.map((call, index) => (
						<div
							key={call.id}
							className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 space-y-3"
						>
							<div className="flex items-center justify-between">
								<span className="text-sm font-medium text-text-primary">
									#{index + 1} — {call.type}
								</span>
								{calls.length > 1 && (
									<button
										onClick={() => removeCall(call.id)}
										className="text-xs text-accent-red hover:text-accent-red/80"
									>
										Remove
									</button>
								)}
							</div>

							{call.type === "remark" && (
								<div>
									<label className="label">Message</label>
									<input
										type="text"
										value={call.message || ""}
										onChange={(e) =>
											updateCall(call.id, { message: e.target.value })
										}
										placeholder="Your on-chain message..."
										className="input-field w-full"
									/>
								</div>
							)}

							{call.type === "transfer" && (
								<>
									<AccountSelect
										label="Destination"
										value={call.dest || ""}
										onChange={(v) => updateCall(call.id, { dest: v })}
									/>
									<div>
										<label className="label">
											Amount (UNIT) — max {ownerBalance.toFixed(4)}
										</label>
										<input
											type="number"
											min="0"
											max={ownerBalance}
											value={call.amount || ""}
											onChange={(e) => {
												const v = Math.min(
													parseFloat(e.target.value) || 0,
													ownerBalance,
												);
												updateCall(call.id, { amount: String(v) });
											}}
											placeholder="10"
											className="input-field w-full"
										/>
									</div>
								</>
							)}

							{call.type === "transfer_all" && (
								<AccountSelect
									label="Destination"
									value={call.dest || ""}
									onChange={(v) => updateCall(call.id, { dest: v })}
								/>
							)}

							{call.type === "add_proxy" && (
								<>
									<AccountSelect
										label="Delegate"
										value={call.dest || ""}
										onChange={(v) => updateCall(call.id, { dest: v })}
										placeholder="Account to grant proxy access..."
									/>
									<p className="text-xs text-text-muted">
										This account will be able to act on your behalf
									</p>
								</>
							)}

							{call.type === "multisig_proxy" && (
								<>
									<div>
										<label className="label">Signatories (SS58, comma-separated)</label>
										<input
											type="text"
											value={call.signatories || ""}
											onChange={(e) =>
												updateCall(call.id, { signatories: e.target.value })
											}
											placeholder="5FHne..., 5FLSi..."
											className="input-field w-full"
										/>
										<p className="text-xs text-text-muted mt-1">
											These accounts will control your account via multisig + proxy
										</p>
									</div>
									<div>
										<label className="label">Threshold</label>
										<input
											type="number"
											value={call.threshold || "2"}
											onChange={(e) =>
												updateCall(call.id, { threshold: e.target.value })
											}
											className="input-field w-32"
										/>
										<p className="text-xs text-text-muted mt-1">
											Number of signatories required to approve actions
										</p>
									</div>
								</>
							)}

							{call.type === "multisig_transfer" && (
								<>
									<div>
										<label className="label">Other Signatories (SS58, comma-separated)</label>
										<input
											type="text"
											value={call.signatories || ""}
											onChange={(e) =>
												updateCall(call.id, { signatories: e.target.value })
											}
											placeholder="5FHne..., 5FLSi..."
											className="input-field w-full"
										/>
									</div>
									<div>
										<label className="label">Threshold (min 2)</label>
										<input
											type="number"
											min="2"
											value={call.threshold || "2"}
											onChange={(e) =>
												updateCall(call.id, { threshold: e.target.value })
											}
											className="input-field w-32"
										/>
										<p className="text-xs text-text-muted mt-1">
											First approval is submitted on trigger. Other signatories must approve separately to execute.
										</p>
									</div>
									<AccountSelect
										label="Destination"
										value={call.dest || ""}
										onChange={(v) => updateCall(call.id, { dest: v })}
									/>
									<div>
										<label className="label">
											Amount (UNIT) — max {ownerBalance.toFixed(4)}
										</label>
										<input
											type="number"
											min="0"
											max={ownerBalance}
											value={call.amount || ""}
											onChange={(e) => {
												const v = Math.min(
													parseFloat(e.target.value) || 0,
													ownerBalance,
												);
												updateCall(call.id, { amount: String(v) });
											}}
											placeholder="10"
											className="input-field w-full"
										/>
									</div>
								</>
							)}
						</div>
					))}
				</div>
			</div>

			{/* Settings */}
			<div className="card space-y-4">
				<h2 className="section-title">Settings</h2>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label className="label">Block Interval</label>
						<input
							type="number"
							value={blockInterval}
							onChange={(e) => setBlockInterval(e.target.value)}
							placeholder="100"
							className="input-field w-full"
						/>
						<p className="text-xs text-text-muted mt-1">
							~{estimatedMinutes > 0 ? `${estimatedMinutes} min` : `${estimatedTime}s`} at 6s/block
						</p>
					</div>
					<div>
						<label className="label">
							Trigger Reward (UNIT) — max {ownerBalance.toFixed(4)}
						</label>
						<input
							type="number"
							min="0"
							max={ownerBalance}
							value={triggerReward}
							onChange={(e) => {
								const v = Math.min(
									parseFloat(e.target.value) || 0,
									ownerBalance,
								);
								setTriggerReward(String(v));
							}}
							placeholder="1"
							className="input-field w-full"
						/>
						<p className="text-xs text-text-muted mt-1">
							Incentive for whoever triggers the switch
						</p>
					</div>
				</div>
			</div>

			{/* Submit */}
			<div className="card space-y-3">
				<button
					onClick={handleSubmit}
					disabled={submitting || !connected}
					className="btn-primary w-full py-3"
				>
					{submitting ? "Creating..." : "Create Switch"}
				</button>

				{status && (
					<p
						className={`text-sm font-medium ${
							status.startsWith("Error")
								? "text-accent-red"
								: status.startsWith("Switch created")
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
