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
		const setInitialConnectComplete =
			useChainStore.getState().setInitialConnectComplete;
		connect(initialWsUrlRef.current)
			.catch(() => {})
			.finally(() => setInitialConnectComplete(true));
		// Probe sibling parachains. If they respond in time, their
		// features are enabled; if not (e.g. remote node without
		// HRMP), the related UI is hidden / bypassed.
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
		//
		// Average the block time over the last 50 observed intervals so
		// UI countdowns stay stable across occasional slow/fast blocks.
		// Default to 6s until we've collected enough samples.
		//
		// `bestBlocks$` can emit multiple times per block (e.g. when
		// forks resolve) so we only recompute intervals when the block
		// number actually advances, and normalise by blocks advanced in
		// case several parachain blocks get imported in a burst.
		const setBlockTime = useChainStore.getState().setBlockTime;
		const WINDOW_SIZE = 50;
		const intervals: number[] = [];
		let lastBlockNumber = -1;
		let lastTimestamp = 0;
		const client = getClient(wsUrl);
		const subscription = client.bestBlocks$.subscribe((blocks) => {
			const best = blocks[0];
			if (!best) return;
			setBlockNumber(best.number);
			if (best.number <= lastBlockNumber) return;
			const now = Date.now();
			if (lastTimestamp > 0) {
				const advanced = best.number - lastBlockNumber;
				const perBlock = (now - lastTimestamp) / 1000 / advanced;
				if (perBlock > 0.1 && perBlock < 60) {
					intervals.push(perBlock);
					if (intervals.length > WINDOW_SIZE) intervals.shift();
					const avg =
						intervals.reduce((a, b) => a + b, 0) / intervals.length;
					setBlockTime(Math.max(1, Math.round(avg)));
				}
			}
			lastBlockNumber = best.number;
			lastTimestamp = now;
		});

		return () => {
			subscription.unsubscribe();
		};
	}, [connected, setBlockNumber, wsUrl]);
}
