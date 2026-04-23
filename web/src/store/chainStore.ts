import { create } from "zustand";
import { getStoredWsUrl } from "../config/network";
import type { PolkadotSigner } from "polkadot-api";

export interface WalletAccount {
	name: string;
	address: string;
	signer: PolkadotSigner;
	source: string;
}

interface ChainState {
	wsUrl: string;
	connected: boolean;
	// True once the first connect() attempt at mount has resolved either
	// way. Used to avoid flashing an "offline" banner during the initial
	// dial before we know if the node is reachable.
	initialConnectComplete: boolean;
	blockNumber: number;
	blockTime: number; // seconds per block (estimated)
	selectedAccount: number;
	txStatus: string | null;
	walletAccounts: WalletAccount[];
	// `null` = not checked yet; `true` = People Chain responded;
	// `false` = unreachable, and we're running in solo-node dev mode.
	// When false, identity checks are bypassed (isVerified is always true).
	peopleChainAvailable: boolean | null;
	// Same pattern for Asset Hub. When false, the "Link Asset Hub" UI
	// is hidden and remote-transfer bequests are disabled.
	assetHubAvailable: boolean | null;
	setWsUrl: (url: string) => void;
	setConnected: (connected: boolean) => void;
	setInitialConnectComplete: (done: boolean) => void;
	setBlockNumber: (blockNumber: number) => void;
	setBlockTime: (seconds: number) => void;
	setSelectedAccount: (index: number) => void;
	setTxStatus: (status: string | null) => void;
	setWalletAccounts: (accounts: WalletAccount[]) => void;
	setPeopleChainAvailable: (available: boolean) => void;
	setAssetHubAvailable: (available: boolean) => void;
}

export const useChainStore = create<ChainState>((set) => ({
	wsUrl: getStoredWsUrl(),
	connected: false,
	initialConnectComplete: false,
	blockNumber: 0,
	blockTime: 6,
	selectedAccount: 0,
	txStatus: null,
	walletAccounts: [],
	peopleChainAvailable: null,
	assetHubAvailable: null,
	setWsUrl: (wsUrl) => {
		localStorage.setItem("ws-url", wsUrl);
		set({ wsUrl });
	},
	setConnected: (connected) => set({ connected }),
	setInitialConnectComplete: (initialConnectComplete) =>
		set({ initialConnectComplete }),
	setBlockNumber: (blockNumber) => set({ blockNumber }),
	setBlockTime: (blockTime) => set({ blockTime }),
	setSelectedAccount: (index) => set({ selectedAccount: index }),
	setTxStatus: (txStatus) => set({ txStatus }),
	setWalletAccounts: (walletAccounts) => set({ walletAccounts }),
	setPeopleChainAvailable: (peopleChainAvailable) =>
		set({ peopleChainAvailable }),
	setAssetHubAvailable: (assetHubAvailable) => set({ assetHubAvailable }),
}));
