import { useCallback, useEffect, useRef } from "react";
import { getClient, getPeopleChainClient, disconnectClient } from "./useChain";
import { useChainStore } from "../store/chainStore";

let connectId = 0;

export function useConnection() {
	const setWsUrl = useChainStore((state) => state.setWsUrl);
	const setConnected = useChainStore((state) => state.setConnected);
	const setBlockNumber = useChainStore((state) => state.setBlockNumber);

	const connect = useCallback(
		async (url: string) => {
			const id = ++connectId;
			setWsUrl(url);
			setConnected(false);
			setBlockNumber(0);

			try {
				const client = getClient(url);
				const chain = await Promise.race([
					client.getChainSpecData(),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("Connection timed out")), 10000),
					),
				]);

				if (connectId !== id) return { ok: false, chain: null };

				setConnected(true);
				return { ok: true, chain };
			} catch (e) {
				if (connectId !== id) return { ok: false, chain: null };
				setConnected(false);
				setBlockNumber(0);
				throw e;
			}
		},
		[setBlockNumber, setConnected, setWsUrl],
	);

	return { connect };
}

export function useConnectionManagement() {
	const wsUrl = useChainStore((state) => state.wsUrl);
	const connected = useChainStore((state) => state.connected);
	const setBlockNumber = useChainStore((state) => state.setBlockNumber);
	const { connect } = useConnection();
	const initialWsUrlRef = useRef(wsUrl);

	useEffect(() => {
		connect(initialWsUrlRef.current).catch(() => {});
		// Warm up the People Chain client in parallel so identity queries
		// are ready the first time a user hits the Identity page.
		try {
			getPeopleChainClient();
		} catch {
			// If People Chain isn't running we fail gracefully on demand.
		}

		return () => {
			connectId += 1;
			disconnectClient();
		};
	}, [connect]);

	useEffect(() => {
		if (!connected) {
			return;
		}

		// Track finalized block. Since submit waits for finality, the
		// refetch driven by this subscription is guaranteed to see the
		// submitted tx's state the moment it fires.
		const setBlockTime = useChainStore.getState().setBlockTime;
		let lastTimestamp = 0;
		const client = getClient(wsUrl);
		const subscription = client.finalizedBlock$.subscribe((block) => {
			setBlockNumber(block.number);
			const now = Date.now();
			if (lastTimestamp > 0) {
				const elapsed = (now - lastTimestamp) / 1000;
				if (elapsed > 0.5 && elapsed < 30) {
					setBlockTime(Math.round(elapsed));
				}
			}
			lastTimestamp = now;
		});

		return () => {
			subscription.unsubscribe();
		};
	}, [connected, setBlockNumber, wsUrl]);
}
