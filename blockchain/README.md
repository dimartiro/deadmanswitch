# Blockchain

A Polkadot SDK parachain built with FRAME and Cumulus, compatible with `polkadot-omni-node`. The product is the **Estate Protocol** (digital legacy / will management).

## Directory Guide

| Path | What it contains |
| --- | --- |
| [`pallets/estate-executor/`](pallets/estate-executor/) | The Estate Executor FRAME pallet |
| [`runtime/`](runtime/) | The `estate-protocol-runtime` built on `polkadot-sdk stable2512-3` |

## Common Commands

```bash
# Build the runtime
cargo build -p estate-protocol-runtime --release

# Pallet unit tests
cargo test -p pallet-estate-executor

# Run the full local topology (relay + Estate + Asset Hub + People Chain)
./scripts/start-zombienet.sh
```
