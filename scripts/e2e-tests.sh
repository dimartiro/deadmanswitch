#!/usr/bin/env bash
# E2E test suite for the Estate Protocol.
#
# Verifies the full XCM-to-Asset-Hub bequest flow: a will is created
# on Estate, the scheduler fires it, the runtime sends an XCM Transact
# to Asset Hub, and the proxied call mutates AH state. Also covers
# certificate minting on Estate, heartbeat reschedule, and cancel
# semantics. XCM tests are skipped automatically when Asset Hub is
# unreachable or when the Estate sovereign account is unfunded.
#
# Expects a running node at $SUBSTRATE_RPC_WS (Estate) and optionally
# $ASSETHUB_RPC_WS (Asset Hub). Called by test-zombienet.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ESTATE_WS="${SUBSTRATE_RPC_WS:-ws://127.0.0.1:9944}"
AH_WS="${ASSETHUB_RPC_WS:-ws://127.0.0.1:9948}"

cd "$ROOT_DIR/web"

NODE_NO_WARNINGS=1 node --input-type=module -e '
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { stack_template, asset_hub } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";

const ESTATE_WS = "'"$ESTATE_WS"'";
const AH_WS = "'"$AH_WS"'";

// One ROC = 10^12 plancks (12 decimals).
const ROC = 1_000_000_000_000n;
const ESTATE_PARA_ID = 2000;

// Sibling sovereign account on Asset Hub:
//   b"sibl" ++ u32_le(2000) ++ pad-to-32
const ESTATE_SOVEREIGN = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode("sibl"), 0);
  new DataView(buf.buffer).setUint32(4, ESTATE_PARA_ID, true);
  return ss58Address(buf);
})();

const estate = createClient(withPolkadotSdkCompat(getWsProvider(ESTATE_WS)));
const eApi = estate.getTypedApi(stack_template);
const ah = createClient(withPolkadotSdkCompat(getWsProvider(AH_WS)));
const ahApi = ah.getTypedApi(asset_hub);

const derive = sr25519CreateDerive(
  entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)),
);
function makeAccount(name) {
  const kp = derive("//" + name);
  return {
    name,
    address: ss58Address(kp.publicKey),
    signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign),
  };
}
const Alice = makeAccount("Alice");
const Bob = makeAccount("Bob");
const Charlie = makeAccount("Charlie");

let passed = 0;
let failed = 0;
const failures = [];
function pass(name) {
  passed++;
  console.log("  ✓ " + name);
}
function fail(name, err) {
  failed++;
  failures.push(name);
  console.log("  ✗ " + name + (err ? " — " + err : ""));
}

function submit(tx, signer, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let sub;
    const timer = setTimeout(() => {
      sub?.unsubscribe();
      reject(new Error("tx timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    sub = tx.signSubmitAndWatch(signer).subscribe({
      next: (e) => {
        if ((e.type === "txBestBlocksState" && e.found) || e.type === "finalized") {
          clearTimeout(timer);
          sub?.unsubscribe();
          if (e.dispatchError)
            reject(new Error(JSON.stringify(e.dispatchError)));
          else resolve({ block: e.block?.number ?? null });
        }
      },
      error: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

function waitForBlock(client, target) {
  return new Promise((resolve) => {
    let sub;
    sub = client.bestBlocks$.subscribe((blocks) => {
      const head = blocks[0]?.number ?? 0;
      if (head >= target) {
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll `predicate` every `pollMs` until it returns truthy or `timeoutMs`
// elapses. Returns the truthy value, or the last falsy value on timeout.
// Used instead of a fixed `sleep` when waiting for XCM to land on AH —
// the exact number of relay rounds varies across zombienet runs, and a
// generous fixed sleep still flakes on slower CI while a polling loop
// resolves as soon as the effect is observable.
async function waitUntil(predicate, timeoutMs = 45_000, pollMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(pollMs);
  }
  return last;
}

async function ahBalance(addr) {
  const a = await ahApi.query.System.Account.getValue(addr, { at: "best" });
  return a.data.free;
}

async function ahProxiesOf(addr) {
  const entry = await ahApi.query.Proxy.Proxies.getValue(addr, { at: "best" });
  // pallet-proxy stores (BoundedVec<ProxyDefinition>, deposit). The first
  // tuple element is the delegate list.
  const [delegates] = entry;
  return delegates.map((d) => d.delegate);
}

async function highestWillId() {
  const wills = await eApi.query.EstateExecutor.Wills.getEntries({ at: "best" });
  return wills.reduce((max, w) => {
    const id = w.keyArgs[0];
    return id > max ? id : max;
  }, -1n);
}

async function nftItemsHeld(addr, collectionId) {
  const entries = await eApi.query.Nfts.Account.getEntries(addr, collectionId, {
    at: "best",
  });
  return entries.map((e) => Number(e.keyArgs[2]));
}

// ── Connectivity ─────────────────────────────────────────────────────
console.log("--- Connectivity ---");
try {
  const c = await estate.getChainSpecData();
  pass("Estate: " + c.name);
} catch (e) {
  fail("estate connectivity", e.message);
  process.exit(1);
}

let ahReady = false;
try {
  await Promise.race([
    ah.getChainSpecData().then((c) => {
      pass("Asset Hub: " + c.name);
      ahReady = true;
    }),
    sleep(8000).then(() => {
      throw new Error("AH probe timeout");
    }),
  ]);
} catch (e) {
  fail("Asset Hub connectivity (XCM tests will be skipped)", e.message);
}

// ── Setup: link Alice and verify sovereign is funded ─────────────────
let aliceLinked = false;
let sovereignFunded = false;
if (ahReady) {
  console.log("--- Setup ---");
  try {
    const proxies = await ahProxiesOf(Alice.address);
    if (proxies.includes(ESTATE_SOVEREIGN)) {
      pass("Alice already linked to Asset Hub");
    } else {
      await submit(
        ahApi.tx.Proxy.add_proxy({
          delegate: { type: "Id", value: ESTATE_SOVEREIGN },
          proxy_type: { type: "Any", value: undefined },
          delay: 0,
        }),
        Alice.signer,
      );
      pass("link Alice → ESP sovereign on Asset Hub");
    }
    aliceLinked = true;
  } catch (e) {
    fail("link Alice on AH", e.message);
  }

  try {
    const sb = await ahBalance(ESTATE_SOVEREIGN);
    const inROC = Number(sb / ROC);
    if (sb >= 100n * ROC) {
      pass("ESP sovereign funded: " + inROC + " ROC");
      sovereignFunded = true;
    } else {
      fail(
        "ESP sovereign insufficient (need ≥100 ROC for XCM fees)",
        inROC + " ROC",
      );
    }
  } catch (e) {
    fail("read ESP sovereign balance", e.message);
  }
}

const xcmReady = ahReady && aliceLinked && sovereignFunded;

// ── Local-only tests (no XCM required) ───────────────────────────────

// Test: cancel before expiry
console.log("--- Cancel before expiry ---");
try {
  await submit(
    eApi.tx.EstateExecutor.create_will({
      bequests: [
        {
          type: "Transfer",
          value: { dest: Bob.address, amount: 1n * ROC },
        },
      ],
      block_interval: 100,
    }),
    Alice.signer,
  );
  const id = await highestWillId();
  await submit(
    eApi.tx.EstateExecutor.cancel({ id }),
    Alice.signer,
  );
  const after = await eApi.query.EstateExecutor.Wills.getValue(id, { at: "best" });
  if (!after) pass("will removed after cancel");
  else fail("will still in storage after cancel");
  const beq = await eApi.query.EstateExecutor.WillBequests.getValue(id, { at: "best" });
  if (!beq) pass("bequests cleaned up after cancel");
  else fail("bequests still in storage after cancel");
} catch (e) {
  fail("cancel test", e.message);
}

// Test: heartbeat resets countdown
console.log("--- Heartbeat reschedules execution ---");
try {
  // A larger interval gives the heartbeat enough headroom to push the
  // expiry well past the original — otherwise in fast CI runs the
  // heartbeat lands one block later and the new expiry is only one
  // block past the old, racing the scheduler.
  await submit(
    eApi.tx.EstateExecutor.create_will({
      bequests: [
        {
          type: "Transfer",
          value: { dest: Bob.address, amount: 100n },
        },
      ],
      block_interval: 10,
    }),
    Alice.signer,
  );
  const id = await highestWillId();
  const w0 = await eApi.query.EstateExecutor.Wills.getValue(id, { at: "best" });
  const originalExpiry = w0.expiry_block;

  // Heartbeat to push the expiry forward.
  await submit(
    eApi.tx.EstateExecutor.heartbeat({ id }),
    Alice.signer,
  );
  const w1 = await eApi.query.EstateExecutor.Wills.getValue(id, { at: "best" });
  if (w1.expiry_block > originalExpiry) {
    pass(
      "expiry pushed: " + originalExpiry + " → " + w1.expiry_block,
    );
  } else {
    fail("expiry not pushed", String(w1.expiry_block));
  }

  // Wait exactly up to the original expiry. The scheduler fires at
  // new_expiry+1 > originalExpiry, so at block originalExpiry the will
  // must still be Active — no matter how fast blocks are minted.
  console.log("  waiting to original expiry " + originalExpiry + "…");
  await waitForBlock(estate, originalExpiry);
  const w2 = await eApi.query.EstateExecutor.Wills.getValue(id, { at: "best" });
  if (w2 && w2.status.type === "Active") {
    pass("will still Active at original expiry");
  } else {
    fail("will status at original expiry", w2?.status?.type);
  }

  // Clean up so this will does not fire later in the run.
  await submit(eApi.tx.EstateExecutor.cancel({ id }), Alice.signer);
} catch (e) {
  fail("heartbeat reset test", e.message);
}

// ── XCM tests ────────────────────────────────────────────────────────
if (!xcmReady) {
  console.log("");
  console.log("Skipping XCM tests (preconditions unmet).");
} else {
  // Test: Transfer bequest moves AH balance and mints a certificate.
  console.log("--- Transfer bequest → AH balance + certificate ---");
  try {
    const before = await ahBalance(Bob.address);
    await submit(
      eApi.tx.EstateExecutor.create_will({
        bequests: [
          {
            type: "Transfer",
            value: { dest: Bob.address, amount: 1n * ROC },
          },
        ],
        block_interval: 5,
      }),
      Alice.signer,
    );
    const id = await highestWillId();
    const will = await eApi.query.EstateExecutor.Wills.getValue(id, { at: "best" });
    console.log(
      "  waiting for execution (expiry " + will.expiry_block + ")…",
    );
    await waitForBlock(estate, will.expiry_block + 2);

    // Poll AH until the XCM Transact lands and Bob sees the delta.
    // Relay rounds vary per zombienet run — a fixed sleep was flaky.
    console.log("  waiting for XCM to land on Asset Hub…");
    const arrived = await waitUntil(async () => {
      const now = await ahBalance(Bob.address);
      return now - before === 1n * ROC ? now : null;
    });

    const w = await eApi.query.EstateExecutor.Wills.getValue(id, { at: "best" });
    if (w?.status?.type === "Executed") pass("will marked Executed");
    else fail("will status", w?.status?.type);

    if (arrived !== null) pass("Bob.AH balance += 1 ROC");
    else {
      const diff = (await ahBalance(Bob.address)) - before;
      fail(
        "Bob.AH balance change",
        "expected +1 ROC, got " + diff.toString(),
      );
    }

    const cid = await eApi.query.EstateExecutor.CertificateCollectionId.getValue(
      { at: "best" },
    );
    if (cid !== undefined) {
      pass("certificate collection initialised (id " + cid + ")");
      const items = await nftItemsHeld(Bob.address, cid);
      if (items.length > 0)
        pass("Bob holds " + items.length + " certificate(s)");
      else fail("Bob holds no certificate after Transfer execution");
    } else {
      fail("certificate collection not initialised");
    }
  } catch (e) {
    fail("Transfer bequest test", e.message);
  }

  // Test: Proxy bequest grants Charlie proxy of Alice on AH.
  console.log("--- Proxy bequest → AH proxy registered ---");
  try {
    const beforeProxies = await ahProxiesOf(Alice.address);
    await submit(
      eApi.tx.EstateExecutor.create_will({
        bequests: [{ type: "Proxy", value: { delegate: Charlie.address } }],
        block_interval: 5,
      }),
      Alice.signer,
    );
    const id = await highestWillId();
    const will = await eApi.query.EstateExecutor.Wills.getValue(id, { at: "best" });
    console.log(
      "  waiting for execution (expiry " + will.expiry_block + ")…",
    );
    await waitForBlock(estate, will.expiry_block + 2);
    console.log("  waiting for XCM to land on Asset Hub…");
    const landed = await waitUntil(async () => {
      const proxies = await ahProxiesOf(Alice.address);
      return proxies.includes(Charlie.address) ? proxies : null;
    });

    if (landed !== null) {
      pass("Charlie added as proxy of Alice on AH");
    } else {
      const afterProxies = await ahProxiesOf(Alice.address);
      fail(
        "Charlie not in Alice proxies",
        "before " +
          beforeProxies.length +
          ", after " +
          afterProxies.length,
      );
    }

    const cid =
      await eApi.query.EstateExecutor.CertificateCollectionId.getValue({
        at: "best",
      });
    if (cid !== undefined) {
      const items = await nftItemsHeld(Charlie.address, cid);
      if (items.length > 0)
        pass("Charlie holds " + items.length + " certificate(s)");
      else fail("Charlie holds no certificate after Proxy execution");
    }
  } catch (e) {
    fail("Proxy bequest test", e.message);
  }
}

// ── Results ──────────────────────────────────────────────────────────
console.log("");
console.log("══════════════════════════════════════════");
console.log("  Results: " + passed + " passed, " + failed + " failed");
console.log("══════════════════════════════════════════");
if (failed > 0) {
  console.log("");
  console.log("  Failures:");
  for (const f of failures) console.log("    - " + f);
  console.log("");
}

estate.destroy();
ah.destroy();
process.exit(failed > 0 ? 1 : 0);
'

exit $?
