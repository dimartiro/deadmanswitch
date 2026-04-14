import { useEffect, useState } from "react";
import { useChainStore } from "../store/chainStore";
import { useConnection } from "../hooks/useConnection";
import { getClient } from "../hooks/useChain";
import { LOCAL_WS_URL } from "../config/network";

export default function HomePage() {
	const { wsUrl, connected, blockNumber } = useChainStore();
	const { connect } = useConnection();
	const [urlInput, setUrlInput] = useState(wsUrl);
	const [error, setError] = useState<string | null>(null);
	const [chainName, setChainName] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);

	useEffect(() => {
		setUrlInput(wsUrl);
	}, [wsUrl]);

	useEffect(() => {
		if (!connected) return;
		getClient(wsUrl)
			.getChainSpecData()
			.then((data) => setChainName(data.name))
			.catch(() => {});
	}, [connected, wsUrl]);

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
			setError(`Could not connect to ${urlInput}. Is the chain running?`);
			console.error(e);
		} finally {
			setConnecting(false);
		}
	}

	return (
		<div className="space-y-8 animate-fade-in">
			{/* Hero */}
			<div className="space-y-3">
				<h1 className="page-title">
					Dedman{" "}
					<span className="bg-gradient-to-r from-polka-400 to-polka-600 bg-clip-text text-transparent">
						Switch
					</span>
				</h1>
				<p className="text-text-secondary text-base leading-relaxed max-w-2xl">
					Store runtime calls that execute automatically on your behalf if you
					stop sending heartbeats. Anyone can trigger an expired switch and earn
					a reward for doing so.
				</p>
			</div>

			{/* Connection card */}
			<div className="card space-y-5">
				<div>
					<label className="label">WebSocket Endpoint</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={urlInput}
							onChange={(e) => setUrlInput(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleConnect()}
							placeholder={LOCAL_WS_URL}
							className="input-field flex-1"
						/>
						<button
							onClick={handleConnect}
							disabled={connecting}
							className="btn-primary"
						>
							{connecting ? "Connecting..." : "Connect"}
						</button>
					</div>
				</div>

				{/* Status grid */}
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					<StatusItem label="Chain Status">
						{error ? (
							<span className="text-accent-red text-sm">{error}</span>
						) : connected ? (
							<span className="text-accent-green flex items-center gap-1.5">
								<span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse-slow" />
								Connected
							</span>
						) : connecting ? (
							<span className="text-accent-yellow">Connecting...</span>
						) : (
							<span className="text-text-muted">Disconnected</span>
						)}
					</StatusItem>
					<StatusItem label="Chain Name">
						{chainName || <span className="text-text-muted">...</span>}
					</StatusItem>
					<StatusItem label="Latest Block">
						<span className="font-mono">#{blockNumber}</span>
					</StatusItem>
				</div>
			</div>

			{/* Feature cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<a href="#/dashboard" className="card-hover block group hover:border-accent-blue/20">
					<h3 className="text-lg font-semibold mb-2 font-display text-accent-blue">
						Dashboard
					</h3>
					<p className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
						View all dedman switches, send heartbeats, or trigger expired ones
						to earn rewards.
					</p>
				</a>
				<a href="#/create" className="card-hover block group hover:border-accent-purple/20">
					<h3 className="text-lg font-semibold mb-2 font-display text-accent-purple">
						Create
					</h3>
					<p className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
						Set up a new dedman switch with custom calls, interval, and trigger
						reward.
					</p>
				</a>
				<a href="#/accounts" className="card-hover block group hover:border-accent-green/20">
					<h3 className="text-lg font-semibold mb-2 font-display text-accent-green">
						Accounts
					</h3>
					<p className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
						Manage dev accounts and check balances.
					</p>
				</a>
			</div>
		</div>
	);
}

function StatusItem({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<h3 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-1">
				{label}
			</h3>
			<p className="text-lg font-semibold text-text-primary">{children}</p>
		</div>
	);
}
