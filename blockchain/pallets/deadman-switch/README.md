# Deadman Switch Pallet

A FRAME pallet that lets users lock funds with a periodic heartbeat requirement. If the owner fails to send a heartbeat before the expiry block, anyone can trigger the switch to release funds to the beneficiary.

## Dispatchables

- `create_switch(beneficiary, block_interval, deposit)` — Lock `deposit` funds and set a beneficiary. The switch expires at `current_block + block_interval`.
- `heartbeat(id)` — Owner resets the expiry block, proving they are still active. Must be called before expiry.
- `trigger(id)` — Anyone can call this after the expiry block has passed. Transfers the locked funds directly to the beneficiary.
- `cancel(id)` — Owner cancels an active switch and reclaims the locked funds.

## Source Layout

| File | Purpose |
|---|---|
| `src/lib.rs` | Pallet storage, config, calls, events, and errors |
| `src/weights.rs` | Auto-generated weight functions from benchmarks |
| `src/benchmarking.rs` | Benchmark definitions for all dispatchables |
| `src/mock.rs` | Mock runtime with pallet-balances used by unit tests |
| `src/tests.rs` | Unit tests (16 tests covering all calls, permissions, and balance verification) |

## Commands

```bash
# Check compilation
cargo check -p pallet-deadman-switch

# Run unit tests
cargo test -p pallet-deadman-switch

# Run benchmarks
cargo test -p pallet-deadman-switch --features runtime-benchmarks
```

See [`../../README.md`](../../README.md) for full blockchain build and run instructions.
