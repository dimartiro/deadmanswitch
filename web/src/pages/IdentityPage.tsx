import { useState, useEffect, useCallback } from "react";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import { useAllAccounts } from "../hooks/useAllAccounts";
import { getPeopleChainClient } from "../hooks/useChain";
import { people_chain } from "@polkadot-api/descriptors";
import { submitAndWait } from "../utils/tx";
import { Binary, FixedSizeBinary } from "polkadot-api";

interface IdentityStatus {
	address: string;
	name: string;
	hasIdentity: boolean;
	display?: string;
}

export default function IdentityPage() {
	const { selectedAccount, blockNumber } = useChainStore();
	const { accounts, selected } = useAllAccounts();
	const [statuses, setStatuses] = useState<IdentityStatus[]>([]);
	const [loading, setLoading] = useState(false);
	const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

	const fetchIdentities = useCallback(async () => {
		setLoading(true);
		try {
			const client = getPeopleChainClient();
			const api = client.getTypedApi(people_chain);
			const results = await Promise.all(
				accounts.map(async (acc) => {
					try {
						const info = await api.query.Identity.IdentityOf.getValue(
							acc.address,
						);
						let display: string | undefined;
						if (info !== undefined) {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const rawDisplay = (info as any)?.info?.display;
							const type = rawDisplay?.type as string | undefined;
							if (type?.startsWith("Raw") && type !== "Raw0") {
								try {
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
									const bin = rawDisplay.value as any;
									if (typeof bin === "number") {
										// Raw1 variant: single byte as number.
										display = String.fromCharCode(bin);
									} else if (bin?.asText) {
										display = bin.asText();
									} else if (bin instanceof Binary) {
										display = bin.asText();
									}
								} catch {
									// keep undefined
								}
							}
						}
						return {
							address: acc.address,
							name: acc.name,
							hasIdentity: info !== undefined,
							display,
						};
					} catch {
						return {
							address: acc.address,
							name: acc.name,
							hasIdentity: false,
						};
					}
				}),
			);
			setStatuses(results);
		} finally {
			setLoading(false);
		}
	}, [accounts]);

	useEffect(() => {
		fetchIdentities();
	}, [fetchIdentities, blockNumber]);

	async function registerIdentity() {
		if (!selected) {
			setActionStatus((s) => ({ ...s, _: "Error: No account selected" }));
			return;
		}
		const key = `reg-${selected.address}`;
		setActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
		try {
			const client = getPeopleChainClient();
			const api = client.getTypedApi(people_chain);
			// Papi's IdentityData enum has one variant per byte length
			// (Raw0..Raw32). Raw0 and None carry no value; Raw1 is a bare
			// u8 (number); Raw2..=Raw32 use FixedSizeBinary<N>.
			const displayName = selected.name.slice(0, 32);
			const bytes = new TextEncoder().encode(displayName).slice(0, 32);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let display: any;
			if (bytes.length === 0) {
				display = { type: "None", value: undefined };
			} else if (bytes.length === 1) {
				display = { type: "Raw1", value: bytes[0] };
			} else {
				display = {
					type: `Raw${bytes.length}`,
					value: FixedSizeBinary.fromBytes(bytes),
				};
			}
			const none = { type: "None" as const, value: undefined };
			// People Chain uses the modernised IdentityInfo (no `additional`,
			// `riot` renamed to `matrix`, `github` + `discord` added).
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const info: any = {
				display,
				legal: none,
				web: none,
				matrix: none,
				email: none,
				pgp_fingerprint: undefined,
				image: none,
				twitter: none,
				github: none,
				discord: none,
			};
			const tx = api.tx.Identity.set_identity({ info });
			const result = await submitAndWait(tx, selected.signer);
			if (result.ok) {
				setActionStatus((s) => ({ ...s, [key]: "Registered" }));
				fetchIdentities();
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

	async function clearIdentity() {
		if (!selected) return;
		const key = `clr-${selected.address}`;
		setActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
		try {
			const client = getPeopleChainClient();
			const api = client.getTypedApi(people_chain);
			const tx = api.tx.Identity.clear_identity();
			const result = await submitAndWait(tx, selected.signer);
			if (result.ok) {
				setActionStatus((s) => ({ ...s, [key]: "Cleared" }));
				fetchIdentities();
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

	const selectedStatus = statuses.find((s) => s.address === selected?.address);

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title">Identity</h1>
				<p className="text-text-secondary">
					Beneficiaries of a will need a registered on-chain identity on{" "}
					<span className="font-mono text-xs">People Chain</span> — a Polkadot
					system parachain dedicated to identity (sibling of Estate Protocol
					in this zombienet setup). All tx here go to People Chain at{" "}
					<span className="font-mono text-xs">ws://localhost:9946</span>.
				</p>
			</div>

			{/* Current account action */}
			<div className="card space-y-4">
				<h2 className="section-title">Current Account</h2>
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
					<div className="space-y-3">
						<p className="text-xs text-text-muted font-mono">
							{selected.address}
						</p>
						{selectedStatus?.hasIdentity ? (
							<div className="flex flex-col gap-2">
								<p className="text-sm">
									<span className="status-badge bg-accent-green/10 text-accent-green border border-accent-green/20 mr-2">
										✓ registered
									</span>
									{selectedStatus.display && (
										<span className="text-text-muted">
											as "{selectedStatus.display}"
										</span>
									)}
								</p>
								<button
									onClick={clearIdentity}
									className="btn-secondary text-sm self-start"
								>
									Clear identity
								</button>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								<p className="text-sm">
									<span className="status-badge bg-accent-red/10 text-accent-red border border-accent-red/20">
										✗ no identity
									</span>
								</p>
								<button
									onClick={registerIdentity}
									className="btn-primary text-sm self-start"
								>
									Register identity (set display = "{selected.name}")
								</button>
							</div>
						)}
						{Object.entries(actionStatus).map(([k, v]) => (
							<p
								key={k}
								className={`text-xs font-medium ${
									v.startsWith("Error")
										? "text-accent-red"
										: v === "Registered" || v === "Cleared"
											? "text-accent-green"
											: "text-accent-yellow"
								}`}
							>
								{k}: {v}
							</p>
						))}
					</div>
				)}
			</div>

			{/* All known accounts */}
			<div className="card space-y-3">
				<h2 className="section-title">All Known Accounts</h2>
				{loading && statuses.length === 0 && (
					<p className="text-text-muted text-sm">Loading...</p>
				)}
				<div className="space-y-2">
					{statuses.map((s) => {
						const dev = devAccounts.find((a) => a.address === s.address);
						const label = dev ? dev.name : s.name;
						return (
							<div
								key={s.address}
								className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
							>
								<span className="text-sm text-text-primary">{label}</span>
								{s.hasIdentity ? (
									<span className="status-badge bg-accent-green/10 text-accent-green border border-accent-green/20">
										✓ {s.display ?? "registered"}
									</span>
								) : (
									<span className="status-badge bg-accent-red/10 text-accent-red border border-accent-red/20">
										✗ no identity
									</span>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
