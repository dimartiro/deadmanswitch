# Scripts

Convenience scripts for local development.

```bash
./scripts/<script-name>.sh
```

## Script Guide

| Script | What it does |
| --- | --- |
| `start-dev.sh` | Builds the runtime, generates chain spec, and starts a local dev node on `ws://127.0.0.1:9944`. |
| `start-frontend.sh` | Installs frontend dependencies and starts the Vite dev server on `http://127.0.0.1:5173`. |

## Requirements

- `cargo`, `chain-spec-builder`, `polkadot-omni-node` for `start-dev.sh`
- `node` (v22) and `npm` for `start-frontend.sh`
