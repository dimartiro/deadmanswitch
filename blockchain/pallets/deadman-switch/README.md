# Deadman Switch Pallet

A FRAME pallet that lets users store arbitrary runtime calls that execute on their behalf if they fail to send periodic heartbeats. Calls are dispatched as `Signed(owner)` on a best-effort basis — each may succeed or fail independently.

Execution is driven by `pallet-scheduler`: creating a switch schedules its auto-execution at `expiry_block + 1`; heartbeats reschedule; cancel removes the scheduled task.

## How It Works

1. **Owner** creates a switch with a list of runtime calls and a heartbeat interval
2. The pallet schedules an `execute_switch(id)` task via `pallet-scheduler` at `expiry_block + 1`
3. Owner must send **heartbeats** before the expiry block to move the schedule forward
4. If the owner stops sending heartbeats, the scheduler fires `execute_switch` at the scheduled block
5. On execution: stored calls are dispatched as `Signed(owner)` — best-effort, independent success/failure
6. Owner can **cancel** an active switch at any time; the scheduled task is removed

## Why Scheduler, Not a Permissionless Trigger

An earlier design exposed a public `trigger` extrinsic with a random reward paid to the caller. The reward created a keeper market — but also an attack vector: any switch with a significant `max_reward` became a target to coerce the owner into missing heartbeats.

Switching to scheduler-driven execution removes the third-party incentive entirely. Nobody holds a reward, nobody gets paid, and execution is deterministic. The owner only pays the transaction fee on `create_switch`. The stored calls still carry whatever incentives they encode (a transfer to a beneficiary is still valuable to that beneficiary) but there is no longer a random-third-party payoff for triggering expiry.

## Dispatchables

| Call | Description |
|---|---|
| `create_switch(calls, block_interval)` | Store calls and schedule auto-execution at `current_block + block_interval + 1`. |
| `heartbeat(id)` | Owner resets expiry and reschedules the task. Must be called no later than `expiry_block`. |
| `execute_switch(id)` | Internal — `Root`-only. The scheduler calls this at the scheduled block. Dispatches stored calls as `Signed(owner)`. |
| `cancel(id)` | Owner cancels the switch; the scheduled task is removed. |

`execute_switch` accepts `Root` origin so governance or sudo can also force-execute if needed — scheduler dispatches use `RawOrigin::Root`.

## Stored Calls

Any runtime call can be stored. Examples tested:

- **Balances.transfer_allow_death** — transfer funds to a specific account
- **Balances.transfer_all** — transfer entire balance to an account
- **Proxy.add_proxy** — grant proxy access to another account
- **Multisig.as_multi** — initiate a multisig proposal requiring further approvals
- **DeadmanSwitch.create_switch** — chain switches (the executed switch creates another)

Calls are SCALE-encoded at creation time. A **runtime upgrade** that changes call encoding may invalidate stored calls — cancel and recreate the switch if needed.

## Storage

| Item | Description |
|---|---|
| `Switches` | Switch metadata: owner, call count, interval, expiry block, status, executed block |
| `SwitchCalls` | Encoded calls per switch. Preserved after execution for frontend querying. Removed on cancel. |
| `NextSwitchId` | Auto-incrementing ID counter |

Scheduled tasks live in `pallet-scheduler`'s own storage under a deterministic task name (`blake2_256("deadman_switch", id)`).

## Config

| Type | Description |
|---|---|
| `RuntimeCall` | Overarching call type; must include our own `Call<Self>` so `execute_switch` can be scheduled. |
| `PalletsOrigin` | Origin aggregation (typically `OriginCaller`) passed to the scheduler. |
| `Scheduler` | Implements `schedule::v3::Named` — `pallet-scheduler` in practice. |
| `MaxCalls` | Maximum calls per switch (runtime: 5) |
| `MaxCallSize` | Maximum encoded bytes per call (runtime: 1024) |

## Threat Model & Open Questions

- **Scheduler Agenda is public**: anyone can read the target block of a scheduled switch. A determined attacker can attempt to saturate that block to push the task into overweight and delay it. Mitigation today is the scheduler's automatic retry-on-overweight: the task re-runs on the next block. Prolonged delays require the attacker to saturate consecutive blocks, which scales poorly for them due to block fees.
- **Future hardening**: off-chain worker-driven execution (no public target block) is planned for a later phase, together with reminder and death-verification oracle integration.

## Source Layout

| File | Purpose |
|---|---|
| `src/lib.rs` | Pallet storage, config, calls, events, errors |
| `src/weights.rs` | Placeholder weight functions |
| `src/benchmarking.rs` | Benchmark definitions for all dispatchables |
| `src/mock.rs` | Mock runtime with balances, proxy, multisig, scheduler |
| `src/tests.rs` | Tests covering calls, permissions, proxy, multisig, chained switches |

## Commands

```bash
# Check compilation
cargo check -p pallet-deadman-switch

# Run unit tests
cargo test -p pallet-deadman-switch

# Run benchmarks
cargo test -p pallet-deadman-switch --features runtime-benchmarks
```
