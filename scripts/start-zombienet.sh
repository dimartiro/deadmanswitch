#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "=== Estate Protocol + Asset Hub + People Chain - Local Zombienet ==="
echo ""
log_info "Spawns a Rococo-local relay (4 validators) with three parachains:"
log_info "  - Estate Protocol   (para_id 2000, ws://127.0.0.1:${STACK_SUBSTRATE_RPC_PORT})"
log_info "  - People Chain      (para_id 1004, ws://127.0.0.1:${STACK_PEOPLE_RPC_PORT})"
log_info "  - Asset Hub         (para_id 1000, ws://127.0.0.1:${STACK_ASSETHUB_RPC_PORT})"
echo ""

echo "[1/6] Building Estate Protocol runtime..."
build_runtime

echo "[2/6] Generating Estate Protocol chain spec..."
generate_chain_spec
log_info "Chain spec: $CHAIN_SPEC"

echo "[3/6] Starting zombienet (in background)..."
start_zombienet_background
trap cleanup_zombienet EXIT INT TERM

echo "[4/6] Waiting for Estate Protocol to produce blocks..."
wait_for_substrate_rpc

echo "[5/6] Waiting for People Chain and seeding dev identities..."
if wait_for_people_chain; then
    seed_dev_identities
else
    log_warn "People Chain unreachable — identity seeding skipped."
fi

echo "[6/6] Opening HRMP channels and linking dev accounts to Asset Hub..."
if [ -x "$SCRIPT_DIR/open-hrmp.sh" ]; then
    if "$SCRIPT_DIR/open-hrmp.sh"; then
        log_info "HRMP channels opened."
    else
        log_warn "HRMP channel opening failed — XCM bequests will fail until fixed."
    fi
fi
if [ -x "$SCRIPT_DIR/setup-asset-hub-proxies.sh" ]; then
    if "$SCRIPT_DIR/setup-asset-hub-proxies.sh"; then
        log_info "Asset Hub proxies set up for dev testators."
    else
        log_warn "Asset Hub proxy setup failed — RemoteTransfer bequests will revert."
    fi
fi

echo ""
log_info "All services ready. Press Ctrl-C to stop zombienet."
log_info "Logs: $ZOMBIE_LOG"
echo ""

# Block on zombienet until it exits or Ctrl-C.
wait "$ZOMBIE_PID"
