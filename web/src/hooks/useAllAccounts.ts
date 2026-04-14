import { useMemo } from "react";
import { devAccounts } from "./useAccount";
import { useChainStore } from "../store/chainStore";
import type { PolkadotSigner } from "polkadot-api";

export interface UnifiedAccount {
	name: string;
	address: string;
	signer: PolkadotSigner;
	source: "dev" | "wallet";
}

export function useAllAccounts(): {
	accounts: UnifiedAccount[];
	selected: UnifiedAccount | null;
	selectedIndex: number;
} {
	const walletAccounts = useChainStore((s) => s.walletAccounts);
	const selectedAccount = useChainStore((s) => s.selectedAccount);

	const accounts = useMemo(() => {
		const devList: UnifiedAccount[] = devAccounts.map((a) => ({
			name: a.name,
			address: a.address,
			signer: a.signer,
			source: "dev",
		}));
		const walletList: UnifiedAccount[] = walletAccounts.map((a) => ({
			name: `${a.name} (${a.source})`,
			address: a.address,
			signer: a.signer,
			source: "wallet",
		}));
		return [...devList, ...walletList];
	}, [walletAccounts]);

	const selected = accounts[selectedAccount] ?? null;

	return { accounts, selected, selectedIndex: selectedAccount };
}
