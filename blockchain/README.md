# Blockchain

A Polkadot SDK parachain built with FRAME and Cumulus, compatible with `polkadot-omni-node`.

## Directory Guide

| Path | What it contains |
| --- | --- |
| [`pallets/deadman-switch/`](pallets/deadman-switch/) | The Dedman Switch FRAME pallet |
| [`runtime/`](runtime/) | The parachain runtime built on `polkadot-sdk stable2512-3` |

## Common Commands

```bash
# Build the runtime
cargo build -p deadman-switch-runtime --release

# Pallet unit tests
cargo test -p pallet-deadman-switch

# Run local dev node
./scripts/start-dev.sh
```
