import prettyMs from "pretty-ms";
import { devAccounts } from "../hooks/useAccount";

const PLANCK_PER_UNIT = 1_000_000_000_000n;

/// Format seconds into a human-readable duration string.
export function formatDuration(seconds: number): string {
	if (seconds <= 0) return "0s";
	return prettyMs(seconds * 1000, {
		secondsDecimalDigits: 0,
		unitCount: 2,
	});
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

/// Format a planck amount with full precision and no unit suffix.
/// Whole part uses locale grouping (1,234,567).
export function formatBalance(planck: bigint): string {
	const whole = planck / PLANCK_PER_UNIT;
	const frac = planck % PLANCK_PER_UNIT;
	if (frac === 0n) return whole.toLocaleString();
	const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
	return `${whole.toLocaleString()}.${fracStr}`;
}

/// Format a planck amount truncated to 4 fractional digits.
export function formatBalanceShort(planck: bigint): string {
	const whole = planck / PLANCK_PER_UNIT;
	const frac = planck % PLANCK_PER_UNIT;
	if (frac === 0n) return whole.toLocaleString();
	const fracStr = frac.toString().padStart(12, "0").slice(0, 4);
	return `${whole.toLocaleString()}.${fracStr.replace(/0+$/, "") || "0"}`;
}

/// Format a planck amount with a `ROC` unit suffix. Whole part uses
/// simple `toString` (no locale grouping) so it reads tightly inside
/// instruction labels like "Transfer 100 ROC to Bob".
export function formatBalanceWithUnit(planck: bigint): string {
	const whole = planck / PLANCK_PER_UNIT;
	const frac = planck % PLANCK_PER_UNIT;
	if (frac === 0n) return `${whole} ROC`;
	const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
	return `${whole}.${fracStr} ROC`;
}

/// Shorten an SS58 address to `5Grwva…gjgY` for inline display.
export function truncateAddress(addr: string): string {
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/// Resolve an address to a dev account name if known, else fall back
/// to a truncated SS58. Used to make will/certificate rows readable
/// without scanning the full address.
export function accountLabel(addr: string): string {
	const dev = devAccounts.find((a) => a.address === addr);
	return dev ? dev.name : truncateAddress(addr);
}
