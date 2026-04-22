import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import {
	getDefaultWsUrl,
	PEOPLE_CHAIN_WS_URL,
	ASSET_HUB_WS_URL,
} from "../config/network";

// Multiple clients keyed by WebSocket URL. Estate Protocol
// (ws://…:9944) and People Chain (ws://…:9946) are both online at once
// during local dev, so the previous single-client cache was wrong — it
// tore down one connection whenever you switched chains.
const clients = new Map<string, PolkadotClient>();

export function getClient(wsUrl?: string): PolkadotClient {
	const url = wsUrl || getDefaultWsUrl();
	let client = clients.get(url);
	if (!client) {
		client = createClient(withPolkadotSdkCompat(getWsProvider(url)));
		clients.set(url, client);
	}
	return client;
}

/// Convenience accessor for the People Chain client.
export function getPeopleChainClient(): PolkadotClient {
	return getClient(PEOPLE_CHAIN_WS_URL);
}

/// Convenience accessor for the Asset Hub client.
export function getAssetHubClient(): PolkadotClient {
	return getClient(ASSET_HUB_WS_URL);
}

export function disconnectClient(wsUrl?: string) {
	if (wsUrl) {
		const client = clients.get(wsUrl);
		if (client) {
			client.destroy();
			clients.delete(wsUrl);
		}
	} else {
		for (const client of clients.values()) {
			client.destroy();
		}
		clients.clear();
	}
}
