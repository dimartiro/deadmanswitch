# Estate Protocol Runtime

A Cumulus-based parachain runtime built on `polkadot-sdk stable2512-3`. Runs via `polkadot-omni-node` locally (solo dev) or inside a zombienet topology alongside Asset Hub and People Chain. Para-id **2000**.

## What's wired

| Concern | Pallet / module | Notes |
|---|---|---|
| Core | `frame_system`, `pallet-balances`, `pallet-sudo`, `pallet-timestamp` | standard |
| Block production | `pallet-aura`, `pallet-session`, `pallet-authorship`, `pallet-collator-selection` | parachain collators |
| Fees | `pallet-transaction-payment` + `pallet-skip-feeless-payment` | second wrapper makes owner-heartbeat tx-feeless |
| Scheduling | `pallet-scheduler` | drives deterministic `execute_will` at expiry |
| Cross-chain | `pallet-xcm`, `cumulus-pallet-xcmp-queue`, `cumulus-pallet-parachain-system` | bequests ship as XCM Transact to Asset Hub |
| Identity (client-side) | — | verified against People Chain `pallet-identity` by the frontend; runtime uses [`IdentityCheckStub`](src/configs/mod.rs) |
| Proxies | `pallet-proxy`, `pallet-multisig` | local; the *real* proxy link lives on Asset Hub |
| NFTs | `pallet-nfts` | soulbound inheritance certificates (collection lazily created on first mint) |
| Smart contracts | `pallet-revive` | optional EVM/PVM execution, Ethereum RPC compatibility |
| **Estate Executor** | `pallet-estate-executor` | the protocol core — wires everything together |

## Estate Executor integrations

### `RuntimeBequestBuilder`

Translates each `Bequest<T>` variant into a hand-encoded Asset Hub `RuntimeCall`, wraps it in `Proxy.proxy(owner, None, _)` so Asset Hub dispatches as the owner, and ships it via `pallet_xcm::send_xcm(Here, AssetHub, _)`. Pallet indices (Balances = 10, Proxy = 42) are hard-coded `u8` constants because the runtime does not link asset-hub-rococo — keep them in sync with upstream. `ASSET_HUB_PARA_ID = 1000` is stable across Rococo / Paseo / Polkadot.

### `IdentityCheckStub`

Accepts every account. The real verification is performed client-side by querying People Chain; see the comment at [`src/configs/mod.rs`](src/configs/mod.rs) for the rationale (on-chain cross-parachain reads aren't supported by XCM without a light-client bridge).

### `RuntimeCertificateMinter`

Creates a `pallet-nfts` collection on first use (owned by the protocol's sovereign account derived from `ESTATE_EXECUTOR_PALLET_ID`), then mints one item per `(will, beneficiary)` pair. Items are minted transferable and then frozen to make them soulbound.

### Fee router — `SplitTwoWays`

```
EstateFeeRouter = SplitTwoWays<
    Balance, NegativeImbalance,
    Target1 = (),                    // 30 parts → dropped (burn)
    Target2 = EstateTreasuryDeposit, // 70 parts → resolve_creating into treasury
    PART1 = 30, PART2 = 70,
>
```

Treasury account derives from `ESTATE_TREASURY_PALLET_ID = PalletId(*b"estatefe")`, distinct from the NFT sovereign. Every fee the pallet collects (longevity, execution, post-trigger-reward remainder) flows through this router.

### Fee constants

| Constant | Value | Used for |
|---|---|---|
| `EstateFeePerBlock` | `10 * MICRO_UNIT` | Longevity fee rate |
| `EstateProtocolFeePermill` | `1 %` | Skim on each `Transfer` amount |
| `EstateFlatBequestFee` | `10 * MILLI_UNIT` | Flat execution fee for amount-less bequests |
| `EstateTriggerRewardPerBlock` | `100 * MICRO_UNIT` | Trigger reward growth per block overdue |
| `EstateTriggerRewardCap` | = `EstateFlatBequestFee` | Absolute reward cap |

### Custom transaction extension

`BoostUrgentHeartbeats` (from the pallet) is included in the runtime's `TxExtension` tuple. It promotes heartbeats whose target will is close to expiry to `u64::MAX` tx-pool priority.

## Source layout

| File | Purpose |
|---|---|
| `src/lib.rs` | Runtime definition, opaque types, version, `impl_runtime_apis!` |
| `src/configs/mod.rs` | All pallet configuration — including the Estate fee router and NFT minter |
| `src/configs/xcm_config.rs` | XCM barrier, router, origin converter |
| `src/genesis_config_presets.rs` | Genesis presets (para-id, dev accounts) |
| `src/tests.rs` | Runtime integration tests |
| `src/weights/` | Per-pallet weight files |

## Commands

```bash
# Build the runtime (WASM + native)
cargo build -p estate-protocol-runtime --release

# Run runtime tests
cargo test -p estate-protocol-runtime

# Workspace tests including benchmarks
cargo test --workspace --features runtime-benchmarks
```

Compiled WASM:

```
target/release/wbuild/estate-protocol-runtime/estate_protocol_runtime.compact.compressed.wasm
```

See [`../../README.md`](../../README.md) for the project overview and [`../pallets/estate-executor/README.md`](../pallets/estate-executor/README.md) for the pallet reference.
