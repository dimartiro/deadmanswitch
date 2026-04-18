#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

cleanup() {
    cleanup_zombienet
}
trap cleanup EXIT INT TERM

echo "=== Estate Protocol - E2E Test (Zombienet) ==="
echo ""

echo "[1/4] Building runtime..."
build_runtime

echo "[2/4] Generating chain spec..."
generate_chain_spec

echo "[3/4] Starting Zombienet..."
start_zombienet_background
wait_for_substrate_rpc

echo "[4/4] Preparing PAPI descriptors..."
cd "$ROOT_DIR/web"
[ ! -d node_modules ] && npm install --silent
npx papi update 2>/dev/null
npx papi generate 2>/dev/null

echo ""
log_info "Testing against $SUBSTRATE_RPC_WS"
echo ""

source "$SCRIPT_DIR/e2e-tests.sh"
