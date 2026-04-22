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
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function accountLabel(addr: string): string {
	const dev = devAccounts.find((a) => a.address === addr);
	return dev ? dev.name : truncateAddress(addr);
}
function formatBalanceUnit(planck: bigint): string {
	const whole = planck / 1_000_000_000_000n;
	const frac = planck % 1_000_000_000_000n;
	if (frac === 0n) return whole.toString() + " ROC";
	const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
	return `${whole}.${fracStr} ROC`;
}

function renderReceivedBequest(bequest: Bequest, owner?: string): string {
	const from = owner ? accountLabel(owner) : "the owner";
	const type = bequest.type as string;
	const value = bequest.value;
	switch (type) {
		case "Transfer":
			return `Received ${formatBalanceUnit(value.amount)} from ${from}`;
		case "TransferAll":
			return `Received ${from}'s entire Asset Hub balance`;
		case "Proxy":
			return `Granted proxy over ${from}'s Asset Hub account`;
		case "MultisigProxy":
			return `Granted ${value.threshold}-of-${value.delegates.length} multisig proxy over ${from}'s Asset Hub account`;
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
			const cid =
				await api.query.EstateExecutor.CertificateCollectionId.getValue({
					at: "best",
				});
			setCollectionId(cid ?? null);
			if (cid === undefined) {
				setCertificates([]);
				return;
			}
			const [entries, willEntries, bequestEntries] = await Promise.all([
				api.query.Nfts.Account.getEntries(selected.address, cid, {
					at: "best",
				}),
				api.query.EstateExecutor.Wills.getEntries({ at: "best" }),
				api.query.EstateExecutor.WillBequests.getEntries({ at: "best" }),
			]);

			const bequestsByWill = new Map<string, Bequest[]>();
			for (const entry of bequestEntries) {
				bequestsByWill.set(String(entry.keyArgs[0]), entry.value as Bequest[]);
			}

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
			items.sort((a, b) => (b.executedBlock ?? 0) - (a.executedBlock ?? 0));
			setCertificates(items);
		} finally {
			setLoading(false);
		}
	}, [connected, wsUrl, selected?.address]);

	useEffect(() => {
		fetchCertificates();
	}, [fetchCertificates, blockNumber]);

	return (
		<div className="space-y-8 stagger">
			{/* Header */}
			<div>
				<div className="eyebrow mb-1">Inheritance</div>
				<h1 className="h-display text-4xl md:text-5xl">
					Your <span className="italic text-amber-500">certificates</span>
				</h1>
				<p className="text-sm text-ink-500 mt-2">
					Permanent, non-transferable proofs that a will naming you as a
					beneficiary has executed. Minted as soulbound NFTs on Estate
					Protocol.
				</p>
			</div>

			{/* Viewing as */}
			<section className="card-padded">
				<div className="flex items-center justify-between flex-wrap gap-4">
					<div>
						<div className="eyebrow mb-1">Viewing as</div>
						<div className="flex flex-wrap gap-2">
							{accounts.map((acc, i) => (
								<button
									key={acc.address}
									onClick={() =>
										useChainStore.getState().setSelectedAccount(i)
									}
									className={`text-sm px-3 py-1.5 rounded-full transition-all ${
										selectedAccount === i
											? "bg-ink-900 text-canvas shadow-soft"
											: "bg-muted text-ink-700 hover:bg-mist"
									}`}
								>
									{acc.name}
								</button>
							))}
						</div>
					</div>
				</div>
				{selected && (
					<p className="text-xs text-ink-400 font-mono mt-3">
						{selected.address}
					</p>
				)}
			</section>

			{/* Certificates */}
			<section>
				{loading && (
					<div className="card-padded text-center text-sm text-ink-500 py-10">
						Loading certificates…
					</div>
				)}

				{!loading &&
					(collectionId === null || certificates.length === 0) && (
						<div className="card-padded text-center py-16 bg-gradient-to-br from-amber-500/10 to-paper">
							<div className="text-5xl mb-3">🏅</div>
							<h3 className="h-section mb-1">No certificates yet</h3>
							<p className="text-sm text-ink-500 max-w-sm mx-auto">
								Certificates appear here when a will naming you as a
								beneficiary executes.
							</p>
						</div>
					)}

				{certificates.length > 0 && (
					<div className="grid md:grid-cols-2 gap-4">
						{certificates.map((cert) => (
							<CertificateCard
								key={cert.itemId}
								cert={cert}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function CertificateCard({ cert }: { cert: Certificate }) {
	return (
		<article className="relative rounded-2xl overflow-hidden bg-paper border border-hairline shadow-soft hover:shadow-card transition-shadow">
			{/* Ribbon strip */}
			<div className="absolute top-0 right-0 bottom-0 w-1 bg-gradient-to-b from-amber-400 via-amber-500 to-amber-600" />

			{/* Header strip */}
			<div className="bg-gradient-to-br from-amber-500/8 via-paper to-neon-500/5 px-6 py-6 border-b border-hairline">
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="eyebrow text-amber-500 mb-2">Soulbound record</div>
						<h3 className="h-display text-3xl md:text-4xl leading-tight">
							Execution <span className="italic text-amber-500">Certificate</span>
						</h3>
					</div>
					<div className="shrink-0 w-14 h-14 rounded-full bg-gradient-to-br from-amber-400 to-amber-500 flex items-center justify-center text-xl shadow-soft">
						🏅
					</div>
				</div>
			</div>

			{/* Body */}
			<div className="px-6 py-5 space-y-4">
				{(cert.executedBlock !== undefined || cert.owner) && (
					<dl className="grid grid-cols-2 gap-4 text-sm">
						{cert.executedBlock !== undefined && (
							<div>
								<div className="eyebrow mb-0.5">Executed at</div>
								<div className="font-mono text-sm tabular">
									№{cert.executedBlock.toLocaleString()}
								</div>
							</div>
						)}
						{cert.owner && (
							<div>
								<div className="eyebrow mb-0.5">From</div>
								<div className="font-medium text-sm">
									{accountLabel(cert.owner)}
								</div>
							</div>
						)}
					</dl>
				)}

				{cert.receivedBequests.length > 0 && (
					<div className="pt-4 border-t border-hairline">
						<div className="eyebrow mb-2">You received</div>
						<ul className="space-y-1.5">
							{cert.receivedBequests.map((b, j) => (
								<li key={j} className="flex gap-2 text-sm text-ink-700">
									<span className="text-neon-500 mt-0.5">◆</span>
									<span>{renderReceivedBequest(b, cert.owner)}</span>
								</li>
							))}
						</ul>
					</div>
				)}

				<div className="flex items-center justify-between pt-4 border-t border-hairline">
					<span className="chip-brass">
						<span className="dot" />
						Soulbound
					</span>
					<span className="text-xs text-ink-400">non-transferable</span>
				</div>
			</div>
		</article>
	);
}
