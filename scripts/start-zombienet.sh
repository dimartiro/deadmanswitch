#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "=== Estate Protocol + People Chain - Local Zombienet ==="
echo ""
log_info "Spawns a Rococo-local relay chain with three parachains:"
log_info "  - Estate Protocol   (para_id 2000, ws://127.0.0.1:${STACK_SUBSTRATE_RPC_PORT})"
log_info "  - People Chain      (para_id 1004, ws://127.0.0.1:${STACK_PEOPLE_RPC_PORT})"
log_info "  - Asset Hub         (para_id 1000, ws://127.0.0.1:${STACK_ASSETHUB_RPC_PORT})"
log_info "Identity lives on People Chain, wills on Estate Protocol, XCM targets on Asset Hub."
echo ""

echo "[1/5] Building Estate Protocol runtime..."
build_runtime

echo "[2/5] Generating Estate Protocol chain spec..."
generate_chain_spec
log_info "Chain spec: $CHAIN_SPEC"

echo "[3/5] Starting zombienet (in background)..."
start_zombienet_background
trap cleanup_zombienet EXIT INT TERM

echo "[4/5] Waiting for both parachains to produce blocks..."
wait_for_substrate_rpc
wait_for_people_chain

echo "[5/5] Opening HRMP channels and seeding identities..."
if [ -x "$SCRIPT_DIR/open-hrmp.sh" ]; then
    if "$SCRIPT_DIR/open-hrmp.sh"; then
        log_info "HRMP channels opened."
    else
        log_warn "HRMP channel opening failed — XCM bequests will fail until fixed."
    fi
fi
seed_dev_identities

echo ""
log_info "All services ready. Press Ctrl-C to stop zombienet."
log_info "Logs: $ZOMBIE_LOG"
echo ""

# Block on zombienet until it exits or Ctrl-C.
wait "$ZOMBIE_PID"
