import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useChainStore } from "../store/chainStore";
import { useConnection } from "../hooks/useConnection";
import { getClient } from "../hooks/useChain";
import { LOCAL_WS_URL } from "../config/network";
import { stack_template } from "@polkadot-api/descriptors";

export default function HomePage() {
	const { wsUrl, connected, blockNumber } = useChainStore();
	const { connect } = useConnection();
	const [urlInput, setUrlInput] = useState(wsUrl);
	const [error, setError] = useState<string | null>(null);
	const [chainName, setChainName] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);
	const [counts, setCounts] = useState<{
		active: number;
		executed: number;
		expired: number;
	} | null>(null);

	useEffect(() => {
		setUrlInput(wsUrl);
	}, [wsUrl]);

	useEffect(() => {
		if (!connected) return;
		const client = getClient(wsUrl);
		client
			.getChainSpecData()
			.then((data) => setChainName(data.name))
			.catch(() => {});
		(async () => {
			try {
				const api = client.getTypedApi(stack_template);
				const wills = await api.query.EstateExecutor.Wills.getEntries({
					at: "best",
				});
				let active = 0,
					executed = 0,
					expired = 0;
				for (const e of wills) {
					const status = (e.value.status as { type: string }).type;
					const expiry = e.value.expiry_block as number;
					if (status === "Executed") executed++;
					else if (blockNumber > expiry) expired++;
					else active++;
				}
				setCounts({ active, executed, expired });
			} catch {
				setCounts(null);
			}
		})();
	}, [connected, wsUrl, blockNumber]);

	async function handleConnect() {
		setConnecting(true);
		setError(null);
		setChainName(null);
		try {
			const result = await connect(urlInput);
			if (result?.ok && result.chain) {
				setChainName(result.chain.name);
			}
		} catch (e) {
			setError(`Could not reach ${urlInput}.`);
			console.error(e);
		} finally {
			setConnecting(false);
		}
	}

	return (
		<div className="space-y-10 stagger">
			{/* Hero card — oversized typography + primary CTAs */}
			<section className="card-hero p-8 md:p-12">
				<div className="grid md:grid-cols-12 gap-8 items-end">
					<div className="md:col-span-8 space-y-6">
						<span className="chip chip-estate">
							<span className="dot" /> Polkadot SDK parachain
						</span>
						<h1 className="h-display text-[clamp(2.75rem,7vw,5rem)] text-balance">
							Your on-chain{" "}
							<span className="italic text-estate-500">legacy,</span>{" "}
							set in stone.
						</h1>
						<p className="text-ink-500 max-w-xl text-[1.05rem] leading-relaxed">
							Register a will of on-chain actions. Send a heartbeat now and
							then to stay its hand. Fall silent and the ledger executes what
							you authored — a transfer, a proxy, an inheritance — with no
							keeper, no fee, no third party holding your keys.
						</p>
						<div className="flex flex-wrap gap-3 pt-2">
							<Link to="/create" className="btn-accent">
								Draft a will
								<span>→</span>
							</Link>
							<Link to="/dashboard" className="btn-outline">
								View the ledger
							</Link>
						</div>
					</div>

					<div className="md:col-span-4 grid grid-cols-2 gap-3">
						<Stat label="Active" value={counts?.active ?? "—"} tone="muted" />
						<Stat label="Executed" value={counts?.executed ?? "—"} tone="estate" />
					</div>
				</div>
			</section>

			{/* Connection panel — a different treatment: a muted strip card */}
			<section className="card-padded">
				<div className="flex items-start justify-between gap-4 flex-wrap">
					<div>
						<div className="eyebrow mb-1">Endpoint</div>
						<h2 className="h-section">Chain connection</h2>
						<p className="text-sm text-ink-500 mt-1">
							Estate Protocol lives on a specific parachain. Point this UI at
							the right node.
						</p>
					</div>
					<span
						className={`chip ${connected ? "chip-positive" : "chip-neutral"}`}
					>
						<span className="dot" />
						{connected ? "Connected" : connecting ? "Connecting…" : "Offline"}
					</span>
				</div>

				<div className="mt-5 flex flex-col md:flex-row gap-3">
					<div className="select-wrap flex-1">
						<input
							type="text"
							value={urlInput}
							onChange={(e) => setUrlInput(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleConnect()}
							placeholder={LOCAL_WS_URL}
							className="input-mono"
						/>
					</div>
					<button
						onClick={handleConnect}
						disabled={connecting}
						className="btn-primary md:w-auto w-full"
					>
						{connecting ? "Connecting…" : "Connect"}
					</button>
				</div>

				<div className="grid grid-cols-3 gap-3 mt-5 pt-5 border-t border-hairline">
					<MiniStat
						label="Status"
						value={
							error ? (
								<span className="text-danger">Unreachable</span>
							) : connected ? (
								<span className="text-positive">Live</span>
							) : (
								<span className="text-ink-500">—</span>
							)
						}
					/>
					<MiniStat
						label="Chain"
						value={
							chainName ? (
								<span className="font-medium">{chainName}</span>
							) : (
								<span className="text-ink-400">—</span>
							)
						}
					/>
					<MiniStat
						label="Head"
						value={
							<span className="font-mono tabular">
								№{blockNumber.toLocaleString()}
							</span>
						}
					/>
				</div>
				{error && (
					<p className="text-sm text-danger mt-3">
						{error}
					</p>
				)}
			</section>

			{/* Feature grid — three distinct treatments */}
			<section className="grid md:grid-cols-3 gap-4">
				<FeatureCard
					to="/dashboard"
					eyebrow="Record"
					title="Wills"
					description="Browse every will on chain. Send heartbeats. Watch the countdown to execution."
					chip={<span className="chip chip-estate"><span className="dot" />Live</span>}
				/>
				<FeatureCard
					to="/certificates"
					eyebrow="Inheritance"
					title="Certificates"
					description="Soulbound NFTs minted when a will naming you executes. Non-transferable, permanent."
					chip={<span className="chip chip-brass"><span className="dot" />Soulbound</span>}
				/>
				<FeatureCard
					to="/accounts"
					eyebrow="Keys"
					title="Accounts"
					description="Connect wallets. Register an identity. Link your account to Asset Hub for XCM flows."
					chip={<span className="chip chip-neutral"><span className="dot" />Keys</span>}
				/>
			</section>

			{/* Mechanics strip — low-density, wide text */}
			<section className="card rounded-3xl p-8 md:p-10">
				<div className="grid md:grid-cols-12 gap-8">
					<div className="md:col-span-5">
						<div className="eyebrow mb-2">How it works</div>
						<h2 className="h-page">
							Four steps, from <em className="text-estate-500 not-italic font-display font-medium">draft</em> to <em className="text-estate-500 not-italic font-display font-medium">delivery</em>
						</h2>
					</div>
					<ol className="md:col-span-7 space-y-4">
						<Step
							n="01"
							title="Author"
							desc="Pick beneficiaries, amounts, and a heartbeat interval. The pallet stores a typed list of bequests on chain."
						/>
						<Step
							n="02"
							title="Heartbeat"
							desc="Ping the chain at your leisure. Each heartbeat resets the countdown and reschedules execution."
						/>
						<Step
							n="03"
							title="Silence"
							desc="If the countdown elapses, pallet-scheduler fires execute_will automatically. No keeper, no reward."
						/>
						<Step
							n="04"
							title="Delivery"
							desc="Each bequest dispatches over XCM to Asset Hub as your proxy. Beneficiaries receive a soulbound certificate."
						/>
					</ol>
				</div>
			</section>
		</div>
	);
}

function Stat({
	label,
	value,
	tone,
}: {
	label: string;
	value: string | number;
	tone: "estate" | "brass" | "muted";
}) {
	const bg =
		tone === "estate"
			? "bg-estate-50 border-estate-100"
			: tone === "brass"
				? "bg-brass-50 border-brass-100"
				: "bg-muted border-hairline";
	const text =
		tone === "estate"
			? "text-estate-500"
			: tone === "brass"
				? "text-brass-500"
				: "text-ink-400";
	return (
		<div className={`rounded-xl border ${bg} px-3 py-4 text-center`}>
			<div className={`text-2xl font-semibold tabular ${text}`}>{value}</div>
			<div className="eyebrow mt-1">{label}</div>
		</div>
	);
}

function MiniStat({
	label,
	value,
}: {
	label: string;
	value: React.ReactNode;
}) {
	return (
		<div>
			<div className="eyebrow mb-1">{label}</div>
			<div className="text-sm">{value}</div>
		</div>
	);
}

function FeatureCard({
	to,
	eyebrow,
	title,
	description,
	chip,
}: {
	to: string;
	eyebrow: string;
	title: string;
	description: string;
	chip: React.ReactNode;
}) {
	return (
		<Link
			to={to}
			className="group card-padded hover:shadow-card hover:border-rule transition-all"
		>
			<div className="flex items-start justify-between mb-4">
				<div className="eyebrow">{eyebrow}</div>
				{chip}
			</div>
			<h3 className="h-page mb-2 group-hover:text-estate-500 transition-colors">
				{title}
			</h3>
			<p className="text-sm text-ink-500 leading-relaxed">{description}</p>
			<div className="mt-4 flex items-center gap-1 text-sm text-estate-500 font-medium">
				Open
				<span className="transition-transform group-hover:translate-x-1">
					→
				</span>
			</div>
		</Link>
	);
}

function Step({
	n,
	title,
	desc,
}: {
	n: string;
	title: string;
	desc: string;
}) {
	return (
		<li className="flex gap-4">
			<span className="font-mono text-xs text-ink-400 pt-1 tabular">{n}</span>
			<div>
				<div className="font-semibold text-ink-900">{title}</div>
				<p className="text-sm text-ink-500 leading-relaxed">{desc}</p>
			</div>
		</li>
	);
}
