# Estate Executor Pallet

Core executor pallet of the **Estate Protocol**. Users register a "will" — a list of typed **bequests** — that auto-executes if the owner stops sending periodic heartbeats. Each bequest translates at execution time to the appropriate `RuntimeCall` and is dispatched as `Signed(owner)` on a best-effort basis.

Execution is driven by `pallet-scheduler`: creating a will schedules its auto-execution at `expiry_block + 1`; heartbeats reschedule; cancel removes the scheduled task.

## How It Works

1. **Owner** registers a will with a list of bequests and a heartbeat interval.
2. The pallet schedules an `execute_will(id)` task via `pallet-scheduler` at `expiry_block + 1`.
3. Owner must send **heartbeats** before the expiry block to move the schedule forward.
4. If the owner stops, the scheduler fires `execute_will` at the scheduled block.
5. On execution: each bequest is translated to a `RuntimeCall` via `BequestBuilder` and dispatched as `Signed(owner)` — best-effort, independent success/failure.
6. Owner can **cancel** an active will at any time; the scheduled task is removed.

## Bequests vs Stored Calls

An earlier design stored arbitrary SCALE-encoded `RuntimeCall`s paired with a separate `beneficiaries` list. That created two sources of truth that could drift out of sync. The current design uses a typed `Bequest<T>` enum with recipients **inside** each variant:

```rust
pub enum Bequest<T: Config> {
    Transfer { dest, amount },
    TransferAll { dest },
    Proxy { delegate },
    MultisigProxy { delegates, threshold },
}
```

Beneficiaries are derived structurally via `Pallet::beneficiaries_of(will_id)`, which iterates the will's bequests and unions their `recipients()`. Inconsistency is impossible by construction.

The runtime provides a `BequestBuilder` impl that translates each variant into the concrete `RuntimeCall` at execution time, keeping the pallet agnostic of which pallets supply Balances, Proxy, etc.

## Why Scheduler, Not a Permissionless Trigger

An earlier design exposed a public `trigger` extrinsic with a random reward paid to the caller. The reward created a keeper market — but also an attack vector: any will with a significant reward became a target to coerce the owner into missing heartbeats.

Switching to scheduler-driven execution removes the third-party incentive entirely. Nobody holds a reward, nobody gets paid, and execution is deterministic. The owner only pays the transaction fee on `create_will`. The bequests still carry whatever incentives they encode (a transfer to a beneficiary is still valuable to that beneficiary) but there is no longer a random-third-party payoff for triggering expiry.

## Dispatchables

| Call | Description |
|---|---|
| `create_will(bequests, block_interval)` | Register bequests and schedule auto-execution at `current_block + block_interval + 1`. |
| `heartbeat(id)` | Owner resets expiry and reschedules the task. Must be called no later than `expiry_block`. **Feeless** when called by the owner of an active will. |
| `execute_will(id)` | Internal — `Root`-only. The scheduler calls this at the scheduled block. Each bequest becomes a `RuntimeCall` and is dispatched as `Signed(owner)`. |
| `cancel(id)` | Owner cancels the will; the scheduled task is removed. |

`execute_will` accepts `Root` origin so governance or sudo can also force-execute if needed — scheduler dispatches use `RawOrigin::Root`.

## Bequest Variants

| Variant | Recipients | Effect |
|---|---|---|
| `Transfer { dest, amount }` | `[dest]` | Transfers `amount` to `dest`. |
| `TransferAll { dest }` | `[dest]` | Transfers the owner's entire free balance to `dest`. |
| `Proxy { delegate }` | `[delegate]` | Grants `delegate` unrestricted proxy access. |
| `MultisigProxy { delegates, threshold }` | `delegates` | Grants a multisig of `delegates` proxy access to the owner's account. |

## Storage

| Item | Description |
|---|---|
| `Wills` | Will metadata: owner, bequest count, interval, expiry block, status, executed block |
| `WillBequests` | Typed bequests per will |
| `NextWillId` | Auto-incrementing ID counter |

Scheduled tasks live in `pallet-scheduler`'s own storage under a deterministic task name (`blake2_256("estate_executor", id)`).

## Runtime API

| Method | Description |
|---|---|
| `EstateExecutorApi::inheritances_of(account)` | IDs of all currently active wills naming `account` as a recipient of at least one bequest. Iterated runtime-side so the frontend can answer "what would I inherit?" without bulk-downloading state. |

## Custom Transaction Extensions

| Extension | Purpose |
|---|---|
| `BoostUrgentHeartbeats` | Hand-written `TransactionExtension`. Promotes heartbeats whose target will expires within `URGENCY_WINDOW` blocks to maximum tx-pool priority. Defends against pool congestion attacks aimed at delaying a heartbeat past expiry. |

The runtime additionally uses `pallet-skip-feeless-payment` to make owner-heartbeats feeless via the pallet's `#[pallet::feeless_if]` predicate.

## Config

| Type | Description |
|---|---|
| `Balance` | Balance type used in `Bequest::Transfer`. |
| `RuntimeCall` | Overarching call type; must include our own `Call<Self>` so `execute_will` can be scheduled. |
| `PalletsOrigin` | Origin aggregation passed to the scheduler. |
| `Scheduler` | Implements `schedule::v3::Named`. |
| `BequestBuilder` | Translator from `Bequest<Self>` to `RuntimeCall`, provided by the runtime. |
| `MaxBequests` | Maximum bequests per will (runtime: 5). |

## Threat Model & Open Questions

- **Scheduler Agenda is public**: anyone can read the target block of a scheduled will. A determined attacker can attempt to saturate that block to push the task into overweight and delay it. Mitigation today is the scheduler's automatic retry-on-overweight plus `BoostUrgentHeartbeats` for the heartbeat side. Prolonged delays require the attacker to saturate consecutive blocks, which scales poorly due to block fees.
- **Priority is cooperative**: `BoostUrgentHeartbeats` raises pool priority but priority is enforced by the node software, not by consensus — a malicious collator can ignore it. Real protection requires collator-set decentralisation.
- **Future hardening**: off-chain worker-driven execution (no public target block) is planned for a later phase, together with reminder and death-verification oracle integration.

## Source Layout

| File | Purpose |
|---|---|
| `src/lib.rs` | Pallet storage, config, calls, events, errors |
| `src/bequest.rs` | `Bequest<T>` enum + `BequestBuilder` trait |
| `src/runtime_api.rs` | `EstateExecutorApi` runtime API declaration |
| `src/tx_extensions.rs` | `BoostUrgentHeartbeats` transaction extension |
| `src/weights.rs` | Placeholder weight functions |
| `src/benchmarking.rs` | Benchmark definitions for all dispatchables |
| `src/mock.rs` | Mock runtime with balances, proxy, multisig, scheduler |
| `src/tests.rs` | Tests covering calls, permissions, proxy, multisig, inheritances |

## Commands

```bash
# Check compilation
cargo check -p pallet-estate-executor

# Run unit tests
cargo test -p pallet-estate-executor

# Run benchmarks
cargo test -p pallet-estate-executor --features runtime-benchmarks
```
