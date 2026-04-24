# PBP Project Retrospective

---

**Your name:** Diego Romero  
**Project name:** Estate Protocol  
**Repo URL:** https://github.com/dimartiro/estate-protocol  
**Path chosen:** Parachain

---

## What I built

Estate Protocol is a Polkadot parachain that automates digital estate planning on-chain. An owner registers a "will" — a list of typed bequests — and sends periodic heartbeats to prove they are alive. If heartbeats stop, `pallet-scheduler` automatically executes the will: it dispatches each bequest as a cross-chain XCM transaction (transfers on Asset Hub, proxy grants), then mints a soulbound NFT inheritance certificate to every beneficiary. The protocol never takes custody of assets; instead it uses the XCM Transact + `Proxy.proxy(owner, _, call)` pattern so the parachain sovereign signs on behalf of the owner on Asset Hub. A fee model with longevity fees (charged per heartbeat interval), flat execution fees, and a `SplitTwoWays` router (30 % burn / 70 % to a treasury account) makes the protocol self-sustaining without introducing a keeper-reward attack surface.

---

## Why I picked this path

I chose a custom Pallet over a contract because the use case requires deep integration with `pallet-scheduler` (deterministic future execution), `pallet-skip-feeless-payment` (feeless heartbeats), and custom transaction extensions (`BoostUrgentHeartbeats`). None of those are accessible from inside a contract.

---

## What worked

**`pallet-scheduler` integration** was remarkably clean.

**XCM Transact + Proxy pattern** delivered the no-custody promise with almost no pallet-side logic. The parachain sovereign account on Asset Hub wraps calls in `Proxy.proxy(owner, _, inner_call)` — the pallet just builds the XCM envelope and sends it.

**`papi`** easy integration between the frontend and the backend.

**`feeless_if` + `pallet-skip-feeless-payment`** made heartbeats feeless for active-will owners with zero pallet-side plumbing. Combined with `BoostUrgentHeartbeats` raising pool priority for near-expiry heartbeats, the heartbeat liveness model held up well under simulated load.

**`SplitTwoWays` fee router** wired 30/70 burn/treasury in about 15 lines of runtime config. The `OnUnbalanced` composability story in FRAME is genuinely good.

---

## What broke

**XCM execution feedback is opaque.** When an XCM Transact fails on Asset Hub, the emitted events on Estate are `Sent` and eventually `NotifyDispatchError` — no indication of _which_ inner call failed or why. Debugging required running both chains in zombienet with `--log xcm=trace` and manually correlating event indices. There is no equivalent of `revert reason` strings for XCM failures.

**Zombienet test flakiness on XCM finality.** The e2e suite polls for XCM acknowledgement events with a fixed-window retry loop. On slower CI machines the relay block confirmations sometimes arrive outside the window, producing false negatives. The fix was bumping retry counts and moving to event-subscription rather than polling, but the tests remained brittle under resource pressure.

**Testing a pallet on Paseo without a registered parachain is a dead end.** There is no way to deploy custom runtime logic to Paseo without going through the full parachain onboarding process — coretime purchase, genesis, collator setup. This means the only realistic testnet loop is zombienet locally, which is slow to start, resource-heavy, and not a faithful replica of real network conditions. There is no equivalent of a smart-contract testnet (deploy in minutes, iterate fast) for pallet development. Every change-compile-test cycle that needs cross-chain behaviour costs a full zombienet boot.

**Identity check on Paseo required a judgment.** `pallet-identity`'s `is_reasonable_judgment` returns false for freshly-registered identities until a registrar provides a judgment. In testing this meant beneficiaries had to go through the full identity registrar flow on People Chain before a will could name them, which slowed down demo setup significantly.

---

## What I'd do differently

**Spike the XCM Transact path in week one** before building anything else. The `BequestBuilder` abstraction hid the XCM complexity cleanly but I only got there after already having built the first version of the pallet with a native-only transfer. Reworking that cost a week.

Skip the custom `EstateExecutorApi` and expose `inheritances_of` as a **storage iterator** instead. The added complexity of a hand-rolled runtime API outweighed the performance benefit for a demo-scale deployment.

**Consider a contract-first approach for the first prototype.** The pallet gives full access to the runtime primitives I needed, but the tradeoff is that the entire testnet loop is locked behind zombienet. A PolkaVM contract on Asset Hub would have let me test the frontend and the full end-to-end flow against Paseo directly, with real wallets and real network conditions, from day one. I would only migrate to a pallet once the UX was proven.

**Integrate Polkadot Triangle and PWallet from the start.** Triangle would have been the right wallet and signing layer, giving the frontend native support inside Desktop, Mobile, and Web hosts without additional code. I would prioritise this over the browser-extension flow.

---

## Stack feedback for Parity

**The XCM developer experience is the biggest bottleneck for parachain builders.** When a Transact fails, the feedback loop is: write XCM → observe opaque error event → add trace logs → rebuild zombienet → wait three minutes for chains to start → repeat. A tool that decodes and surfaces inner-call errors from XCM events in human-readable form (even just in development) would save many hours per project.

**`pallet-scheduler` is underrated and well-documented.** The v3 `Named` API is intuitive and the retry semantics are well-specified. It handled everything I threw at it.

**`pallet-identity`'s judgment requirement creates a demo-setup tax.** For hackathon work the registrar flow is a multi-step manual process on People Chain. A "self-certified" judgment level gated behind some deposit — usable for testnet/demo only — would make identity-gated dApps much easier to showcase.

**`polkadot-api` is genuinely the right move for new TypeScript clients.** The TypeScript codegen, the typed Observable API, and the `signSubmitAndWatch` pattern made the frontend code readable and safe. The one gap is custom runtime APIs — they're invisible to the codegen, requiring manual codec work.

**`feeless_if` + `pallet-skip-feeless-payment` is a beautiful primitive.** Simple, composable, zero pallet-side glue. More pallets should know it exists.

**There should be a faster path to run custom pallet logic without owning a parachain.** Right now the gap between "unit tests pass" and "running on a real network" is enormous — coretime, genesis, collators, zombienet. Smart contracts close that gap in minutes. Parity should invest in a lightweight runtime sandbox or a shared testnet parachain where developers can deploy custom pallets directly, iterate fast, and only graduate to a full parachain once the idea is proven. This is the single change that would most improve the pallet developer experience.

---

## Links

- **Bug reports filed:** —
- **PRs submitted to stack repos:** —
- **Pitch slides / presentation:** `presentation/index.html` (Reveal.js 5.1 deck, open locally)
- **Demo video (if any):** —
- **Live deployment (if any):** https://estate-protocol.dot.li/
- **Anything else worth sharing:**
