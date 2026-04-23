// Keep in sync with `blockchain/runtime/src/configs/mod.rs`.
// 1 UNIT = 10^12 planck.
export const PLANCK_PER_UNIT = 1_000_000_000_000n;
const MICRO_UNIT = 1_000_000n;
const MILLI_UNIT = 1_000_000_000n;

export const FEE_PER_BLOCK_PLANCK = 10n * MICRO_UNIT;
export const FLAT_BEQUEST_FEE_PLANCK = 10n * MILLI_UNIT;
export const PROTOCOL_FEE_PERMILL = 10_000n; // 1% = 10_000 / 1_000_000
export const PERMILL_DENOM = 1_000_000n;

export function longevityFeePlanck(blockInterval: bigint | number): bigint {
	return BigInt(blockInterval) * FEE_PER_BLOCK_PLANCK;
}

export function transferExecutionFeePlanck(amountPlanck: bigint): bigint {
	return (amountPlanck * PROTOCOL_FEE_PERMILL) / PERMILL_DENOM;
}
