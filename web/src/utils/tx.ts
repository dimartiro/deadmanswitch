import type { PolkadotSigner } from "polkadot-api";
import { formatDispatchError } from "./format";

export interface TxResult {
	ok: boolean;
	block?: { number: number };
	dispatchError?: unknown;
	errorMessage?: string;
}

/// Submit a tx and resolve once it's in a finalised block.
///
/// An earlier variant resolved on best-block inclusion for snappier dev
/// UX, but under zombienet the storage view could still be stale right
/// after the event fired — dashboards would refetch and not see the new
/// state for another block or two. We chose correctness over speed: the
/// price is ~18-30s per tx on zombienet, but everything the user sees
/// afterwards is guaranteed consistent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function submitAndWait(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tx: any,
	signer: PolkadotSigner,
): Promise<TxResult> {
	const result = await tx.signAndSubmit(signer);
	if (result.ok) {
		return {
			ok: true,
			block: { number: result.block?.number ?? 0 },
		};
	}
	return {
		ok: false,
		block: result.block ? { number: result.block.number ?? 0 } : undefined,
		dispatchError: result.dispatchError,
		errorMessage: formatDispatchError(result.dispatchError),
	};
}
