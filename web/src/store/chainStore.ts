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
	blockNumber: number;
	blockTime: number; // seconds per block (estimated)
	selectedAccount: number;
	txStatus: string | null;
	walletAccounts: WalletAccount[];
	setWsUrl: (url: string) => void;
	setConnected: (connected: boolean) => void;
	setBlockNumber: (blockNumber: number) => void;
	setBlockTime: (seconds: number) => void;
	setSelectedAccount: (index: number) => void;
	setTxStatus: (status: string | null) => void;
	setWalletAccounts: (accounts: WalletAccount[]) => void;
}

export const useChainStore = create<ChainState>((set) => ({
	wsUrl: getStoredWsUrl(),
	connected: false,
	blockNumber: 0,
	blockTime: 6,
	selectedAccount: 0,
	txStatus: null,
	walletAccounts: [],
	setWsUrl: (wsUrl) => {
		localStorage.setItem("ws-url", wsUrl);
		set({ wsUrl });
	},
	setConnected: (connected) => set({ connected }),
	setBlockNumber: (blockNumber) => set({ blockNumber }),
	setBlockTime: (blockTime) => set({ blockTime }),
	setSelectedAccount: (index) => set({ selectedAccount: index }),
	setTxStatus: (txStatus) => set({ txStatus }),
	setWalletAccounts: (walletAccounts) => set({ walletAccounts }),
}));
