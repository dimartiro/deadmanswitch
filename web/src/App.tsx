import { Outlet, Link, useLocation } from "react-router-dom";
import { useChainStore } from "./store/chainStore";
import { useConnectionManagement } from "./hooks/useConnection";
import { useWalletAutoConnect } from "./hooks/useWalletAutoConnect";

export default function App() {
	const location = useLocation();
	const connected = useChainStore((s) => s.connected);

	useConnectionManagement();
	useWalletAutoConnect();

	const navItems = [
		{ path: "/", label: "Home" },
		{ path: "/dashboard", label: "Dashboard" },
		{ path: "/create", label: "Create" },
		{ path: "/accounts", label: "Accounts" },
	];

	return (
		<div className="min-h-screen bg-pattern relative">
			{/* Ambient gradient orbs */}
			<div
				className="gradient-orb"
				style={{ background: "#e6007a", top: "-200px", right: "-100px" }}
			/>
			<div
				className="gradient-orb"
				style={{ background: "#4cc2ff", bottom: "-200px", left: "-100px" }}
			/>

			{/* Navigation */}
			<nav className="sticky top-0 z-50 border-b border-white/[0.06] backdrop-blur-xl bg-surface-950/80">
				<div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-6">
					<Link to="/" className="flex items-center gap-2.5 shrink-0 group">
						<img src="/ded.png" alt="Dedman Switch" className="w-7 h-7 rounded-lg shadow-glow transition-shadow group-hover:shadow-glow-lg" />
						<span className="text-base font-semibold text-text-primary font-display tracking-tight">
							Dedman Switch
						</span>
					</Link>

					<div className="flex gap-0.5 overflow-x-auto">
						{navItems.map((item) => (
							<Link
								key={item.path}
								to={item.path}
								className={`relative px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 whitespace-nowrap ${
									location.pathname === item.path
										? "text-white"
										: "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]"
								}`}
							>
								{location.pathname === item.path && (
									<span className="absolute inset-0 rounded-lg bg-polka-500/15 border border-polka-500/25" />
								)}
								<span className="relative">{item.label}</span>
							</Link>
						))}
					</div>

					{/* Connection indicator */}
					<div className="ml-auto flex items-center gap-2 shrink-0">
						<span
							className={`w-2 h-2 rounded-full transition-colors duration-500 ${
								connected
									? "bg-accent-green shadow-[0_0_6px_rgba(52,211,153,0.5)]"
									: "bg-text-muted"
							}`}
						/>
						<span className="text-xs text-text-tertiary hidden sm:inline">
							{connected ? "Connected" : "Offline"}
						</span>
					</div>
				</div>
			</nav>

			{/* Main content */}
			<main className="relative z-10 max-w-5xl mx-auto px-4 py-8">
				<Outlet />
			</main>
		</div>
	);
}
