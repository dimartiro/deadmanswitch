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

echo "[3/5] Starting Zombienet..."
start_zombienet_background
wait_for_substrate_rpc

echo "[4/5] Wiring up XCM preconditions (HRMP + AH proxies + sovereign funds)..."
if [ -x "$SCRIPT_DIR/open-hrmp.sh" ]; then
    "$SCRIPT_DIR/open-hrmp.sh" || log_warn "HRMP open failed — XCM tests will be skipped."
fi
if [ -x "$SCRIPT_DIR/setup-asset-hub-proxies.sh" ]; then
    "$SCRIPT_DIR/setup-asset-hub-proxies.sh" || log_warn "AH proxy / sovereign funding failed — XCM tests will be skipped."
fi

echo "[5/5] Preparing PAPI descriptors..."
cd "$ROOT_DIR/web"
[ ! -d node_modules ] && npm install --silent
update_papi_descriptors

echo ""
log_info "Testing against $SUBSTRATE_RPC_WS (Estate) + $STACK_ASSETHUB_RPC_PORT (Asset Hub)"
echo ""

ASSETHUB_RPC_WS="ws://127.0.0.1:${STACK_ASSETHUB_RPC_PORT}" \
  source "$SCRIPT_DIR/e2e-tests.sh"
