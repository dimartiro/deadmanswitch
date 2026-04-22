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
import { injectSpektrExtension, SpektrExtensionName } from "@novasamatech/product-sdk";
import { Binary, FixedSizeBinary, type PolkadotSigner } from "polkadot-api";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";

// Sibling parachain sovereign account on Asset Hub, derived per
// `polkadot_parachain_primitives::primitives::Sibling`:
//   b"sibl" ++ u32_le(para_id) ++ padding to 32 bytes
const ESTATE_PARA_ID = 2000;
function estateSovereignOnAssetHub(): string {
	const buf = new Uint8Array(32);
	buf.set(new TextEncoder().encode("sibl"), 0);
	new DataView(buf.buffer).setUint32(4, ESTATE_PARA_ID, true);
	return ss58Address(buf);
}
const ESTATE_SOVEREIGN_ON_ASSETHUB = estateSovereignOnAssetHub();

type HostEnvironment = "desktop-webview" | "web-iframe" | "standalone";

function detectHostEnvironment(): HostEnvironment {
	if (typeof window === "undefined") return "standalone";
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	if ((window as any).__HOST_WEBVIEW_MARK__) return "desktop-webview";
	try {
		if (window !== window.top) return "web-iframe";
	} catch {
		return "web-iframe";
	}
	return "standalone";
}

function isInHost(): boolean {
	return detectHostEnvironment() !== "standalone";
}

interface DisplayAccount {
	name: string;
	ss58: string;
	type: "dev" | "extension" | "spektr";
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

function CopyableAddress({ label, address }: { label: string; address: string }) {
	const [copied, setCopied] = useState(false);
	function handleCopy() {
		navigator.clipboard.writeText(address);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}
	return (
		<div
			onClick={handleCopy}
			className="flex items-center gap-2 cursor-pointer group"
			title="Click to copy"
		>
			<span className="text-xs text-text-muted w-8 shrink-0 uppercase font-medium">
				{label}
			</span>
			<code className="text-xs text-text-secondary font-mono break-all flex-1 group-hover:text-text-primary transition-colors">
				{address}
			</code>
			<span className="text-xs text-text-muted group-hover:text-text-secondary shrink-0 transition-colors">
				{copied ? "Copied!" : "Copy"}
			</span>
		</div>
	);
}

// Read the display name out of a People Chain IdentityInfo. The Raw*
// variants encode a fixed-size byte buffer; Raw0 means "no data"; Raw1
// is a bare u8; Raw2..Raw32 wrap a FixedSizeBinary.
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
		// fall through
	}
	return undefined;
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
	const spektrUnsubscribeRef = useRef<(() => void) | null>(null);
	const extensionUnsubscribeRef = useRef<(() => void) | null>(null);
	const [availableWallets, setAvailableWallets] = useState<string[]>([]);
	const [extensionAccounts, setExtensionAccounts] = useState<InjectedPolkadotAccount[]>([]);
	const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
	const [spektrAccounts, setSpektrAccounts] = useState<InjectedPolkadotAccount[]>([]);
	const [spektrStatus, setSpektrStatus] = useState<
		"detecting" | "injecting" | "connected" | "unavailable" | "failed"
	>("detecting");
	const [fundStatus, setFundStatus] = useState<string | null>(null);
	const [fundAmount, setFundAmount] = useState("10000");
	const [accountInfos, setAccountInfos] = useState<Record<string, AccountInfo>>({});
	const [identityStatuses, setIdentityStatuses] = useState<
		Record<string, IdentityStatus>
	>({});
	const [identityActionStatus, setIdentityActionStatus] = useState<
		Record<string, string>
	>({});
	const [assetHubLinks, setAssetHubLinks] = useState<
		Record<string, AssetHubLinkStatus>
	>({});
	const [linkActionStatus, setLinkActionStatus] = useState<
		Record<string, string>
	>({});

	// Build dev account display list
	const devDisplayAccounts: DisplayAccount[] = devAccounts.map((acc) => ({
		name: acc.name,
		ss58: acc.address,
		type: "dev",
		signer: acc.signer,
	}));

	// All SS58 addresses to query
	const allAddresses = [
		...devAccounts.map((a) => a.address),
		...extensionAccounts.map((a) => a.address),
		...spektrAccounts.map((a) => a.address),
	];

	// Query balances and nonces from Estate Protocol
	const fetchAccountInfos = useCallback(async () => {
		if (!connected || allAddresses.length === 0) return;
		try {
			const client = getClient(wsUrl);
			const api = client.getTypedApi(stack_template);
			const infos: Record<string, AccountInfo> = {};
			for (const addr of allAddresses) {
				try {
					const info = await api.query.System.Account.getValue(addr, { at: "best" });
					infos[addr] = {
						balance: info.data.free,
						nonce: info.nonce,
					};
				} catch {
					// Skip accounts that fail
				}
			}
			setAccountInfos(infos);
		} catch (e) {
			console.error("Failed to fetch account infos:", e);
		}
	}, [connected, wsUrl, allAddresses.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

	// Query identity status from People Chain (separate parachain)
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
						const info = await api.query.Identity.IdentityOf.getValue(addr, { at: "best" });
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
			// People Chain not reachable — leave statuses empty.
		}
	}, [allAddresses.join(","), bypassIdentity]); // eslint-disable-line react-hooks/exhaustive-deps

	// Query proxy+balance on Asset Hub for each known account. A link
	// exists when the account's Proxies storage entry includes our
	// sovereign account as a delegate.
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
			// Asset Hub not reachable — leave links empty.
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

	// Detect host environment and inject Spektr on mount
	useEffect(() => {
		let cancelled = false;

		async function initSpektr() {
			if (!isInHost()) {
				setSpektrStatus("unavailable");
				return;
			}
			setSpektrStatus("injecting");
			try {
				let injected = false;
				for (let i = 0; i < 10; i++) {
					if (await injectSpektrExtension()) {
						injected = true;
						break;
					}
					if (i < 9) await new Promise((r) => setTimeout(r, 500));
				}
				if (!injected) {
					setSpektrStatus("failed");
					return;
				}
				const ext = await connectInjectedExtension(SpektrExtensionName);
				if (cancelled) {
					ext.disconnect();
					return;
				}
				const accounts = ext.getAccounts();
				setSpektrAccounts(accounts);
				setSpektrStatus("connected");
				spektrUnsubscribeRef.current?.();
				spektrUnsubscribeRef.current = ext.subscribe((updated) => {
					setSpektrAccounts(updated);
				});
			} catch (e) {
				console.error("[Spektr] Init failed:", e);
				setSpektrStatus("failed");
			}
		}

		initSpektr();

		return () => {
			cancelled = true;
			spektrUnsubscribeRef.current?.();
			spektrUnsubscribeRef.current = null;
		};
	}, []);

	// Detect available browser extension wallets and auto-reconnect on mount
	useEffect(() => {
		try {
			const wallets = getInjectedExtensions().filter((name) => name !== SpektrExtensionName);
			setAvailableWallets(wallets);
			const saved = localStorage.getItem("connected-wallet");
			if (saved && wallets.includes(saved)) {
				connectWallet(saved);
			}
		} catch {
			// No injected extensions available
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
			spektrUnsubscribeRef.current?.();
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
			setFundStatus(`Funding ${accountName}...`);
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
			setFundStatus(`Funded ${accountName} with ${fundAmount} tokens!`);
			fetchAccountInfos();
		} catch (e) {
			console.error("Fund failed:", e);
			setFundStatus(`Error: ${e instanceof Error ? e.message : e}`);
		}
	}

	async function registerIdentity(acc: DisplayAccount) {
		const key = `reg-${acc.ss58}`;
		setIdentityActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
		try {
			const client = getPeopleChainClient();
			const api = client.getTypedApi(people_chain);
			// Papi's IdentityData enum has one variant per byte length
			// (Raw0..Raw32). Raw0 and None carry no value; Raw1 is a bare
			// u8 (number); Raw2..=Raw32 use FixedSizeBinary<N>.
			const displayName = acc.name.slice(0, 32);
			const bytes = new TextEncoder().encode(displayName).slice(0, 32);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let display: any;
			if (bytes.length === 0) {
				display = { type: "None", value: undefined };
			} else if (bytes.length === 1) {
				display = { type: "Raw1", value: bytes[0] };
			} else {
				display = {
					type: `Raw${bytes.length}`,
					value: FixedSizeBinary.fromBytes(bytes),
				};
			}
			const none = { type: "None" as const, value: undefined };
			// People Chain uses the modernised IdentityInfo (no `additional`,
			// `riot` renamed to `matrix`, `github` + `discord` added).
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
		setIdentityActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
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
		setLinkActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
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
		setLinkActionStatus((s) => ({ ...s, [key]: "Submitting..." }));
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

	const typeBadge: Record<string, { className: string; label: string }> = {
		dev: {
			className: "bg-accent-blue/10 text-accent-blue border border-accent-blue/20",
			label: "Dev",
		},
		extension: {
			className: "bg-accent-purple/10 text-accent-purple border border-accent-purple/20",
			label: "Extension",
		},
		spektr: {
			className: "bg-polka-500/10 text-polka-400 border border-polka-500/20",
			label: "Host",
		},
	};

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title text-polka-400">Accounts</h1>
				<p className="text-text-secondary">
					Manage dev accounts, connect browser extension wallets, or use Polkadot Host
					accounts. Each card shows the chain balance on Estate Protocol and the
					identity registered on People Chain.
				</p>
			</div>

			{bypassIdentity && (
				<div className="card border border-accent-yellow/20 bg-accent-yellow/5 space-y-1">
					<p className="text-sm text-accent-yellow font-medium">
						Identities support disabled
					</p>
					<p className="text-xs text-text-muted">
						People Chain isn't reachable at{" "}
						<span className="font-mono">ws://localhost:9946</span>. Identity
						registration is hidden here, and identity checks are bypassed
						when creating wills.
					</p>
				</div>
			)}

			{/* Fund amount */}
			<div className="card space-y-3">
				<h2 className="section-title">Funding</h2>
				<div className="flex gap-3 items-center">
					<label className="text-sm text-text-secondary">Amount (tokens):</label>
					<input
						type="number"
						value={fundAmount}
						onChange={(e) => setFundAmount(e.target.value)}
						className="input-field w-40"
					/>
					<button onClick={fetchAccountInfos} className="btn-secondary text-xs">
						Refresh Balances
					</button>
				</div>
				{fundStatus && (
					<p
						className={`text-sm font-medium ${fundStatus.startsWith("Error") ? "text-accent-red" : "text-accent-green"}`}
					>
						{fundStatus}
					</p>
				)}
			</div>

			{/* Dev Accounts */}
			<div className="card space-y-4">
				<h2 className="section-title">Dev Accounts</h2>
				<p className="text-sm text-text-muted">
					Pre-funded accounts from the well-known dev seed phrase.
				</p>
				<div className="space-y-3">
					{devDisplayAccounts.map((acc) => (
						<AccountCard
							key={acc.ss58}
							account={acc}
							info={accountInfos[acc.ss58]}
							identity={identityStatuses[acc.ss58]}
							identityActionStatus={identityActionStatus}
							badge={typeBadge[acc.type]}
							onFund={() => fundAccount(acc.ss58, acc.name)}
							onRegisterIdentity={() => registerIdentity(acc)}
							onClearIdentity={() => clearIdentity(acc)}
							connected={connected}
							showIdentity={!bypassIdentity}
						showAssetHub={showAssetHub}
						link={assetHubLinks[acc.ss58]}
						linkActionStatus={linkActionStatus}
						onLinkAssetHub={() => linkAssetHub(acc)}
						onUnlinkAssetHub={() => unlinkAssetHub(acc)}
						/>
					))}
				</div>
			</div>

			{/* Polkadot Host Accounts */}
			<div className="card space-y-4">
				<h2 className="section-title">Polkadot Host Accounts</h2>
				{spektrStatus === "detecting" && (
					<p className="text-sm text-accent-yellow">
						Detecting Polkadot host environment...
					</p>
				)}
				{spektrStatus === "injecting" && (
					<p className="text-sm text-accent-yellow">Connecting to Polkadot Host...</p>
				)}
				{spektrStatus === "unavailable" && (
					<p className="text-sm text-text-muted">
						Not running inside a Polkadot Host. These accounts are only available when
						this app is loaded through a Polkadot Host client.
					</p>
				)}
				{spektrStatus === "failed" && (
					<p className="text-sm text-accent-red">
						Failed to connect to Polkadot Host. The host environment may not be
						available.
					</p>
				)}
				{spektrStatus === "connected" && (
					<div className="space-y-3">
						<p className="text-sm text-accent-green font-medium">
							Connected to Polkadot Host ({spektrAccounts.length} account
							{spektrAccounts.length !== 1 ? "s" : ""})
						</p>
						{spektrAccounts.map((acc) => {
							const display: DisplayAccount = {
								name: acc.name || "Host Account",
								ss58: acc.address,
								type: "spektr",
								signer: acc.polkadotSigner,
							};
							return (
								<AccountCard
									key={acc.address}
									account={display}
									info={accountInfos[acc.address]}
									identity={identityStatuses[acc.address]}
									identityActionStatus={identityActionStatus}
									badge={typeBadge.spektr}
									onFund={() => fundAccount(acc.address, display.name)}
									onRegisterIdentity={() => registerIdentity(display)}
									onClearIdentity={() => clearIdentity(display)}
									connected={connected}
								showIdentity={!bypassIdentity}
								showAssetHub={showAssetHub}
								link={assetHubLinks[display.ss58]}
								linkActionStatus={linkActionStatus}
								onLinkAssetHub={() => linkAssetHub(display)}
								onUnlinkAssetHub={() => unlinkAssetHub(display)}
								/>
							);
						})}
					</div>
				)}
			</div>

			{/* Extension Wallets */}
			<div className="card space-y-4">
				<h2 className="section-title">Browser Extension Wallets</h2>
				{connectedWallet ? (
					<div className="space-y-3">
						<div className="flex items-center gap-3">
							<span className="text-sm text-accent-green font-medium">
								Connected to {walletNames[connectedWallet] || connectedWallet}
							</span>
							<button
								onClick={disconnectWallet}
								className="px-3 py-1 rounded-md bg-accent-red/10 text-accent-red text-xs font-medium hover:bg-accent-red/20 transition-colors"
							>
								Disconnect
							</button>
						</div>
						{extensionAccounts.length === 0 ? (
							<p className="text-sm text-text-muted">
								No accounts found in this wallet.
							</p>
						) : (
							extensionAccounts.map((acc) => {
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
										badge={typeBadge.extension}
										onFund={() => fundAccount(acc.address, display.name)}
										onRegisterIdentity={() => registerIdentity(display)}
										onClearIdentity={() => clearIdentity(display)}
										connected={connected}
								showIdentity={!bypassIdentity}
									showAssetHub={showAssetHub}
									link={assetHubLinks[display.ss58]}
									linkActionStatus={linkActionStatus}
									onLinkAssetHub={() => linkAssetHub(display)}
									onUnlinkAssetHub={() => unlinkAssetHub(display)}
									/>
								);
							})
						)}
					</div>
				) : availableWallets.length > 0 ? (
					<div className="flex flex-wrap gap-2">
						{availableWallets.map((name) => (
							<button
								key={name}
								onClick={() => connectWallet(name)}
								className="btn-primary"
							>
								Connect {walletNames[name] || name}
							</button>
						))}
					</div>
				) : (
					<p className="text-sm text-text-muted">
						No browser extension wallets detected. Install{" "}
						<a
							href="https://polkadot.js.org/extension/"
							target="_blank"
							rel="noopener noreferrer"
							className="text-polka-400 underline hover:text-polka-300"
						>
							Polkadot.js
						</a>
						,{" "}
						<a
							href="https://www.talisman.xyz/"
							target="_blank"
							rel="noopener noreferrer"
							className="text-polka-400 underline hover:text-polka-300"
						>
							Talisman
						</a>
						, or{" "}
						<a
							href="https://www.subwallet.app/"
							target="_blank"
							rel="noopener noreferrer"
							className="text-polka-400 underline hover:text-polka-300"
						>
							SubWallet
						</a>{" "}
						to connect.
					</p>
				)}
			</div>
		</div>
	);
}

function AccountCard({
	account,
	info,
	identity,
	identityActionStatus,
	badge,
	onFund,
	onRegisterIdentity,
	onClearIdentity,
	connected,
	showIdentity,
	showAssetHub,
	link,
	linkActionStatus,
	onLinkAssetHub,
	onUnlinkAssetHub,
}: {
	account: DisplayAccount;
	info?: AccountInfo;
	identity?: IdentityStatus;
	identityActionStatus: Record<string, string>;
	badge: { className: string; label: string };
	onFund: () => void;
	onRegisterIdentity: () => void;
	onClearIdentity: () => void;
	connected: boolean;
	showIdentity: boolean;
	showAssetHub: boolean;
	link?: AssetHubLinkStatus;
	linkActionStatus: Record<string, string>;
	onLinkAssetHub: () => void;
	onUnlinkAssetHub: () => void;
}) {
	const regKey = `reg-${account.ss58}`;
	const clrKey = `clr-${account.ss58}`;
	const pendingIdentityMsg =
		identityActionStatus[regKey] ?? identityActionStatus[clrKey];
	const linkKey = `link-${account.ss58}`;
	const unlinkKey = `unlink-${account.ss58}`;
	const pendingLinkMsg =
		linkActionStatus[linkKey] ?? linkActionStatus[unlinkKey];

	return (
		<div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3 space-y-2">
			<div className="flex items-center justify-between">
				<span className="font-semibold text-text-primary">{account.name}</span>
				<div className="flex gap-2 items-center">
					{info && (
						<span className="text-xs text-text-tertiary font-mono">
							{formatBalance(info.balance)} | nonce: {info.nonce}
						</span>
					)}
					{connected && (
						<button
							onClick={onFund}
							className="px-2 py-1 rounded-md bg-accent-yellow/10 text-accent-yellow text-xs font-medium hover:bg-accent-yellow/20 transition-colors"
						>
							Fund
						</button>
					)}
					<span className={`status-badge ${badge.className}`}>{badge.label}</span>
				</div>
			</div>
			<div className="space-y-1">
				<CopyableAddress label="SS58" address={account.ss58} />
			</div>
			{showIdentity && (
				<div className="flex items-center justify-between pt-2 border-t border-white/[0.04]">
					<div className="flex items-center gap-2">
						<span className="text-xs text-text-muted uppercase font-medium w-8 shrink-0">
							ID
						</span>
						{identity?.hasIdentity ? (
							<span className="status-badge bg-accent-green/10 text-accent-green border border-accent-green/20">
								✓ {identity.display ?? "registered"}
							</span>
						) : (
							<span className="status-badge bg-accent-red/10 text-accent-red border border-accent-red/20">
								✗ no identity
							</span>
						)}
					</div>
					{identity?.hasIdentity ? (
						<button
							onClick={onClearIdentity}
							className="px-2 py-1 rounded-md bg-text-muted/10 text-text-secondary border border-text-muted/20 text-xs font-medium hover:bg-text-muted/20 transition-colors"
						>
							Clear identity
						</button>
					) : (
						<button
							onClick={onRegisterIdentity}
							className="px-2 py-1 rounded-md bg-accent-blue/10 text-accent-blue border border-accent-blue/20 text-xs font-medium hover:bg-accent-blue/20 transition-colors"
						>
							Register identity
						</button>
					)}
				</div>
			)}
			{showIdentity && pendingIdentityMsg && (
				<p
					className={`text-xs font-medium ${
						pendingIdentityMsg.startsWith("Error")
							? "text-accent-red"
							: pendingIdentityMsg === "Registered" ||
								  pendingIdentityMsg === "Cleared"
								? "text-accent-green"
								: "text-accent-yellow"
					}`}
				>
					{pendingIdentityMsg}
				</p>
			)}
			{showAssetHub && (
				<div className="flex items-center justify-between pt-2 border-t border-white/[0.04]">
					<div className="flex items-center gap-2">
						<span className="text-xs text-text-muted uppercase font-medium w-8 shrink-0">
							AH
						</span>
						{link?.linked ? (
							<span className="status-badge bg-accent-green/10 text-accent-green border border-accent-green/20">
								✓ linked
							</span>
						) : (
							<span className="status-badge bg-text-muted/10 text-text-muted border border-text-muted/20">
								not linked
							</span>
						)}
						{link?.balance !== undefined && (
							<span className="text-xs text-text-tertiary font-mono">
								{formatBalance(link.balance)} ROC
							</span>
						)}
					</div>
					{link?.linked ? (
						<button
							onClick={onUnlinkAssetHub}
							className="px-2 py-1 rounded-md bg-text-muted/10 text-text-secondary border border-text-muted/20 text-xs font-medium hover:bg-text-muted/20 transition-colors"
						>
							Unlink
						</button>
					) : (
						<button
							onClick={onLinkAssetHub}
							className="px-2 py-1 rounded-md bg-polka-500/10 text-polka-400 border border-polka-500/20 text-xs font-medium hover:bg-polka-500/20 transition-colors"
						>
							Link to Asset Hub
						</button>
					)}
				</div>
			)}
			{showAssetHub && pendingLinkMsg && (
				<p
					className={`text-xs font-medium ${
						pendingLinkMsg.startsWith("Error")
							? "text-accent-red"
							: pendingLinkMsg === "Linked" || pendingLinkMsg === "Unlinked"
								? "text-accent-green"
								: "text-accent-yellow"
					}`}
				>
					{pendingLinkMsg}
				</p>
			)}
		</div>
	);
}
