# Scripts

Convenience scripts for local development.

```bash
./scripts/<script-name>.sh
```

## Script Guide

| Script | What it does |
| --- | --- |
| `start-dev.sh` | Builds the runtime, generates chain spec, and starts a local solo dev node on `ws://127.0.0.1:9944`. Fastest loop for pallet/runtime work; no XCM or identity support. |
| `start-zombienet.sh` | Spawns a Rococo-local relay with Estate Protocol (para 2000), Asset Hub (1000), People Chain (1004); seeds dev identities. Use this for the full feature set including XCM. |
| `start-frontend.sh` | Installs frontend dependencies, regenerates PAPI descriptors against the running node, and starts the Vite dev server on `http://127.0.0.1:5173`. |
| `test-zombienet.sh` | End-to-end test: starts zombienet, wires up HRMP + AH proxies + sovereign funds, then runs `e2e-tests.sh` against it. Auto-cleanup on exit. |
| `e2e-tests.sh` | The actual test suite (expects a running network). Verifies create / heartbeat / cancel, XCM-to-AH dispatch, certificate minting. XCM tests auto-skip when AH is unreachable. |
| `open-hrmp.sh` | Opens HRMP channels between Estate Protocol and Asset Hub via sudo. |
| `setup-asset-hub-proxies.sh` | Funds the Estate Protocol sovereign on Asset Hub and registers the proxy links needed by the dev accounts. |
| `seed-identities.sh` | Registers `pallet-identity` entries for dev accounts (Alice…Ferdie) on People Chain. |

## Requirements

- `cargo`, `chain-spec-builder`, `polkadot-omni-node` for `start-dev.sh`
- `zombienet`, `polkadot`, `polkadot-parachain` for `start-zombienet.sh`
- `node` (v22) and `npm` for `start-frontend.sh`, `test-zombienet.sh`
