import { useState } from "react";
import { useChainStore } from "../store/chainStore";
import { useConnection } from "../hooks/useConnection";

export default function OfflineBanner() {
	const connected = useChainStore((s) => s.connected);
	const initialDone = useChainStore((s) => s.initialConnectComplete);
	const wsUrl = useChainStore((s) => s.wsUrl);
	const { connect } = useConnection();
	const [retrying, setRetrying] = useState(false);

	if (!initialDone || connected) return null;

	async function handleRetry() {
		setRetrying(true);
		try {
			await connect(wsUrl);
		} catch {
			/* surfaced by banner state */
		} finally {
			setRetrying(false);
		}
	}

	return (
		<div className="alert-danger flex items-center justify-between gap-3 flex-wrap mb-6 animate-slide-up">
			<div className="flex items-center gap-3 min-w-0">
				<span className="font-mono text-xs uppercase tracking-wider font-semibold shrink-0">
					Chain offline
				</span>
				<span className="text-xs font-mono text-ink-500 truncate">
					Can't reach <span className="text-ink-700">{wsUrl}</span>. Data on
					this page is stale.
				</span>
			</div>
			<button
				onClick={handleRetry}
				disabled={retrying}
				className="btn-outline btn-sm shrink-0"
			>
				{retrying ? "Dialing…" : "Retry"}
			</button>
		</div>
	);
}
