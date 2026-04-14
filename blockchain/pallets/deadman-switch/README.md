# Dedman Switch Pallet

A FRAME pallet that lets users store arbitrary runtime calls that execute on their behalf if they fail to send periodic heartbeats. Calls are dispatched as `Signed(owner)` on a best-effort basis — each may succeed or fail independently.

## How It Works

1. **Owner** creates a switch with a list of runtime calls, a heartbeat interval, and a trigger reward
2. The trigger reward is held from the owner's balance
3. Owner must send **heartbeats** before the expiry block to keep the switch alive
4. If the owner stops sending heartbeats, anyone can **trigger** the switch after expiry
5. On trigger: stored calls execute as the owner (best-effort), caller earns the reward
6. Owner can **cancel** an active switch at any time to reclaim the reward

## Dispatchables

| Call | Description |
|---|---|
| `create_switch(calls, block_interval, trigger_reward)` | Store calls, hold trigger reward. Expires at `current_block + block_interval`. |
| `heartbeat(id)` | Owner resets expiry block. Must be called before expiry. |
| `trigger(id)` | Anyone can call after expiry. Pays reward to caller, dispatches stored calls as owner. |
| `cancel(id)` | Owner cancels and reclaims trigger reward. Stored calls are removed. |

## Stored Calls

Any runtime call can be stored in a switch. Examples tested:

- **Balances.transfer_allow_death** — transfer funds to a specific account
- **Balances.transfer_all** — transfer entire balance to an account
- **Proxy.add_proxy** — grant proxy access to another account
- **Multisig.as_multi** — initiate a multisig proposal requiring further approvals
- **DeadmanSwitchPallet.create_switch** — chain switches (trigger creates another switch)

Calls are encoded at creation time. A **runtime upgrade** that changes call encoding may invalidate stored calls — cancel and recreate the switch if needed.

## Storage

| Item | Description |
|---|---|
| `Switches` | Switch metadata: owner, trigger reward, call count, interval, expiry block, status, executed block |
| `SwitchCalls` | Encoded calls per switch. Preserved after trigger for frontend querying. Removed on cancel. |
| `NextSwitchId` | Auto-incrementing ID counter |

## Config

| Type | Description |
|---|---|
| `Currency` | Fungible token for holding trigger reward |
| `Balance` | Balance type |
| `RuntimeCall` | Overarching call type for stored calls |
| `MaxCalls` | Maximum calls per switch (runtime: 5) |
| `MaxCallSize` | Maximum encoded bytes per call (runtime: 1024) |

## Source Layout

| File | Purpose |
|---|---|
| `src/lib.rs` | Pallet storage, config, calls, events, and errors |
| `src/weights.rs` | Placeholder weight functions |
| `src/benchmarking.rs` | Benchmark definitions for all dispatchables |
| `src/mock.rs` | Mock runtime with pallet-balances, pallet-proxy, and pallet-multisig |
| `src/tests.rs` | 31 tests covering calls, permissions, proxy, multisig, and chained switches |

## Commands

```bash
# Check compilation
cargo check -p pallet-deadman-switch

# Run unit tests
cargo test -p pallet-deadman-switch

# Run benchmarks
cargo test -p pallet-deadman-switch --features runtime-benchmarks
```
