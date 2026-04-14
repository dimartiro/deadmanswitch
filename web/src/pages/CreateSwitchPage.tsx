import { useState } from "react";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import { getClient } from "../hooks/useChain";
import { stack_template } from "@polkadot-api/descriptors";
import { formatDispatchError } from "../utils/format";
import { Binary } from "polkadot-api";

type CallType = "remark" | "transfer" | "transfer_all";

interface CallEntry {
	id: number;
	type: CallType;
	// remark
	message?: string;
	// transfer
	dest?: string;
	amount?: string;
}

let nextCallId = 0;

function buildRuntimeCall(
	api: ReturnType<ReturnType<typeof getClient>["getTypedApi"]>,
	entry: CallEntry,
) {
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
					<div className="flex gap-2">
						<button onClick={() => addCall("remark")} className="btn-secondary text-xs">
							+ Remark
						</button>
						<button onClick={() => addCall("transfer")} className="btn-secondary text-xs">
							+ Transfer
						</button>
						<button onClick={() => addCall("transfer_all")} className="btn-secondary text-xs">
							+ Transfer All
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
									<div>
										<label className="label">Destination (SS58)</label>
										<input
											type="text"
											value={call.dest || ""}
											onChange={(e) =>
												updateCall(call.id, { dest: e.target.value })
											}
											placeholder="5Grwva..."
											className="input-field w-full"
										/>
									</div>
									<div>
										<label className="label">Amount (UNIT)</label>
										<input
											type="number"
											value={call.amount || ""}
											onChange={(e) =>
												updateCall(call.id, { amount: e.target.value })
											}
											placeholder="10"
											className="input-field w-full"
										/>
									</div>
								</>
							)}

							{call.type === "transfer_all" && (
								<div>
									<label className="label">Destination (SS58)</label>
									<input
										type="text"
										value={call.dest || ""}
										onChange={(e) =>
											updateCall(call.id, { dest: e.target.value })
										}
										placeholder="5Grwva..."
										className="input-field w-full"
									/>
								</div>
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
						<label className="label">Trigger Reward (UNIT)</label>
						<input
							type="number"
							value={triggerReward}
							onChange={(e) => setTriggerReward(e.target.value)}
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
