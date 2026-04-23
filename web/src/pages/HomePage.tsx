import { stack_template } from "@polkadot-api/descriptors";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getClient } from "../hooks/useChain";
import { useChainStore } from "../store/chainStore";

export default function HomePage() {
	const { wsUrl, connected, blockNumber } = useChainStore();
	const [counts, setCounts] = useState<{
		active: number;
		executed: number;
		expired: number;
	} | null>(null);

	useEffect(() => {
		if (!connected) return;
		const client = getClient(wsUrl);
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

	return (
		<div className="space-y-10 stagger">
			{/* Hero panel */}
			<section className="card-hero p-8 md:p-12 scanlines">
				<div className="grid md:grid-cols-12 gap-8 items-end">
					<div className="md:col-span-8 space-y-6">
						<div className="flex items-center gap-3">
							<span className="chip chip-estate">
								<span className="dot animate-neon-pulse" />
								polkadot SDK / parachain
							</span>
							<span className="chip chip-fuchsia">xcm → asset hub</span>
						</div>

						<h1 className="h-display text-[clamp(2.5rem,7vw,4.75rem)] text-balance">
							YOUR ON-CHAIN
							<br />
							<span className="neon-text">LEGACY</span>{" "}
							<span className="h-display-light italic normal-case text-ink-700">
								set in stone.
							</span>
						</h1>

						<p className="font-mono text-[0.88rem] text-ink-700 max-w-xl leading-relaxed">
							<span className="text-neon-500">&gt;</span> Register a will of on-chain
							actions. Heartbeat at will. Silence fires the vault —
							transfers, proxies, inheritances — with no keeper, no fee, no
							third party holding your keys.
						</p>

						<div className="flex flex-wrap gap-3 pt-2">
							<Link to="/create" className="btn-accent">
								Draft a will
								<span>→</span>
							</Link>
							<Link to="/dashboard" className="btn-outline">
								Open vault
							</Link>
						</div>
					</div>

					<div className="md:col-span-4 grid grid-cols-2 gap-3">
						<Stat label="ACTIVE" value={counts?.active ?? "—"} tone="muted" />
						<Stat label="EXECUTED" value={counts?.executed ?? "—"} tone="neon" />
					</div>
				</div>
			</section>

			{/* Feature tiles */}
			<section className="grid md:grid-cols-3 gap-4">
				<FeatureCard
					to="/dashboard"
					eyebrow="Record"
					title="Wills"
					description="Every will on chain. Heartbeat. Countdown. Execute."
					chip={
						<span className="chip-estate">
							<span className="dot" />
							live
						</span>
					}
				/>
				<FeatureCard
					to="/certificates"
					eyebrow="Inheritance"
					title="Certificates"
					description="Soulbound NFTs minted when a will naming you executes."
					chip={
						<span className="chip-fuchsia">
							<span className="dot" />
							soulbound
						</span>
					}
				/>
				<FeatureCard
					to="/accounts"
					eyebrow="Keys"
					title="Accounts"
					description="Wallets. Identities. Asset Hub proxy links."
					chip={<span className="chip-neutral">manage</span>}
				/>
			</section>

			{/* How it works */}
			<section className="card p-8 md:p-10">
				<div className="grid md:grid-cols-12 gap-8">
					<div className="md:col-span-5">
						<div className="eyebrow mb-2">runbook</div>
						<h2 className="h-page">
							<span className="text-neon-500">#</span> four steps
						</h2>
						<p className="font-mono text-xs text-ink-500 mt-3">
							from <span className="text-neon-500">draft</span> to{" "}
							<span className="text-fuchsia-500">delivery</span>
						</p>
					</div>
					<ol className="md:col-span-7 space-y-4">
						<Step
							n="01"
							title="Author"
							desc="Typed bequests, a heartbeat interval. SCALE-encoded, stored on chain."
						/>
						<Step
							n="02"
							title="Heartbeat"
							desc="Ping at your leisure. Each heartbeat reschedules pallet-scheduler."
						/>
						<Step
							n="03"
							title="Silence"
							desc="Countdown elapses, execute_will fires deterministically. No keepers."
						/>
						<Step
							n="04"
							title="Delivery"
							desc="Each bequest dispatches over XCM to Asset Hub as your proxy."
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
	tone: "neon" | "fuchsia" | "muted";
}) {
	const text =
		tone === "neon"
			? "text-neon-500"
			: tone === "fuchsia"
				? "text-fuchsia-500"
				: "text-ink-400";
	const borderClass =
		tone === "neon"
			? "border-neon-500/30"
			: tone === "fuchsia"
				? "border-fuchsia-500/30"
				: "border-hairline";
	const bg =
		tone === "neon" ? "bg-neon-500/5" : tone === "fuchsia" ? "bg-fuchsia-500/5" : "bg-muted";
	const glow = tone === "neon" ? "shadow-[0_0_24px_rgba(0,255,179,0.12)]" : "";
	return (
		<div
			className={`${bg} border ${borderClass} ${glow} px-3 py-4 text-center`}
			style={{ borderRadius: "3px" }}
		>
			<div
				className={`font-mono text-2xl font-bold tabular ${text}`}
				style={{ letterSpacing: "-0.02em" }}
			>
				{value}
			</div>
			<div className="eyebrow mt-1 justify-center" style={{ fontSize: "0.55rem" }}>
				{label}
			</div>
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
			className="group card-padded hover:border-neon-500/30 transition-all"
			style={{ borderRadius: "3px" }}
		>
			<div className="flex items-start justify-between mb-4">
				<div className="eyebrow">{eyebrow}</div>
				{chip}
			</div>
			<h3 className="h-page mb-2 group-hover:text-neon-500 group-hover:neon-text transition-all">
				{title}
			</h3>
			<p className="text-sm text-ink-500 leading-relaxed font-mono">{description}</p>
			<div className="mt-4 flex items-center gap-1 text-xs text-neon-500 font-mono uppercase tracking-wider">
				access
				<span className="transition-transform group-hover:translate-x-1">→</span>
			</div>
		</Link>
	);
}

function Step({ n, title, desc }: { n: string; title: string; desc: string }) {
	return (
		<li className="flex gap-4">
			<span className="font-mono text-xs text-neon-500 pt-1 tabular shrink-0">{n}</span>
			<div>
				<div className="font-display font-bold uppercase tracking-wider text-ink-900 text-sm">
					{title}
				</div>
				<p className="text-sm text-ink-500 leading-relaxed font-mono">{desc}</p>
			</div>
		</li>
	);
}
