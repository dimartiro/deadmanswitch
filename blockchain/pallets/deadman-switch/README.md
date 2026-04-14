# Deadman Switch Pallet

A FRAME pallet that lets users store arbitrary runtime calls that execute on their behalf if they fail to send periodic heartbeats. Calls are dispatched as `Signed(owner)` on a best-effort basis — each may succeed or fail independently.

## Dispatchables

- `create_switch(calls, block_interval, trigger_reward)` — Store calls to execute on trigger. Holds `trigger_reward` from the owner. The switch expires at `current_block + block_interval`.
- `heartbeat(id)` — Owner resets the expiry block, proving they are still active. Must be called before expiry.
- `trigger(id)` — Anyone can call this after the expiry block has passed. Pays the trigger reward to the caller, then dispatches stored calls as the owner (best-effort).
- `cancel(id)` — Owner cancels an active switch and reclaims the trigger reward.

## Source Layout

| File | Purpose |
|---|---|
| `src/lib.rs` | Pallet storage, config, calls, events, and errors |
| `src/weights.rs` | Placeholder weight functions |
| `src/benchmarking.rs` | Benchmark definitions for all dispatchables |
| `src/mock.rs` | Mock runtime with pallet-balances, pallet-proxy, and pallet-multisig |
| `src/tests.rs` | 31 unit tests covering calls, permissions, proxy, multisig, and chained switches |

## Commands

```bash
# Check compilation
cargo check -p pallet-deadman-switch

# Run unit tests
cargo test -p pallet-deadman-switch

# Run benchmarks
cargo test -p pallet-deadman-switch --features runtime-benchmarks
```
