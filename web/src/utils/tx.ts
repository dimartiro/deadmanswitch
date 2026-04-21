import type { PolkadotClient, PolkadotSigner } from "polkadot-api";
import { firstValueFrom } from "rxjs";
import { filter } from "rxjs/operators";
import { formatDispatchError } from "./format";

export interface TxResult {
	ok: boolean;
	block?: { number: number; hash?: string };
	dispatchError?: unknown;
	errorMessage?: string;
}

// Resolve as soon as the tx is in a best block, then block until the
// client's own `bestBlocks$` stream has reached that block number
// before returning. Step 2 matters: papi's tx watcher can fire slightly
// ahead of the chainHead subscription that drives storage queries, and
// without waiting, the caller's next refetch ends up pinned to N-1 and
// misses the mutation. On zombienet this cuts perceived tx latency
// from ~18-30s (finality) to ~2-4s (one parachain block).
export async function submitAndWait(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tx: any,
	signer: PolkadotSigner,
	client: PolkadotClient,
	opts: { timeoutMs?: number } = {},
): Promise<TxResult> {
	const timeoutMs = opts.timeoutMs ?? 60_000;

	const included = await new Promise<{
		ok: boolean;
		block: { number: number; hash?: string };
		dispatchError?: unknown;
	}>((resolve, reject) => {
		let sub: { unsubscribe: () => void } | undefined;
		const timer = setTimeout(() => {
			sub?.unsubscribe();
			reject(new Error(`tx timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		sub = tx.signSubmitAndWatch(signer).subscribe({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			next: (event: any) => {
				if (event.type === "txBestBlocksState" && event.found) {
					clearTimeout(timer);
					sub?.unsubscribe();
					resolve({
						ok: !!event.ok,
						block: {
							number: event.block?.number ?? 0,
							hash: event.block?.hash,
						},
						dispatchError: event.dispatchError,
					});
				}
			},
			error: (err: unknown) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		});
	});

	if (!included.ok) {
		return {
			ok: false,
			block: included.block,
			dispatchError: included.dispatchError,
			errorMessage: formatDispatchError(included.dispatchError),
		};
	}

	const targetNumber = included.block.number;
	try {
		await firstValueFrom(
			client.bestBlocks$.pipe(
				filter((blocks) => (blocks[0]?.number ?? 0) >= targetNumber),
			),
		);
	} catch {
		// If the observable terminates (client disconnected) we still
		// return ok — the tx was observed in a best block. The caller's
		// next refetch will surface any connection error separately.
	}

	return { ok: true, block: included.block };
}
