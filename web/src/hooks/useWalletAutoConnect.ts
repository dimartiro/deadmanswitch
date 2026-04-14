import { useEffect } from "react";
import {
	getInjectedExtensions,
	connectInjectedExtension,
} from "polkadot-api/pjs-signer";
import { useChainStore } from "../store/chainStore";

let reconnected = false;

async function reconnectWallet() {
	const saved = localStorage.getItem("connected-wallet");
	if (!saved || reconnected) return;

	try {
		const wallets = getInjectedExtensions();
		if (!wallets.includes(saved)) return;

		reconnected = true;
		const ext = await connectInjectedExtension(saved);
		const accounts = ext.getAccounts();
		useChainStore.getState().setWalletAccounts(
			accounts.map((a) => ({
				name: a.name || "Unnamed",
				address: a.address,
				signer: a.polkadotSigner,
				source: saved,
			})),
		);
		ext.subscribe((updated) => {
			useChainStore.getState().setWalletAccounts(
				updated.map((a) => ({
					name: a.name || "Unnamed",
					address: a.address,
					signer: a.polkadotSigner,
					source: saved,
				})),
			);
		});
	} catch (e) {
		console.error("Wallet auto-reconnect failed:", e);
	}
}

export function useWalletAutoConnect() {
	useEffect(() => {
		const saved = localStorage.getItem("connected-wallet");
		if (!saved || reconnected) return;

		// Try immediately
		reconnectWallet();

		// Also poll — extensions inject asynchronously
		const interval = setInterval(() => {
			if (reconnected) {
				clearInterval(interval);
				return;
			}
			reconnectWallet();
		}, 500);

		return () => clearInterval(interval);
	}, []);
}
