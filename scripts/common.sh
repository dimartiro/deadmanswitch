#!/usr/bin/env bash
set -euo pipefail

# Shared helpers for the repo's two supported local topologies:
# - Solo dev mode (`start-dev.sh`) for the fastest runtime/pallet loop
# - Relay-backed Zombienet mode (`start-zombienet.sh`) for the full feature set

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$COMMON_DIR/.." && pwd)"
CHAIN_SPEC="$ROOT_DIR/blockchain/chain_spec.json"
RUNTIME_WASM="$ROOT_DIR/target/release/wbuild/estate-protocol-runtime/estate_protocol_runtime.compact.compressed.wasm"
STACK_PORT_OFFSET="${STACK_PORT_OFFSET:-0}"
STACK_SUBSTRATE_RPC_PORT="${STACK_SUBSTRATE_RPC_PORT:-$((9944 + STACK_PORT_OFFSET))}"
STACK_PEOPLE_RPC_PORT="${STACK_PEOPLE_RPC_PORT:-$((9946 + STACK_PORT_OFFSET))}"
STACK_PEOPLE_P2P_PORT="$((30334 + STACK_PORT_OFFSET))"
STACK_PEOPLE_PROMETHEUS_PORT="$((9616 + STACK_PORT_OFFSET))"
STACK_ASSETHUB_RPC_PORT="${STACK_ASSETHUB_RPC_PORT:-$((9948 + STACK_PORT_OFFSET))}"
STACK_ASSETHUB_P2P_PORT="$((30339 + STACK_PORT_OFFSET))"
STACK_ASSETHUB_PROMETHEUS_PORT="$((9621 + STACK_PORT_OFFSET))"
STACK_FRONTEND_PORT="${STACK_FRONTEND_PORT:-$((5173 + STACK_PORT_OFFSET))}"
STACK_COLLATOR_P2P_PORT="$((30333 + STACK_PORT_OFFSET))"
STACK_COLLATOR_PROMETHEUS_PORT="$((9615 + STACK_PORT_OFFSET))"
STACK_RELAY_ALICE_RPC_PORT="$((9949 + STACK_PORT_OFFSET))"
STACK_RELAY_ALICE_P2P_PORT="$((30335 + STACK_PORT_OFFSET))"
STACK_RELAY_ALICE_PROMETHEUS_PORT="$((9617 + STACK_PORT_OFFSET))"
STACK_RELAY_BOB_RPC_PORT="$((9951 + STACK_PORT_OFFSET))"
STACK_RELAY_BOB_P2P_PORT="$((30336 + STACK_PORT_OFFSET))"
STACK_RELAY_BOB_PROMETHEUS_PORT="$((9618 + STACK_PORT_OFFSET))"
STACK_RELAY_CHARLIE_RPC_PORT="$((9953 + STACK_PORT_OFFSET))"
STACK_RELAY_CHARLIE_P2P_PORT="$((30337 + STACK_PORT_OFFSET))"
STACK_RELAY_CHARLIE_PROMETHEUS_PORT="$((9619 + STACK_PORT_OFFSET))"
STACK_RELAY_DAVE_RPC_PORT="$((9955 + STACK_PORT_OFFSET))"
STACK_RELAY_DAVE_P2P_PORT="$((30338 + STACK_PORT_OFFSET))"
STACK_RELAY_DAVE_PROMETHEUS_PORT="$((9620 + STACK_PORT_OFFSET))"
STACK_RELAY_EVE_RPC_PORT="$((9957 + STACK_PORT_OFFSET))"
STACK_RELAY_EVE_P2P_PORT="$((30340 + STACK_PORT_OFFSET))"
STACK_RELAY_EVE_PROMETHEUS_PORT="$((9622 + STACK_PORT_OFFSET))"
STACK_RELAY_FERDIE_RPC_PORT="$((9959 + STACK_PORT_OFFSET))"
STACK_RELAY_FERDIE_P2P_PORT="$((30341 + STACK_PORT_OFFSET))"
STACK_RELAY_FERDIE_PROMETHEUS_PORT="$((9623 + STACK_PORT_OFFSET))"
SUBSTRATE_RPC_HTTP="${SUBSTRATE_RPC_HTTP:-http://127.0.0.1:${STACK_SUBSTRATE_RPC_PORT}}"
SUBSTRATE_RPC_WS="${SUBSTRATE_RPC_WS:-ws://127.0.0.1:${STACK_SUBSTRATE_RPC_PORT}}"
PEOPLE_RPC_WS="${PEOPLE_RPC_WS:-ws://127.0.0.1:${STACK_PEOPLE_RPC_PORT}}"
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:${STACK_FRONTEND_PORT}}"

ZOMBIE_DIR="${ZOMBIE_DIR:-}"
ZOMBIE_LOG="${ZOMBIE_LOG:-}"
ZOMBIE_PID="${ZOMBIE_PID:-}"
ZOMBIE_CONFIG="${ZOMBIE_CONFIG:-}"
NODE_DIR="${NODE_DIR:-}"
NODE_LOG="${NODE_LOG:-}"
NODE_PID="${NODE_PID:-}"

export STACK_PORT_OFFSET
export STACK_SUBSTRATE_RPC_PORT
export STACK_PEOPLE_RPC_PORT
export STACK_ASSETHUB_RPC_PORT
export STACK_FRONTEND_PORT
export SUBSTRATE_RPC_HTTP
export SUBSTRATE_RPC_WS
export PEOPLE_RPC_WS
export FRONTEND_URL

log_info() {
    echo "INFO: $*"
}

log_warn() {
    echo "WARN: $*"
}

log_error() {
    echo "ERROR: $*" >&2
}

install_hint() {
    case "$1" in
        cargo)
            echo "Install Rust via rustup: https://rustup.rs/"
            ;;
        chain-spec-builder)
            echo "Install with: cargo install staging-chain-spec-builder"
            ;;
        zombienet)
            echo "Install with: npm install -g @zombienet/cli"
            ;;
        polkadot|polkadot-omni-node|eth-rpc)
            echo "See docs/INSTALL.md for the matching stable2512-3 binary install steps."
            ;;
        curl)
            echo "Install curl with your system package manager."
            ;;
        *)
            echo "See docs/INSTALL.md for setup guidance."
            ;;
    esac
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log_error "Missing required command: $1"
        log_info "$(install_hint "$1")"
        exit 1
    fi
}

require_port_free() {
    local port="$1"
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        log_error "Port $port is already in use."
        lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -5 >&2
        log_info "Stop the process above or choose a different port before retrying."
        exit 1
    fi
}

require_ports_free() {
    local port
    for port in "$@"; do
        require_port_free "$port"
    done
}

require_distinct_ports() {
    local seen="|"
    local label
    local port

    while [ "$#" -gt 1 ]; do
        label="$1"
        port="$2"
        shift 2

        if [[ "$seen" == *"|$port|"* ]]; then
            log_error "Port assignment conflict detected for $label ($port)."
            log_info "Adjust STACK_PORT_OFFSET or the explicit STACK_*_PORT overrides and retry."
            exit 1
        fi

        seen="${seen}${port}|"
    done
}

validate_zombienet_ports() {
    require_distinct_ports \
        "Substrate RPC" "$STACK_SUBSTRATE_RPC_PORT" \
        "People RPC" "$STACK_PEOPLE_RPC_PORT" \
        "People P2P" "$STACK_PEOPLE_P2P_PORT" \
        "People Prometheus" "$STACK_PEOPLE_PROMETHEUS_PORT" \
        "Asset Hub RPC" "$STACK_ASSETHUB_RPC_PORT" \
        "Asset Hub P2P" "$STACK_ASSETHUB_P2P_PORT" \
        "Asset Hub Prometheus" "$STACK_ASSETHUB_PROMETHEUS_PORT" \
        "Relay Alice RPC" "$STACK_RELAY_ALICE_RPC_PORT" \
        "Relay Alice P2P" "$STACK_RELAY_ALICE_P2P_PORT" \
        "Relay Alice Prometheus" "$STACK_RELAY_ALICE_PROMETHEUS_PORT" \
        "Relay Bob RPC" "$STACK_RELAY_BOB_RPC_PORT" \
        "Relay Bob P2P" "$STACK_RELAY_BOB_P2P_PORT" \
        "Relay Bob Prometheus" "$STACK_RELAY_BOB_PROMETHEUS_PORT" \
        "Relay Charlie RPC" "$STACK_RELAY_CHARLIE_RPC_PORT" \
        "Relay Charlie P2P" "$STACK_RELAY_CHARLIE_P2P_PORT" \
        "Relay Charlie Prometheus" "$STACK_RELAY_CHARLIE_PROMETHEUS_PORT" \
        "Relay Dave RPC" "$STACK_RELAY_DAVE_RPC_PORT" \
        "Relay Dave P2P" "$STACK_RELAY_DAVE_P2P_PORT" \
        "Relay Dave Prometheus" "$STACK_RELAY_DAVE_PROMETHEUS_PORT" \
        "Relay Eve RPC" "$STACK_RELAY_EVE_RPC_PORT" \
        "Relay Eve P2P" "$STACK_RELAY_EVE_P2P_PORT" \
        "Relay Eve Prometheus" "$STACK_RELAY_EVE_PROMETHEUS_PORT" \
        "Relay Ferdie RPC" "$STACK_RELAY_FERDIE_RPC_PORT" \
        "Relay Ferdie P2P" "$STACK_RELAY_FERDIE_P2P_PORT" \
        "Relay Ferdie Prometheus" "$STACK_RELAY_FERDIE_PROMETHEUS_PORT" \
        "Collator P2P" "$STACK_COLLATOR_P2P_PORT" \
        "Collator Prometheus" "$STACK_COLLATOR_PROMETHEUS_PORT"

    require_ports_free \
        "$STACK_SUBSTRATE_RPC_PORT" \
        "$STACK_PEOPLE_RPC_PORT" \
        "$STACK_PEOPLE_P2P_PORT" \
        "$STACK_PEOPLE_PROMETHEUS_PORT" \
        "$STACK_ASSETHUB_RPC_PORT" \
        "$STACK_ASSETHUB_P2P_PORT" \
        "$STACK_ASSETHUB_PROMETHEUS_PORT" \
        "$STACK_RELAY_ALICE_RPC_PORT" \
        "$STACK_RELAY_ALICE_P2P_PORT" \
        "$STACK_RELAY_ALICE_PROMETHEUS_PORT" \
        "$STACK_RELAY_BOB_RPC_PORT" \
        "$STACK_RELAY_BOB_P2P_PORT" \
        "$STACK_RELAY_BOB_PROMETHEUS_PORT" \
        "$STACK_RELAY_CHARLIE_RPC_PORT" \
        "$STACK_RELAY_CHARLIE_P2P_PORT" \
        "$STACK_RELAY_CHARLIE_PROMETHEUS_PORT" \
        "$STACK_RELAY_DAVE_RPC_PORT" \
        "$STACK_RELAY_DAVE_P2P_PORT" \
        "$STACK_RELAY_DAVE_PROMETHEUS_PORT" \
        "$STACK_RELAY_EVE_RPC_PORT" \
        "$STACK_RELAY_EVE_P2P_PORT" \
        "$STACK_RELAY_EVE_PROMETHEUS_PORT" \
        "$STACK_RELAY_FERDIE_RPC_PORT" \
        "$STACK_RELAY_FERDIE_P2P_PORT" \
        "$STACK_RELAY_FERDIE_PROMETHEUS_PORT" \
        "$STACK_COLLATOR_P2P_PORT" \
        "$STACK_COLLATOR_PROMETHEUS_PORT"
}

build_runtime() {
    cargo build -p estate-protocol-runtime --release
}

generate_chain_spec() {
    chain-spec-builder \
        -c "$CHAIN_SPEC" \
        create \
        --chain-name "Estate Protocol" \
        --chain-id "estate-protocol" \
        -t development \
        --relay-chain rococo-local \
        --para-id 2000 \
        --runtime "$RUNTIME_WASM" \
        named-preset development
}

substrate_statement_store_ready() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"rpc_methods","params":[]}' \
        "$SUBSTRATE_RPC_HTTP" | grep -q '"statement_submit"'
}

basic_substrate_rpc_ready() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
        "$SUBSTRATE_RPC_HTTP" | grep -q '"result"'
}

substrate_block_producing() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
        "$SUBSTRATE_RPC_HTTP" | grep -Eq '"number":"0x[1-9a-fA-F][0-9a-fA-F]*"'
}

people_chain_block_producing() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
        "http://127.0.0.1:${STACK_PEOPLE_RPC_PORT}" | grep -Eq '"number":"0x[1-9a-fA-F][0-9a-fA-F]*"'
}

wait_for_people_chain() {
    log_info "Waiting for People Chain at $PEOPLE_RPC_WS..."
    local max_wait="${STACK_RPC_TIMEOUT:-180}"
    for _ in $(seq 1 "$max_wait"); do
        if people_chain_block_producing; then
            log_info "People Chain ready at $PEOPLE_RPC_WS"
            return 0
        fi
        if startup_service_stopped; then
            log_error "Zombienet stopped while waiting for People Chain."
            return 1
        fi
        sleep 1
    done
    log_error "People Chain did not become ready in time."
    return 1
}

seed_dev_identities() {
    if [ ! -x "$COMMON_DIR/seed-identities.sh" ]; then
        log_warn "seed-identities.sh not found or not executable — skipping."
        return 0
    fi
    # With 3 parachains sharing the relay, individual paras produce less
    # frequently early on. Wait for People Chain to accumulate a few
    # blocks before submitting — a single-block warmup is not enough and
    # caused tx subscriptions to stall on first boot.
    log_info "Warming up People Chain (waiting for block #3)..."
    local max_wait=60
    for _ in $(seq 1 "$max_wait"); do
        local hdr
        hdr="$(curl -s -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
            "http://127.0.0.1:${STACK_PEOPLE_RPC_PORT}" 2>/dev/null || true)"
        local block_hex
        block_hex="$(echo "$hdr" | sed -n 's/.*"number":"\(0x[0-9a-fA-F]*\)".*/\1/p')"
        if [ -n "$block_hex" ]; then
            local block_num
            block_num="$((block_hex))"
            if [ "$block_num" -ge 3 ]; then
                log_info "People Chain at block #$block_num — ready to seed."
                break
            fi
        fi
        sleep 1
    done
    log_info "Seeding dev identities on People Chain..."
    if "$COMMON_DIR/seed-identities.sh"; then
        log_info "Dev identities registered."
    else
        log_warn "Identity seeding reported errors (may be benign if identities already exist)."
    fi
}

startup_log_path() {
    if [ -n "$NODE_LOG" ]; then
        echo "$NODE_LOG"
    elif [ -n "$ZOMBIE_LOG" ]; then
        echo "$ZOMBIE_LOG"
    fi
}

startup_service_stopped() {
    if [ -n "$NODE_PID" ] && ! kill -0 "$NODE_PID" 2>/dev/null; then
        return 0
    fi
    if [ -n "$ZOMBIE_PID" ] && ! kill -0 "$ZOMBIE_PID" 2>/dev/null; then
        return 0
    fi
    return 1
}

wait_for_substrate_rpc() {
    local startup_log
    startup_log="$(startup_log_path)"

    log_info "Waiting for local node RPCs..."
    local max_wait="${STACK_RPC_TIMEOUT:-180}"
    for _ in $(seq 1 "$max_wait"); do
        if [ -n "$NODE_PID" ] && basic_substrate_rpc_ready && substrate_block_producing; then
            log_info "Node ready at $SUBSTRATE_RPC_WS"
            return 0
        fi
        if [ -n "$ZOMBIE_PID" ] && substrate_statement_store_ready && substrate_block_producing; then
            log_info "Node ready at $SUBSTRATE_RPC_WS (Statement Store RPCs enabled)"
            return 0
        fi
        if startup_service_stopped; then
            log_error "Local node stopped during startup."
            if [ -n "$startup_log" ] && [ -f "$startup_log" ]; then
                log_info "Recent log output:"
                tail -n 100 "$startup_log" || true
            fi
            return 1
        fi
        sleep 1
    done

    log_error "Local node RPCs did not become ready in time."
    if [ -n "$startup_log" ] && [ -f "$startup_log" ]; then
        log_info "Recent log output:"
        tail -n 100 "$startup_log" || true
    fi
    return 1
}

write_zombienet_config() {
    local config_path="$1"

    cat >"$config_path" <<EOF
[settings]
timeout = 1000

[relaychain]
chain = "rococo-local"
default_command = "polkadot"

  # Rococo-local ships with 6 availability cores. To keep every core
  # staffed each rotation we need at least 6 validators — otherwise
  # groups miss the cores holding Estate/AH/People, and paras stall at
  # block 3 waiting for backing.
  [[relaychain.nodes]]
  name = "alice"
  validator = true
  rpc_port = $STACK_RELAY_ALICE_RPC_PORT
  p2p_port = $STACK_RELAY_ALICE_P2P_PORT
  prometheus_port = $STACK_RELAY_ALICE_PROMETHEUS_PORT

  [[relaychain.nodes]]
  name = "bob"
  validator = true
  rpc_port = $STACK_RELAY_BOB_RPC_PORT
  p2p_port = $STACK_RELAY_BOB_P2P_PORT
  prometheus_port = $STACK_RELAY_BOB_PROMETHEUS_PORT

  [[relaychain.nodes]]
  name = "charlie"
  validator = true
  rpc_port = $STACK_RELAY_CHARLIE_RPC_PORT
  p2p_port = $STACK_RELAY_CHARLIE_P2P_PORT
  prometheus_port = $STACK_RELAY_CHARLIE_PROMETHEUS_PORT

  [[relaychain.nodes]]
  name = "dave"
  validator = true
  rpc_port = $STACK_RELAY_DAVE_RPC_PORT
  p2p_port = $STACK_RELAY_DAVE_P2P_PORT
  prometheus_port = $STACK_RELAY_DAVE_PROMETHEUS_PORT

  [[relaychain.nodes]]
  name = "eve"
  validator = true
  rpc_port = $STACK_RELAY_EVE_RPC_PORT
  p2p_port = $STACK_RELAY_EVE_P2P_PORT
  prometheus_port = $STACK_RELAY_EVE_PROMETHEUS_PORT

  [[relaychain.nodes]]
  name = "ferdie"
  validator = true
  rpc_port = $STACK_RELAY_FERDIE_RPC_PORT
  p2p_port = $STACK_RELAY_FERDIE_P2P_PORT
  prometheus_port = $STACK_RELAY_FERDIE_PROMETHEUS_PORT

# Estate Protocol — our application parachain.
[[parachains]]
id = 2000
chain = "./chain_spec.json"
cumulus_based = true

  [[parachains.collators]]
  name = "estate-collator"
  validator = true
  rpc_port = $STACK_SUBSTRATE_RPC_PORT
  p2p_port = $STACK_COLLATOR_P2P_PORT
  prometheus_port = $STACK_COLLATOR_PROMETHEUS_PORT
  command = "polkadot-omni-node"
  args = ["--enable-statement-store"]

# People Chain — canonical identity registry in the Polkadot ecosystem.
# Re-enabled alongside 4 relay validators + 3 scheduler cores so the
# frontend's identity checks hit a real pallet-identity instead of
# bypassing.
[[parachains]]
id = 1004
chain = "people-rococo-local"
cumulus_based = true

  [[parachains.collators]]
  name = "people-collator"
  validator = true
  rpc_port = $STACK_PEOPLE_RPC_PORT
  p2p_port = $STACK_PEOPLE_P2P_PORT
  prometheus_port = $STACK_PEOPLE_PROMETHEUS_PORT
  command = "polkadot-parachain"

# Asset Hub — Rococo's canonical assets parachain. Required for the
# Estate Protocol XCM flow: wills with remote-transfer bequests emit
# XCM Transact(Proxy.proxy(Balances.transfer)) here.
[[parachains]]
id = 1000
chain = "asset-hub-rococo-local"
cumulus_based = true

  [[parachains.collators]]
  name = "assethub-collator"
  validator = true
  rpc_port = $STACK_ASSETHUB_RPC_PORT
  p2p_port = $STACK_ASSETHUB_P2P_PORT
  prometheus_port = $STACK_ASSETHUB_PROMETHEUS_PORT
  command = "polkadot-parachain"
EOF
}

write_papi_config() {
    local output_path="$1"

    node -e '
const fs = require("fs");
const [inputPath, outputPath, wsUrl] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(inputPath, "utf8"));
config.entries.stack_template.wsUrl = wsUrl;
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
' "$ROOT_DIR/web/.papi/polkadot-api.json" "$output_path" "$SUBSTRATE_RPC_WS"
}

update_papi_descriptors() {
    require_command node

    local papi_config
    papi_config="$(mktemp "$ROOT_DIR/web/papi.local.XXXXXX.json")"
    write_papi_config "$papi_config"

    npm run update-types -- --config "$papi_config"
    npm run codegen -- --config "$papi_config"

    rm -f "$papi_config"
}

export_frontend_runtime_env() {
    export VITE_LOCAL_WS_URL="$SUBSTRATE_RPC_WS"
}

start_zombienet_background() {
    require_command zombienet
    require_command polkadot
    require_command polkadot-omni-node
    validate_zombienet_ports

    ZOMBIE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/polkadot-stack-zombienet.XXXXXX")"
    ZOMBIE_LOG="$ZOMBIE_DIR/zombienet.log"
    ZOMBIE_CONFIG="$ZOMBIE_DIR/zombienet.toml"
    cp "$CHAIN_SPEC" "$ZOMBIE_DIR/chain_spec.json"
    write_zombienet_config "$ZOMBIE_CONFIG"

    (
        cd "$ZOMBIE_DIR"
        zombienet -p native -f -l text -d "$ZOMBIE_DIR" spawn zombienet.toml >"$ZOMBIE_LOG" 2>&1
    ) &
    ZOMBIE_PID=$!

    log_info "Zombienet data dir: $ZOMBIE_DIR"
    log_info "Zombienet config: $ZOMBIE_CONFIG"
    log_info "Zombienet log: $ZOMBIE_LOG"
}

run_local_node_foreground() {
    require_command polkadot-omni-node
    require_port_free "$STACK_SUBSTRATE_RPC_PORT"

    polkadot-omni-node \
        --chain "$CHAIN_SPEC" \
        --tmp \
        --alice \
        --force-authoring \
        --dev-block-time 3000 \
        --no-prometheus \
        --unsafe-force-node-key-generation \
        --rpc-cors all \
        --rpc-port "$STACK_SUBSTRATE_RPC_PORT" \
        --
}

cleanup_local_node() {
    if [ -n "$NODE_PID" ]; then
        kill "$NODE_PID" 2>/dev/null || true
        wait "$NODE_PID" 2>/dev/null || true
    fi
    if [ -n "$NODE_DIR" ]; then
        rm -rf "$NODE_DIR"
    fi
}

cleanup_zombienet() {
    if [ -n "$ZOMBIE_DIR" ]; then
        pkill -INT -f "$ZOMBIE_DIR" 2>/dev/null || true
        sleep 1
        pkill -KILL -f "$ZOMBIE_DIR" 2>/dev/null || true
    fi
    if [ -n "$ZOMBIE_PID" ]; then
        wait "$ZOMBIE_PID" 2>/dev/null || true
    fi
}
