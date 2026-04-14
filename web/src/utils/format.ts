import prettyMs from "pretty-ms";

/// Format seconds into a human-readable duration string.
export function formatDuration(seconds: number): string {
	return prettyMs(seconds * 1000, { compact: true });
}

/// Format a PAPI dispatch error into a human-readable string.
export function formatDispatchError(err: unknown): string {
	if (!err) return "Transaction failed";
	const e = err as { type?: string; value?: { type?: string; value?: { type?: string } } };
	if (e.type === "Module" && e.value) {
		const mod = e.value;
		return `${mod.type}.${mod.value?.type ?? ""}`.replace(/:?\s*$/, "");
	}
	return JSON.stringify(err);
}
