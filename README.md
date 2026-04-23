# Estate Protocol

A Polkadot SDK parachain for **digital legacy management**: register a will of arbitrary on-chain actions that auto-executes on your behalf if you stop sending periodic heartbeats.

The core mechanism is the **Estate Executor** pallet. Wills are scheduled deterministically via `pallet-scheduler`; if the owner falls silent, stored calls execute as `Signed(owner)`. Beneficiaries are explicit and queryable via a custom runtime API.

## Layout

| Path | What it contains |
| --- | --- |
| [`blockchain/pallets/estate-executor/`](blockchain/pallets/estate-executor/) | The Estate Executor FRAME pallet |
| [`blockchain/runtime/`](blockchain/runtime/) | The parachain runtime (`estate-protocol-runtime`) |
| [`web/`](web/) | Frontend (React + papi) |
| [`scripts/`](scripts/) | Build, dev-loop, and test helpers |
| [`contracts/evm/`](contracts/evm/) | Optional EVM contract examples |
