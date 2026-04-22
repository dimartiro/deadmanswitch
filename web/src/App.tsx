import { useEffect, useRef, useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { useChainStore } from "./store/chainStore";
import {
	useConnection,
	useConnectionManagement,
} from "./hooks/useConnection";
import { useWalletAutoConnect } from "./hooks/useWalletAutoConnect";
import { getClient } from "./hooks/useChain";
import { LOCAL_WS_URL } from "./config/network";

export default function App() {
	const location = useLocation();
	const blockNumber = useChainStore((s) => s.blockNumber);

	useConnectionManagement();
	useWalletAutoConnect();

	const navItems = [
		{ path: "/", label: "Overview" },
		{ path: "/dashboard", label: "Wills" },
		{ path: "/certificates", label: "Certificates" },
		{ path: "/accounts", label: "Accounts" },
	];

	const isActive = (p: string) =>
		p === "/" ? location.pathname === "/" : location.pathname.startsWith(p);

	return (
		<div className="min-h-screen bg-canvas text-ink-900 scanlines">
			<header className="nav-bar sticky top-0 z-50">
				<div className="max-w-6xl mx-auto px-6">
					<div className="flex items-center justify-between h-14">
						<Link to="/" className="flex items-center gap-2.5 group">
							<span
								className="inline-flex items-center justify-center w-8 h-8 border border-neon-500/40 bg-canvas transition-all group-hover:shadow-neon"
								style={{ borderRadius: "3px" }}
							>
								<svg
									viewBox="0 0 32 32"
									xmlns="http://www.w3.org/2000/svg"
									fill="none"
									className="w-5 h-5 text-neon-500"
									aria-hidden="true"
								>
									<path
										d="M16 3 L27 9.5 L27 22.5 L16 29 L5 22.5 L5 9.5 Z"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinejoin="round"
									/>
									<circle cx="16" cy="16" r="3" fill="currentColor" />
								</svg>
							</span>
							<span className="font-display font-bold tracking-wider uppercase text-[0.95rem]">
								Estate<span className="text-neon-500">.</span>Protocol
							</span>
							<span className="hidden sm:inline chip chip-fuchsia ml-1">
								v0.1
							</span>
						</Link>

						<div className="flex items-center gap-3 font-mono text-[0.7rem]">
							<div className="hidden md:flex items-center gap-1.5 text-ink-500">
								<span className="opacity-60">BLK</span>
								<span className="text-neon-500 tabular">
									#{blockNumber.toLocaleString()}
								</span>
							</div>
							<ConnectionStatusButton />
						</div>
					</div>

					<nav className="nav-tabs flex gap-1 -mb-px overflow-x-auto">
						{navItems.map((item) => (
							<Link
								key={item.path}
								to={item.path}
								className={`nav-tab ${isActive(item.path) ? "is-active" : ""}`}
							>
								{item.label}
							</Link>
						))}
					</nav>
				</div>
			</header>

			<main className="max-w-6xl mx-auto px-6 py-10 animate-fade-in relative z-10">
				<Outlet />
			</main>

			<footer className="border-t border-hairline mt-16">
				<div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between text-[0.7rem] font-mono text-ink-500 uppercase tracking-wider">
					<span>
						<span className="text-neon-500">$</span> estate-protocol — est.{" "}
						{new Date().getFullYear()}
					</span>
					<span className="tabular">
						head <span className="text-neon-500">#{blockNumber.toLocaleString()}</span>
					</span>
				</div>
			</footer>
		</div>
	);
}

function ConnectionStatusButton() {
	const { wsUrl, connected, blockNumber } = useChainStore();
	const { connect } = useConnection();
	const [open, setOpen] = useState(false);
	const [urlInput, setUrlInput] = useState(wsUrl);
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [chainName, setChainName] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

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

	useEffect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		}
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKey);
		};
	}, [open]);

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
			setError(`Could not reach ${urlInput}`);
			console.error(e);
		} finally {
			setConnecting(false);
		}
	}

	return (
		<div ref={containerRef} className="relative">
			<button
				onClick={() => setOpen((o) => !o)}
				className={`${connected ? "chip-positive" : "chip-neutral"} cursor-pointer hover:opacity-80 transition-opacity`}
				title="Open connection panel"
			>
				<span
					className={`dot ${connected ? "animate-neon-pulse" : ""}`}
				/>
				{connected ? "online" : connecting ? "dialing…" : "offline"}
			</button>

			{open && (
				<div
					className="absolute right-0 top-full mt-2 w-[min(92vw,420px)] card-padded z-50 shadow-lifted animate-slide-up"
					style={{ borderRadius: "4px" }}
				>
					<div className="flex items-start justify-between mb-3">
						<div>
							<div className="eyebrow mb-1">endpoint</div>
							<h3 className="h-section">CHAIN CONNECTION</h3>
						</div>
						<button
							onClick={() => setOpen(false)}
							className="text-ink-400 hover:text-ink-900 w-6 h-6 flex items-center justify-center"
							aria-label="Close"
						>
							✕
						</button>
					</div>

					<p className="text-xs text-ink-500 font-mono mb-4">
						Point this terminal at an Estate Protocol node.
					</p>

					<div className="flex flex-col gap-2">
						<div className="relative">
							<span className="absolute left-3 top-1/2 -translate-y-1/2 text-neon-500 font-mono text-sm select-none pointer-events-none">
								$
							</span>
							<input
								type="text"
								value={urlInput}
								onChange={(e) => setUrlInput(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && handleConnect()}
								placeholder={LOCAL_WS_URL}
								className="input-mono pl-7"
							/>
						</div>
						<button
							onClick={handleConnect}
							disabled={connecting}
							className="btn-accent w-full"
						>
							{connecting ? "dialing…" : "connect"}
						</button>
					</div>

					<div className="grid grid-cols-3 gap-4 mt-5 pt-5 border-t border-hairline">
						<div>
							<div className="eyebrow mb-1" style={{ fontSize: "0.6rem" }}>
								status
							</div>
							<div className="font-mono text-xs">
								{error ? (
									<span className="text-danger">ERR</span>
								) : connected ? (
									<span className="text-neon-500">LIVE</span>
								) : (
									<span className="text-ink-500">—</span>
								)}
							</div>
						</div>
						<div>
							<div className="eyebrow mb-1" style={{ fontSize: "0.6rem" }}>
								chain
							</div>
							<div className="font-mono text-xs">
								{chainName ? (
									<span className="truncate block">{chainName}</span>
								) : (
									<span className="text-ink-400">—</span>
								)}
							</div>
						</div>
						<div>
							<div className="eyebrow mb-1" style={{ fontSize: "0.6rem" }}>
								head
							</div>
							<div className="font-mono tabular text-xs text-neon-500">
								#{blockNumber.toLocaleString()}
							</div>
						</div>
					</div>
					{error && (
						<p className="text-xs text-danger mt-3 font-mono">{error}</p>
					)}
				</div>
			)}
		</div>
	);
}
