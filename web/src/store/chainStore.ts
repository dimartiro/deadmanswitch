import { create } from "zustand";
import { getStoredWsUrl } from "../config/network";

interface ChainState {
	wsUrl: string;
	connected: boolean;
	blockNumber: number;
	selectedAccount: number;
	txStatus: string | null;
	setWsUrl: (url: string) => void;
	setConnected: (connected: boolean) => void;
	setBlockNumber: (blockNumber: number) => void;
	setSelectedAccount: (index: number) => void;
	setTxStatus: (status: string | null) => void;
}

export const useChainStore = create<ChainState>((set) => ({
	wsUrl: getStoredWsUrl(),
	connected: false,
	blockNumber: 0,
	selectedAccount: 0,
	txStatus: null,
	setWsUrl: (wsUrl) => {
		localStorage.setItem("ws-url", wsUrl);
		set({ wsUrl });
	},
	setConnected: (connected) => set({ connected }),
	setBlockNumber: (blockNumber) => set({ blockNumber }),
	setSelectedAccount: (index) => set({ selectedAccount: index }),
	setTxStatus: (txStatus) => set({ txStatus }),
}));
