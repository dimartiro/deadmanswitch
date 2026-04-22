import { useState, useEffect, useCallback, useRef } from "react";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import {
	getClient,
	getPeopleChainClient,
	getAssetHubClient,
} from "../hooks/useChain";
import {
	stack_template,
	people_chain,
	asset_hub,
} from "@polkadot-api/descriptors";
import { submitAndWait } from "../utils/tx";
import {
	getInjectedExtensions,
	connectInjectedExtension,
	type InjectedPolkadotAccount,
} from "polkadot-api/pjs-signer";
import { Binary, FixedSizeBinary, type PolkadotSigner } from "polkadot-api";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";

const ESTATE_PARA_ID = 2000;
function estateSovereignOnAssetHub(): string {
	const buf = new Uint8Array(32);
	buf.set(new TextEncoder().encode("sibl"), 0);
	new DataView(buf.buffer).setUint32(4, ESTATE_PARA_ID, true);
	return ss58Address(buf);
}
const ESTATE_SOVEREIGN_ON_ASSETHUB = estateSovereignOnAssetHub();

interface DisplayAccount {
	name: string;
	ss58: string;
	type: "dev" | "extension";
	signer: PolkadotSigner;
}
interface AccountInfo {
	balance: bigint;
	nonce: number;
}
interface IdentityStatus {
	hasIdentity: boolean;
	display?: string;
}
interface AssetHubLinkStatus {
	linked: boolean;
	balance?: bigint;
}

function formatBalance(planck: bigint): string {
	const whole = planck / 1_000_000_000_000n;
	const frac = planck % 1_000_000_000_000n;
	if (frac === 0n) return whole.toLocaleString();
	const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
	return `${whole.toLocaleString()}.${fracStr}`;
}

function formatBalanceShort(planck: bigint): string {
	const whole = planck / 1_000_000_000_000n;
	const frac = planck % 1_000_000_000_000n;
	if (frac === 0n) return whole.toLocaleString();
	const fracStr = frac.toString().padStart(12, "0").slice(0, 4);
	return `${whole.toLocaleString()}.${fracStr.replace(/0+$/, "") || "0"}`;
}

function extractDisplayName(info: unknown): string | undefined {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const rawDisplay = (info as any)?.info?.display;
	const type = rawDisplay?.type as string | undefined;
	if (!type || !type.startsWith("Raw") || type === "Raw0") return undefined;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const bin = rawDisplay.value as any;
		if (typeof bin === "number") return String.fromCharCode(bin);
		if (bin?.asText) return bin.asText();
		if (bin instanceof Binary) return bin.asText();
	} catch {
		/* */
	}
	return undefined;
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			onClick={() => {
				navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
			className="text-xs text-ink-400 hover:text-ink-700 transition-colors"
		>
			{copied ? "Copied" : "Copy"}
		</button>
	);
}

export default function AccountsPage() {
	const {
		wsUrl,
		connected,
		blockNumber,
		peopleChainAvailable,
		assetHubAvailable,
	} = useChainStore();
	const bypassIdentity = peopleChainAvailable === false;
	const showAssetHub = assetHubAvailable === true;
	const extensionUnsubscribeRef = useRef<(() => void) | null>(null);
	const [availableWallets, setAvailableWallets] = useState<string[]>([]);
	const [extensionAccounts, setExtensionAccounts] = useState<InjectedPolkadotAccount[]>([]);
	const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
	const [fundStatus, setFundStatus] = useState<string | null>(null);
	const [fundAmount, setFundAmount] = useState("10000");
	const [accountInfos, setAccountInfos] = useState<Record<string, AccountInfo>>({});
	const [identityStatuses, setIdentityStatuses] = useState<Record<string, IdentityStatus>>({});
	const [identityActionStatus, setIdentityActionStatus] = useState<Record<string, string>>({});
	const [assetHubLinks, setAssetHubLinks] = useState<Record<string, AssetHubLinkStatus>>({});
	const [linkActionStatus, setLinkActionStatus] = useState<Record<string, string>>({});

	const devDisplayAccounts: DisplayAccount[] = devAccounts.map((acc) => ({
		name: acc.name,
		ss58: acc.address,
		type: "dev",
		signer: acc.signer,
	}));

	const allAddresses = [
		...devAccounts.map((a) => a.address),
		...extensionAccounts.map((a) => a.address),
	];

	const fetchAccountInfos = useCallback(async () => {
		if (!connected || allAddresses.length === 0) return;
		try {
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const infos: Record<string, AccountInfo> = {};
			for (const addr of allAddresses) {
				try {
					const info = await api.query.System.Account.getValue(addr, {
						at: "best",
					});
					infos[addr] = { balance: info.data.free, nonce: info.nonce };
				} catch {
					/* skip */
				}
			}
			setAccountInfos(infos);
		} catch (e) {
			console.error("Failed to fetch account infos:", e);
		}
	}, [connected, wsUrl, allAddresses.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

	const fetchIdentities = useCallback(async () => {
		if (allAddresses.length === 0) return;
		if (bypassIdentity) {
			setIdentityStatuses({});
			return;
		}
		try {
			const client = getPeopleChainClient();
			const api = client.getTypedApi(people_chain);
			const results = await Promise.all(
				allAddresses.map(async (addr) => {
					try {
						const info = await api.query.Identity.IdentityOf.getValue(addr, {
							at: "best",
						});
						const hasIdentity = info !== undefined;
						const display = hasIdentity ? extractDisplayName(info) : undefined;
						return [addr, { hasIdentity, display }] as const;
					} catch {
						return [addr, { hasIdentity: false }] as const;
					}
				}),
			);
			setIdentityStatuses(Object.fromEntries(results));
		} catch {
			/* */
		}
	}, [allAddresses.join(","), bypassIdentity]); // eslint-disable-line react-hooks/exhaustive-deps

	const fetchAssetHubLinks = useCallback(async () => {
		if (allAddresses.length === 0) return;
		if (!showAssetHub) {
			setAssetHubLinks({});
			return;
		}
		try {
			const client = getAssetHubClient();
			const api = client.getTypedApi(asset_hub);
			const results = await Promise.all(
				allAddresses.map(async (addr) => {
					try {
						const [proxiesEntry, account] = await Promise.all([
							api.query.Proxy.Proxies.getValue(addr, { at: "best" }),
							api.query.System.Account.getValue(addr, { at: "best" }),
						]);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const [delegates] = proxiesEntry as any;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const linked = (delegates as any[]).some(
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							(d: any) => d.delegate === ESTATE_SOVEREIGN_ON_ASSETHUB,
						);
						return [
							addr,
							{ linked, balance: account.data.free as bigint },
						] as const;
					} catch {
						return [addr, { linked: false }] as const;
					}
				}),
			);
			setAssetHubLinks(Object.fromEntries(results));
		} catch {
			/* */
		}
	}, [allAddresses.join(","), showAssetHub]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		fetchAccountInfos();
	}, [fetchAccountInfos, blockNumber]);
	useEffect(() => {
		fetchIdentities();
	}, [fetchIdentities, blockNumber]);
	useEffect(() => {
		fetchAssetHubLinks();
	}, [fetchAssetHubLinks, blockNumber]);

	useEffect(() => {
		try {
			const wallets = getInjectedExtensions();
			setAvailableWallets(wallets);
			const saved = localStorage.getItem("connected-wallet");
			if (saved && wallets.includes(saved)) {
				connectWallet(saved);
			}
		} catch {
			/* */
		}
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	async function connectWallet(name: string) {
		try {
			const ext = await connectInjectedExtension(name);
			const accounts = ext.getAccounts();
			setExtensionAccounts(accounts);
			setConnectedWallet(name);
			localStorage.setItem("connected-wallet", name);
			syncWalletAccounts(accounts, name);
			extensionUnsubscribeRef.current?.();
			extensionUnsubscribeRef.current = ext.subscribe((updated) => {
				setExtensionAccounts(updated);
				syncWalletAccounts(updated, name);
			});
		} catch (e) {
			console.error("Failed to connect wallet:", e);
			setFundStatus(`Error connecting wallet: ${e instanceof Error ? e.message : e}`);
		}
	}

	function syncWalletAccounts(accounts: InjectedPolkadotAccount[], source: string) {
		useChainStore.getState().setWalletAccounts(
			accounts.map((a) => ({
				name: a.name || "Unnamed",
				address: a.address,
				signer: a.polkadotSigner,
				source,
			})),
		);
	}

	function disconnectWallet() {
		extensionUnsubscribeRef.current?.();
		extensionUnsubscribeRef.current = null;
		setExtensionAccounts([]);
		setConnectedWallet(null);
		localStorage.removeItem("connected-wallet");
		useChainStore.getState().setWalletAccounts([]);
	}

	useEffect(() => {
		return () => {
			extensionUnsubscribeRef.current?.();
		};
	}, []);

	async function fundAccount(ss58Address: string, accountName: string) {
		if (!connected) {
			setFundStatus("Error: Not connected to chain");
			return;
		}
		try {
			const amount = BigInt(fundAmount) * 1_000_000_000_000n;
			setFundStatus(`Funding ${accountName}…`);
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const aliceSigner = devAccounts[0].signer;
			const tx = api.tx.Sudo.sudo({
				call: api.tx.Balances.force_set_balance({
					who: { type: "Id", value: ss58Address },
					new_free: amount,
				}).decodedCall,
			});
			const result = await submitAndWait(tx, aliceSigner, client);
			if (!result.ok) {
				setFundStatus(`Error: ${result.errorMessage ?? "unknown"}`);
				return;
			}
			setFundStatus(`Funded ${accountName} with ${fundAmount} tokens`);
			fetchAccountInfos();
		} catch (e) {
			console.error("Fund failed:", e);
			setFundStatus(`Error: ${e instanceof Error ? e.message : e}`);
		}
	}

	async function registerIdentity(acc: DisplayAccount) {
		const key = `reg-${acc.ss58}`;
		setIdentityActionStatus((s) => ({ ...s, [key]: "Submitting…" }));
		try {
			const client = getPeopleChainClient();
			const api = client.getTypedApi(people_chain);
			const displayName = acc.name.slice(0, 32);
			const bytes = new TextEncoder().encode(displayName).slice(0, 32);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let display: any;
			if (bytes.length === 0) display = { type: "None", value: undefined };
			else if (bytes.length === 1) display = { type: "Raw1", value: bytes[0] };
			else
				display = {
					type: `Raw${bytes.length}`,
					value: FixedSizeBinary.fromBytes(bytes),
				};
			const none = { type: "None" as const, value: undefined };
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const info: any = {
				display,
				legal: none,
				web: none,
				matrix: none,
				email: none,
				pgp_fingerprint: undefined,
				image: none,
				twitter: none,
				github: none,
				discord: none,
			};
			const tx = api.tx.Identity.set_identity({ info });
			const result = await submitAndWait(tx, acc.signer, client);
			if (result.ok) {
				setIdentityActionStatus((s) => ({ ...s, [key]: "Registered" }));
				fetchIdentities();
			} else {
				setIdentityActionStatus((s) => ({
					...s,
					[key]: `Error: ${result.errorMessage ?? "unknown"}`,
				}));
			}
		} catch (e) {
			setIdentityActionStatus((s) => ({
				...s,
				[key]: `Error: ${e instanceof Error ? e.message : String(e)}`,
			}));
		}
	}

	async function clearIdentity(acc: DisplayAccount) {
		const key = `clr-${acc.ss58}`;
		setIdentityActionStatus((s) => ({ ...s, [key]: "Submitting…" }));
		try {
			const client = getPeopleChainClient();
			const api = client.getTypedApi(people_chain);
			const tx = api.tx.Identity.clear_identity();
			const result = await submitAndWait(tx, acc.signer, client);
			if (result.ok) {
				setIdentityActionStatus((s) => ({ ...s, [key]: "Cleared" }));
				fetchIdentities();
			} else {
				setIdentityActionStatus((s) => ({
					...s,
					[key]: `Error: ${result.errorMessage ?? "unknown"}`,
				}));
			}
		} catch (e) {
			setIdentityActionStatus((s) => ({
				...s,
				[key]: `Error: ${e instanceof Error ? e.message : String(e)}`,
			}));
		}
	}

	async function linkAssetHub(acc: DisplayAccount) {
		const key = `link-${acc.ss58}`;
		setLinkActionStatus((s) => ({ ...s, [key]: "Submitting…" }));
		try {
			const client = getAssetHubClient();
			const api = client.getTypedApi(asset_hub);
			const tx = api.tx.Proxy.add_proxy({
				delegate: { type: "Id", value: ESTATE_SOVEREIGN_ON_ASSETHUB },
				proxy_type: { type: "Any", value: undefined },
				delay: 0,
			});
			const result = await submitAndWait(tx, acc.signer, client);
			if (result.ok) {
				setLinkActionStatus((s) => ({ ...s, [key]: "Linked" }));
				fetchAssetHubLinks();
			} else {
				setLinkActionStatus((s) => ({
					...s,
					[key]: `Error: ${result.errorMessage ?? "unknown"}`,
				}));
			}
		} catch (e) {
			setLinkActionStatus((s) => ({
				...s,
				[key]: `Error: ${e instanceof Error ? e.message : String(e)}`,
			}));
		}
	}

	async function unlinkAssetHub(acc: DisplayAccount) {
		const key = `unlink-${acc.ss58}`;
		setLinkActionStatus((s) => ({ ...s, [key]: "Submitting…" }));
		try {
			const client = getAssetHubClient();
			const api = client.getTypedApi(asset_hub);
			const tx = api.tx.Proxy.remove_proxy({
				delegate: { type: "Id", value: ESTATE_SOVEREIGN_ON_ASSETHUB },
				proxy_type: { type: "Any", value: undefined },
				delay: 0,
			});
			const result = await submitAndWait(tx, acc.signer, client);
			if (result.ok) {
				setLinkActionStatus((s) => ({ ...s, [key]: "Unlinked" }));
				fetchAssetHubLinks();
			} else {
				setLinkActionStatus((s) => ({
					...s,
					[key]: `Error: ${result.errorMessage ?? "unknown"}`,
				}));
			}
		} catch (e) {
			setLinkActionStatus((s) => ({
				...s,
				[key]: `Error: ${e instanceof Error ? e.message : String(e)}`,
			}));
		}
	}

	const walletNames: Record<string, string> = {
		"polkadot-js": "Polkadot.js",
		"subwallet-js": "SubWallet",
		talisman: "Talisman",
	};

	return (
		<div className="space-y-8 stagger">
			<div className="flex items-end justify-between gap-4 flex-wrap">
				<div>
					<div className="eyebrow mb-1">Keys</div>
					<h1 className="h-display text-4xl md:text-5xl">
						Your <span className="italic text-estate-500">accounts</span>
					</h1>
					<p className="text-sm text-ink-500 mt-2 max-w-xl">
						Manage dev accounts, connect browser wallets, register on-chain
						identities and link each account to Asset Hub for XCM flows.
					</p>
				</div>
				<div className="flex items-end gap-2">
					<div>
						<label className="eyebrow mb-1 block">Fund amount</label>
						<input
							type="number"
							value={fundAmount}
							onChange={(e) => setFundAmount(e.target.value)}
							className="input-mono w-32"
						/>
					</div>
					<button onClick={fetchAccountInfos} className="btn-outline">
						Refresh
					</button>
				</div>
			</div>

			{fundStatus && (
				<div
					className={
						fundStatus.startsWith("Error") ? "alert-danger" : "alert-positive"
					}
				>
					{fundStatus}
				</div>
			)}

			{bypassIdentity && (
				<div className="alert-caution">
					<p className="font-medium">Identity support disabled</p>
					<p className="text-xs opacity-80 mt-1">
						People Chain isn't reachable at{" "}
						<span className="font-mono">ws://localhost:9946</span>. Identity
						registration is hidden and checks are bypassed when creating
						wills.
					</p>
				</div>
			)}

			{/* DEV ACCOUNTS */}
			<section>
				<SectionHeader
					eyebrow="Dev"
					title="Development accounts"
					subtitle="Pre-funded accounts from the well-known Substrate dev seed."
				/>
				<div className="space-y-3">
					{devDisplayAccounts.map((acc) => (
						<AccountCard
							key={acc.ss58}
							account={acc}
							info={accountInfos[acc.ss58]}
							identity={identityStatuses[acc.ss58]}
							identityActionStatus={identityActionStatus}
							connected={connected}
							showIdentity={!bypassIdentity}
							showAssetHub={showAssetHub}
							link={assetHubLinks[acc.ss58]}
							linkActionStatus={linkActionStatus}
							onFund={() => fundAccount(acc.ss58, acc.name)}
							onRegisterIdentity={() => registerIdentity(acc)}
							onClearIdentity={() => clearIdentity(acc)}
							onLinkAssetHub={() => linkAssetHub(acc)}
							onUnlinkAssetHub={() => unlinkAssetHub(acc)}
						/>
					))}
				</div>
			</section>

			{/* BROWSER EXTENSIONS */}
			<section>
				<SectionHeader
					eyebrow="Wallets"
					title="Browser wallets"
					subtitle={
						connectedWallet
							? `Connected via ${walletNames[connectedWallet] ?? connectedWallet}.`
							: availableWallets.length > 0
								? "Connect a browser wallet to sign with its accounts."
								: "Install Polkadot.js, Talisman, or SubWallet to unlock this section."
					}
				/>
				{connectedWallet ? (
					<div className="space-y-3">
						<div className="card-padded flex items-center justify-between flex-wrap gap-3">
							<div className="flex items-center gap-2">
								<span className="chip-positive">
									<span className="dot" />
									{walletNames[connectedWallet] ?? connectedWallet}
								</span>
								<span className="text-sm text-ink-500">
									{extensionAccounts.length} account
									{extensionAccounts.length !== 1 ? "s" : ""}
								</span>
							</div>
							<button onClick={disconnectWallet} className="btn-outline btn-sm">
								Disconnect
							</button>
						</div>
						{extensionAccounts.map((acc) => {
							const display: DisplayAccount = {
								name: acc.name || "Unnamed",
								ss58: acc.address,
								type: "extension",
								signer: acc.polkadotSigner,
							};
							return (
								<AccountCard
									key={acc.address}
									account={display}
									info={accountInfos[acc.address]}
									identity={identityStatuses[acc.address]}
									identityActionStatus={identityActionStatus}
									connected={connected}
									showIdentity={!bypassIdentity}
									showAssetHub={showAssetHub}
									link={assetHubLinks[display.ss58]}
									linkActionStatus={linkActionStatus}
									onFund={() => fundAccount(acc.address, display.name)}
									onRegisterIdentity={() => registerIdentity(display)}
									onClearIdentity={() => clearIdentity(display)}
									onLinkAssetHub={() => linkAssetHub(display)}
									onUnlinkAssetHub={() => unlinkAssetHub(display)}
								/>
							);
						})}
					</div>
				) : availableWallets.length > 0 ? (
					<div className="card-padded">
						<div className="flex flex-wrap gap-2">
							{availableWallets.map((name) => (
								<button
									key={name}
									onClick={() => connectWallet(name)}
									className="btn-primary btn-sm"
								>
									Connect {walletNames[name] || name}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="card-padded">
						<p className="text-sm text-ink-500">
							No browser extension wallets detected. Install{" "}
							<a
								href="https://polkadot.js.org/extension/"
								target="_blank"
								rel="noopener noreferrer"
								className="text-estate-500 underline"
							>
								Polkadot.js
							</a>
							,{" "}
							<a
								href="https://www.talisman.xyz/"
								target="_blank"
								rel="noopener noreferrer"
								className="text-estate-500 underline"
							>
								Talisman
							</a>
							, or{" "}
							<a
								href="https://www.subwallet.app/"
								target="_blank"
								rel="noopener noreferrer"
								className="text-estate-500 underline"
							>
								SubWallet
							</a>
							.
						</p>
					</div>
				)}
			</section>
		</div>
	);
}

function SectionHeader({
	eyebrow,
	title,
	subtitle,
}: {
	eyebrow: string;
	title: string;
	subtitle: string;
}) {
	return (
		<div className="mb-4">
			<div className="eyebrow mb-1">{eyebrow}</div>
			<h2 className="h-section">{title}</h2>
			<p className="text-sm text-ink-500 mt-1">{subtitle}</p>
		</div>
	);
}

function DismissiblePill({
	label,
	onDismiss,
	dismissing,
	tone = "positive",
}: {
	label: string;
	onDismiss: () => void;
	dismissing: boolean;
	tone?: "positive";
}) {
	const bg =
		tone === "positive"
			? "rgba(79, 174, 110, 0.10)"
			: "rgba(79, 174, 110, 0.10)";
	const border =
		tone === "positive"
			? "rgba(79, 174, 110, 0.25)"
			: "rgba(79, 174, 110, 0.25)";
	return (
		<span
			className="inline-flex items-center gap-1.5 rounded-full pl-2.5 pr-1 py-1 text-xs font-medium text-positive border"
			style={{ background: bg, borderColor: border }}
		>
			<span className="w-1.5 h-1.5 rounded-full bg-current" />
			<span>{label}</span>
			<button
				onClick={onDismiss}
				disabled={dismissing}
				className="w-5 h-5 rounded-full hover:bg-[rgba(79,174,110,0.2)] flex items-center justify-center text-positive disabled:opacity-40 transition-colors"
				title="Remove"
			>
				<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
					<path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
				</svg>
			</button>
		</span>
	);
}

function InfoTooltip({ children }: { children: React.ReactNode }) {
	return (
		<span className="relative inline-flex items-center group">
			<button
				type="button"
				className="w-4 h-4 rounded-full border border-hairline flex items-center justify-center text-[0.62rem] font-medium text-ink-400 hover:text-ink-900 hover:border-rule transition-colors"
				aria-label="More info"
			>
				i
			</button>
			<span
				className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-xl border border-hairline bg-paper shadow-card px-3 py-2.5 text-xs text-ink-700 leading-relaxed opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50"
				style={{ transitionDuration: "150ms" }}
			>
				{children}
				<span
					className="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 bg-paper border-r border-b border-hairline"
					style={{ transform: "translate(-50%, -50%) rotate(45deg)" }}
				/>
			</span>
		</span>
	);
}

function AccountCard({
	account,
	info,
	identity,
	identityActionStatus,
	connected,
	showIdentity,
	showAssetHub,
	link,
	linkActionStatus,
	onFund,
	onRegisterIdentity,
	onClearIdentity,
	onLinkAssetHub,
	onUnlinkAssetHub,
}: {
	account: DisplayAccount;
	info?: AccountInfo;
	identity?: IdentityStatus;
	identityActionStatus: Record<string, string>;
	connected: boolean;
	showIdentity: boolean;
	showAssetHub: boolean;
	link?: AssetHubLinkStatus;
	linkActionStatus: Record<string, string>;
	onFund: () => void;
	onRegisterIdentity: () => void;
	onClearIdentity: () => void;
	onLinkAssetHub: () => void;
	onUnlinkAssetHub: () => void;
}) {
	const regKey = `reg-${account.ss58}`;
	const clrKey = `clr-${account.ss58}`;
	const pendingIdentityMsg =
		identityActionStatus[regKey] ?? identityActionStatus[clrKey];
	const clearing = identityActionStatus[clrKey] === "Submitting…";
	const linkKey = `link-${account.ss58}`;
	const unlinkKey = `unlink-${account.ss58}`;
	const pendingLinkMsg =
		linkActionStatus[linkKey] ?? linkActionStatus[unlinkKey];
	const unlinking = linkActionStatus[unlinkKey] === "Submitting…";

	const typeChipClass =
		account.type === "dev" ? "chip-neutral" : "chip-estate";
	const typeLabel = account.type === "dev" ? "Dev" : "Extension";

	return (
		<article className="card overflow-hidden">
			{/* Header — Asset Hub balance is the hero number */}
			<div className="px-6 py-5 border-b border-hairline flex items-start justify-between gap-6 flex-wrap">
				<div className="flex items-start gap-3 min-w-0">
					<div className="w-10 h-10 rounded-xl bg-ink-900 text-canvas flex items-center justify-center font-semibold text-sm shrink-0">
						{account.name[0]?.toUpperCase() ?? "?"}
					</div>
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h3 className="h-card truncate">{account.name}</h3>
							<span className={typeChipClass}>{typeLabel}</span>
						</div>
						<div className="flex items-center gap-2 text-xs text-ink-400 font-mono mt-0.5 truncate">
							<span className="truncate">{account.ss58}</span>
							<CopyButton text={account.ss58} />
						</div>
					</div>
				</div>

				<div className="text-right shrink-0 flex flex-col items-end">
					{showAssetHub && link?.balance !== undefined ? (
						<>
							<div className="text-[0.65rem] uppercase tracking-[0.12em] text-brass-500 font-medium mb-0.5">
								Asset Hub
							</div>
							<div className="font-semibold tabular text-2xl text-ink-900">
								{formatBalanceShort(link.balance)}
								<span className="text-sm text-ink-400 ml-1">ROC</span>
							</div>
						</>
					) : showAssetHub ? (
						<>
							<div className="text-[0.65rem] uppercase tracking-[0.12em] text-ink-400 font-medium mb-0.5">
								Asset Hub
							</div>
							<div className="text-sm text-ink-400">—</div>
						</>
					) : (
						info && (
							<>
								<div className="eyebrow mb-0.5">On Estate</div>
								<div className="font-mono tabular text-sm">
									{formatBalance(info.balance)}
								</div>
							</>
						)
					)}
					{showAssetHub && info && (
						<div className="text-[0.7rem] text-ink-400 mt-1 font-mono tabular flex items-center gap-2">
							<span>
								{formatBalanceShort(info.balance)} on Estate · nonce {info.nonce}
							</span>
							{connected && (
								<button
									onClick={onFund}
									className="text-[0.7rem] text-ink-400 hover:text-estate-500 transition-colors"
									title="Top up dev balance on Estate"
								>
									＋fund
								</button>
							)}
						</div>
					)}
					{!showAssetHub && info && connected && (
						<button
							onClick={onFund}
							className="text-[0.7rem] text-ink-400 hover:text-estate-500 transition-colors mt-1"
							title="Top up dev balance on Estate"
						>
							＋fund
						</button>
					)}
				</div>
			</div>

			{/* Actions row — identity + AH link side by side */}
			<div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-hairline">
				{/* Identity */}
				{showIdentity ? (
					<div className="p-5">
						<div className="eyebrow mb-2">Identity</div>
						<div className="flex items-center gap-2 flex-wrap min-h-[28px]">
							{identity?.hasIdentity ? (
								<DismissiblePill
									label={identity.display ?? "registered"}
									onDismiss={onClearIdentity}
									dismissing={clearing}
								/>
							) : (
								<button onClick={onRegisterIdentity} className="btn-outline btn-sm">
									+ Create identity
								</button>
							)}
						</div>
						{pendingIdentityMsg && (
							<p
								className={`text-xs mt-2 ${
									pendingIdentityMsg.startsWith("Error")
										? "text-danger"
										: pendingIdentityMsg === "Registered" ||
											  pendingIdentityMsg === "Cleared"
											? "text-positive"
											: "text-caution"
								}`}
							>
								{pendingIdentityMsg}
							</p>
						)}
					</div>
				) : (
					<div className="p-5">
						<div className="eyebrow mb-2">Identity</div>
						<div className="text-xs text-ink-400">People Chain unavailable</div>
					</div>
				)}

				{/* Asset Hub link */}
				{showAssetHub ? (
					<div className="p-5">
						<div className="eyebrow mb-2">Asset Hub link</div>
						<div className="flex items-center gap-2 flex-wrap min-h-[28px]">
							{link?.linked ? (
								<DismissiblePill
									label="linked as proxy"
									onDismiss={onUnlinkAssetHub}
									dismissing={unlinking}
								/>
							) : (
								<>
									<button
										onClick={onLinkAssetHub}
										className="btn-accent btn-sm"
									>
										+ Link to Asset Hub
									</button>
									<InfoTooltip>
										Adds Estate Protocol's sovereign account as a full proxy
										on your Asset Hub account. When a will executes, the
										protocol signs calls (transfers, proxies, etc.) as you.
										Revoke at any time by clicking the × on the pill.
									</InfoTooltip>
								</>
							)}
						</div>
						{pendingLinkMsg && (
							<p
								className={`text-xs mt-2 ${
									pendingLinkMsg.startsWith("Error")
										? "text-danger"
										: pendingLinkMsg === "Linked" ||
											  pendingLinkMsg === "Unlinked"
											? "text-positive"
											: "text-caution"
								}`}
							>
								{pendingLinkMsg}
							</p>
						)}
					</div>
				) : (
					<div className="p-5">
						<div className="eyebrow mb-2">Asset Hub link</div>
						<div className="text-xs text-ink-400">Not reachable</div>
					</div>
				)}
			</div>
		</article>
	);
}
