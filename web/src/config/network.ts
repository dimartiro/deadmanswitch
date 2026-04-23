const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export const LOCAL_WS_URL = import.meta.env.VITE_LOCAL_WS_URL || "ws://localhost:9944";

/// WebSocket endpoint for People Chain (the Polkadot system parachain
/// that hosts `pallet-identity`). Identity registration and verification
/// happen here, not on the Estate Protocol parachain.
export const PEOPLE_CHAIN_WS_URL =
	import.meta.env.VITE_PEOPLE_CHAIN_WS_URL || "ws://localhost:9946";

/// WebSocket endpoint for Asset Hub (system parachain that hosts real
/// balances + pallet-proxy). Used for the "Link Asset Hub" flow: users
/// grant Estate Protocol's sovereign account proxy rights here, and
/// remote-transfer bequests target accounts on this chain.
export const ASSET_HUB_WS_URL =
	import.meta.env.VITE_ASSET_HUB_WS_URL || "ws://localhost:9948";

export const TESTNET_WS_URL = "wss://asset-hub-paseo.dotters.network";

function isLocalHost() {
	if (typeof window === "undefined") {
		return true;
	}

	return LOCAL_HOSTS.has(window.location.hostname);
}

export function getDefaultWsUrl() {
	return import.meta.env.VITE_WS_URL || (isLocalHost() ? LOCAL_WS_URL : TESTNET_WS_URL);
}

function getStoredUrl(storageKey: string, defaultKey: string, defaultValue: string) {
	const storedValue = localStorage.getItem(storageKey);
	const previousDefault = localStorage.getItem(defaultKey);
	localStorage.setItem(defaultKey, defaultValue);

	if (!storedValue || storedValue === previousDefault) {
		return defaultValue;
	}

	return storedValue;
}

export function getStoredWsUrl() {
	return getStoredUrl("ws-url", "default-ws-url", getDefaultWsUrl());
}
