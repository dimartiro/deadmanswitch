import { Outlet, Link, useLocation } from "react-router-dom";
import { useChainStore } from "./store/chainStore";
import { useConnectionManagement } from "./hooks/useConnection";
import { useWalletAutoConnect } from "./hooks/useWalletAutoConnect";

export default function App() {
	const location = useLocation();
	const connected = useChainStore((s) => s.connected);
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
		<div className="min-h-screen bg-canvas text-ink-900">
			{/* Sticky top bar — brand + connection */}
			<header className="nav-bar sticky top-0 z-50">
				<div className="max-w-6xl mx-auto px-6">
					<div className="flex items-center justify-between h-14">
						<Link to="/" className="flex items-center gap-2.5">
							<span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-estate-50 border border-estate-100">
								<svg
									viewBox="0 0 32 32"
									xmlns="http://www.w3.org/2000/svg"
									fill="none"
									className="w-5 h-5 text-estate-400"
									aria-hidden="true"
								>
									<path
										d="M16 3 L27 9.5 L27 22.5 L16 29 L5 22.5 L5 9.5 Z"
										stroke="currentColor"
										strokeWidth="2.25"
										strokeLinejoin="round"
									/>
									<circle cx="16" cy="16" r="3.5" fill="currentColor" />
								</svg>
							</span>
							<span className="font-semibold tracking-tight">
								Estate Protocol
							</span>
							<span className="hidden sm:inline chip chip-estate ml-1">
								<span className="dot" /> beta
							</span>
						</Link>

						<div className="flex items-center gap-3">
							<div className="hidden md:flex items-center gap-2 text-xs text-ink-500 font-mono tabular">
								<span>№</span>
								<span className="text-ink-900">
									{blockNumber.toLocaleString()}
								</span>
							</div>
							<span
								className={`chip ${connected ? "chip-positive" : "chip-neutral"}`}
							>
								<span className="dot" />
								{connected ? "Connected" : "Offline"}
							</span>
						</div>
					</div>

					{/* Horizontal tab bar */}
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

			{/* Main */}
			<main className="max-w-6xl mx-auto px-6 py-10 animate-fade-in">
				<Outlet />
			</main>

			{/* Footer */}
			<footer className="border-t border-hairline mt-16">
				<div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between text-xs text-ink-500">
					<span>© {new Date().getFullYear()} Estate Protocol</span>
					<span className="font-mono tabular">
						head №{blockNumber.toLocaleString()}
					</span>
				</div>
			</footer>
		</div>
	);
}
