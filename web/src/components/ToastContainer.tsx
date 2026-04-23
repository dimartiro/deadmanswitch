import { useToastStore, type ToastKind } from "../store/toastStore";

const KIND_STYLES: Record<ToastKind, { bar: string; title: string; icon: string }> = {
	success: {
		bar: "before:bg-neon-500",
		title: "text-neon-500",
		icon: "✓",
	},
	error: {
		bar: "before:bg-danger",
		title: "text-danger",
		icon: "✕",
	},
	info: {
		bar: "before:bg-ink-500",
		title: "text-ink-900",
		icon: "›",
	},
};

export default function ToastContainer() {
	const toasts = useToastStore((s) => s.toasts);
	const dismiss = useToastStore((s) => s.dismiss);

	if (toasts.length === 0) return null;

	return (
		<div
			className="fixed top-20 right-4 z-[100] flex flex-col gap-2 w-[min(92vw,380px)] pointer-events-none"
			role="region"
			aria-label="Notifications"
		>
			{toasts.map((t) => {
				const s = KIND_STYLES[t.kind];
				return (
					<div
						key={t.id}
						className={`relative bg-paper border border-hairline shadow-lifted px-4 py-3 animate-slide-up pointer-events-auto before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] ${s.bar}`}
						style={{ borderRadius: "3px" }}
						role="status"
						aria-live="polite"
					>
						<div className="flex items-start gap-3">
							<span className={`font-mono text-sm ${s.title} leading-5`}>
								{s.icon}
							</span>
							<div className="flex-1 min-w-0">
								<div
									className={`font-mono text-[0.78rem] uppercase tracking-wider font-semibold ${s.title}`}
								>
									{t.title}
								</div>
								{t.detail && (
									<div className="text-xs text-ink-500 mt-1 font-mono break-words">
										{t.detail}
									</div>
								)}
							</div>
							<button
								onClick={() => dismiss(t.id)}
								className="text-ink-400 hover:text-ink-900 w-5 h-5 flex items-center justify-center leading-none"
								aria-label="Dismiss"
							>
								✕
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}
