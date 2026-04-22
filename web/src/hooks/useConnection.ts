import { useCallback, useEffect, useRef } from "react";
import {
	getClient,
	getPeopleChainClient,
	getAssetHubClient,
	disconnectClient,
} from "./useChain";
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
		// Probe sibling parachains. If they respond in time, their
		// features are enabled; if not, we're in solo-node dev mode
		// (start-dev.sh) and related UI is hidden / bypassed.
		const setPeopleChainAvailable =
			useChainStore.getState().setPeopleChainAvailable;
		const setAssetHubAvailable =
			useChainStore.getState().setAssetHubAvailable;
		const probe = async (
			client: () => ReturnType<typeof getClient>,
			label: string,
			set: (v: boolean) => void,
		) => {
			try {
				await Promise.race([
					client().getChainSpecData(),
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error(`${label} probe timeout`)),
							5000,
						),
					),
				]);
				set(true);
			} catch {
				set(false);
			}
		};
		probe(getPeopleChainClient, "People Chain", setPeopleChainAvailable);
		probe(getAssetHubClient, "Asset Hub", setAssetHubAvailable);

		return () => {
			connectId += 1;
			disconnectClient();
		};
	}, [connect]);

	useEffect(() => {
		if (!connected) {
			return;
		}

		// Track best block. `submitAndWait` resolves on best-block
		// inclusion, and storage queries target best-block by default,
		// so the refetch driven by this subscription sees the tx's
		// state on the same tick it fires.
		const setBlockTime = useChainStore.getState().setBlockTime;
		let lastTimestamp = 0;
		const client = getClient(wsUrl);
		const subscription = client.bestBlocks$.subscribe((blocks) => {
			const best = blocks[0];
			if (!best) return;
			setBlockNumber(best.number);
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
