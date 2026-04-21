import { stack_template } from "@polkadot-api/descriptors";
import { blake2b256, ss58Decode } from "@polkadot-labs/hdkd-helpers";
import { useCallback, useEffect, useState } from "react";
import { devAccounts } from "../hooks/useAccount";
import { useAllAccounts } from "../hooks/useAllAccounts";
import { getClient } from "../hooks/useChain";
import { useChainStore } from "../store/chainStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bequest = any;

interface Certificate {
	itemId: number;
	collectionId: number;
	executedBlock?: number;
	owner?: string;
	receivedBequests: Bequest[];
}

function truncateAddress(addr: string): string {
	return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function accountLabel(addr: string): string {
	const dev = devAccounts.find((a) => a.address === addr);
	return dev ? dev.name : truncateAddress(addr);
}

function formatBalanceUnit(planck: bigint): string {
	const whole = planck / 1_000_000_000_000n;
	const frac = planck % 1_000_000_000_000n;
	if (frac === 0n) return whole.toString() + " UNIT";
	const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
	return `${whole}.${fracStr} UNIT`;
}

function renderReceivedBequest(bequest: Bequest, owner?: string): string {
	const from = owner ? accountLabel(owner) : "the owner";
	const type = bequest.type as string;
	const value = bequest.value;
	switch (type) {
		case "Transfer":
			return `Received ${formatBalanceUnit(value.amount)} from ${from}`;
		case "TransferAll":
			return `Received ${from}'s entire free balance`;
		case "Proxy":
			return `Granted proxy access to ${from}'s account`;
		case "MultisigProxy":
			return `Granted multisig proxy (${value.threshold} of ${value.delegates.length}) to ${from}'s account`;
		default:
			return `Unknown bequest (${type})`;
	}
}

function bequestRecipients(bequest: Bequest): string[] {
	const type = bequest.type as string;
	const value = bequest.value;
	switch (type) {
		case "Transfer":
		case "TransferAll":
			return [value.dest as string];
		case "Proxy":
			return [value.delegate as string];
		case "MultisigProxy":
			return value.delegates as string[];
		default:
			return [];
	}
}

// Mirrors the runtime's item_id derivation:
//   blake2_256(SCALE::encode((will_id: u64, &beneficiary: AccountId32)))[..4]
//   interpreted as u32 LE.
function deriveItemId(willId: bigint, address: string): number {
	const [pubkey] = ss58Decode(address);
	const buf = new Uint8Array(8 + pubkey.length);
	const view = new DataView(buf.buffer);
	view.setBigUint64(0, willId, true);
	buf.set(pubkey, 8);
	const digest = blake2b256(buf);
	return new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, true);
}

export default function CertificatesPage() {
	const { wsUrl, connected, selectedAccount, blockNumber } = useChainStore();
	const { accounts, selected } = useAllAccounts();
	const [collectionId, setCollectionId] = useState<number | null>(null);
	const [certificates, setCertificates] = useState<Certificate[]>([]);
	const [loading, setLoading] = useState(false);

	const fetchCertificates = useCallback(async () => {
		if (!connected || !selected) {
			setCertificates([]);
			return;
		}
		setLoading(true);
		try {
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const cid = await api.query.EstateExecutor.CertificateCollectionId.getValue();
			setCollectionId(cid ?? null);
			if (cid === undefined) {
				setCertificates([]);
				return;
			}
			// Nfts.Account is keyed (owner, collection, item) and stores
			// ownership. Query entries under (owner, collection) to list
			// the items held by the current account in that collection.
			const [entries, willEntries, bequestEntries] = await Promise.all([
				api.query.Nfts.Account.getEntries(selected.address, cid),
				api.query.EstateExecutor.Wills.getEntries(),
				api.query.EstateExecutor.WillBequests.getEntries(),
			]);

			const bequestsByWill = new Map<string, Bequest[]>();
			for (const entry of bequestEntries) {
				bequestsByWill.set(String(entry.keyArgs[0]), entry.value as Bequest[]);
			}

			// Build item_id → (will data, received bequests) map over every
			// executed will that names the current account. When the mint
			// succeeds for a (will, beneficiary) pair, item_id is
			// deterministic, so we can look up what the certificate
			// represents without reading an index off-chain.
			const itemIdToWill = new Map<
				number,
				{ executedBlock: number; owner: string; received: Bequest[] }
			>();
			for (const entry of willEntries) {
				const will = entry.value;
				const status = (will.status as { type: string }).type;
				if (status !== "Executed") continue;
				const willId = entry.keyArgs[0] as bigint;
				const bequests = bequestsByWill.get(String(willId)) ?? [];
				const received = bequests.filter((b) =>
					bequestRecipients(b).includes(selected.address),
				);
				if (received.length === 0) continue;
				const itemId = deriveItemId(willId, selected.address);
				itemIdToWill.set(itemId, {
					executedBlock: Number(will.executed_block),
					owner: will.owner as string,
					received,
				});
			}

			const items: Certificate[] = entries.map(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(e: any) => {
					const itemId = Number(e.keyArgs[2]);
					const match = itemIdToWill.get(itemId);
					return {
						itemId,
						collectionId: Number(e.keyArgs[1]),
						executedBlock: match?.executedBlock,
						owner: match?.owner,
						receivedBequests: match?.received ?? [],
					};
				},
			);
			items.sort((a, b) => (a.executedBlock ?? 0) - (b.executedBlock ?? 0));
			setCertificates(items);
		} finally {
			setLoading(false);
		}
	}, [connected, wsUrl, selected?.address]);

	useEffect(() => {
		fetchCertificates();
	}, [fetchCertificates, blockNumber]);

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title">Certificates</h1>
				<p className="text-text-secondary">
					Permanent, non-transferable proofs that a will naming you as a beneficiary has
					executed. The underlying bequest might be a transfer, proxy grant, or any other
					pattern — the certificate just records that you were named.
				</p>
			</div>

			{/* Account selector */}
			<div className="card space-y-3">
				<h2 className="section-title">Viewing as</h2>
				<div className="flex flex-wrap gap-2">
					{accounts.map((acc, i) => (
						<button
							key={acc.address}
							onClick={() => useChainStore.getState().setSelectedAccount(i)}
							className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
								selectedAccount === i
									? "bg-polka-500/20 text-white border border-polka-500/30"
									: "text-text-secondary hover:text-text-primary hover:bg-white/[0.04] border border-transparent"
							}`}
						>
							{acc.name}
						</button>
					))}
				</div>
				{selected && (
					<p className="text-xs text-text-muted font-mono">
						{accountLabel(selected.address)} — {selected.address}
					</p>
				)}
			</div>

			{/* Certificates */}
			{loading && (
				<div className="card animate-pulse">
					<div className="h-4 w-48 rounded bg-white/[0.06]" />
				</div>
			)}

			{!loading && (collectionId === null || certificates.length === 0) && (
				<div className="card text-center space-y-2 py-8">
					<p className="text-4xl">🪦</p>
					<p className="text-text-secondary">No certificates yet</p>
					<p className="text-xs text-text-muted">
						Certificates appear here when a will naming you as a beneficiary executes.
					</p>
				</div>
			)}

			{certificates.length > 0 && (
				<div className="space-y-3">
					{certificates.map((cert, i) => (
						<div key={cert.itemId} className="card space-y-3">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<span className="text-2xl">🎖️</span>
									<div>
										<p className="text-base font-semibold text-text-primary">
											Execution Certificate #{i + 1}
										</p>
										<p className="text-xs text-text-muted">
											Soulbound NFT — non-transferable, permanent record of a
											will naming you as a beneficiary.
										</p>
									</div>
								</div>
								<span className="status-badge bg-accent-green/10 text-accent-green border border-accent-green/20">
									✓ soulbound
								</span>
							</div>

							{(cert.executedBlock !== undefined || cert.owner) && (
								<div className="grid grid-cols-2 gap-3 text-sm pt-3 border-t border-white/[0.06]">
									{cert.executedBlock !== undefined && (
										<div>
											<span className="text-text-muted">Executed at</span>
											<p className="font-mono text-text-primary">
												Block #{cert.executedBlock}
											</p>
										</div>
									)}
									{cert.owner && (
										<div>
											<span className="text-text-muted">From</span>
											<p className="font-medium text-text-primary">
												{accountLabel(cert.owner)}
											</p>
										</div>
									)}
								</div>
							)}

							{cert.receivedBequests.length > 0 && (
								<div className="space-y-1.5 pt-3 border-t border-white/[0.06]">
									<p className="text-xs text-text-muted uppercase tracking-wider">
										You received
									</p>
									<ul className="space-y-1">
										{cert.receivedBequests.map((b, j) => (
											<li
												key={j}
												className="text-sm text-text-primary flex gap-2"
											>
												<span className="text-accent-green">•</span>
												<span>
													{renderReceivedBequest(b, cert.owner)}
													{cert.executedBlock !== undefined && (
														<span className="text-text-muted font-mono">
															{" "}
															· block #{cert.executedBlock}
														</span>
													)}
												</span>
											</li>
										))}
									</ul>
								</div>
							)}

							<details className="text-xs text-text-muted pt-3 border-t border-white/[0.06]">
								<summary className="cursor-pointer hover:text-text-secondary">
									On-chain reference
								</summary>
								<p className="font-mono mt-1">
									pallet-nfts · collection {cert.collectionId} · item{" "}
									{cert.itemId}
								</p>
							</details>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
