#!/usr/bin/env bash
# Shared E2E test suite for the Estate Protocol.
# Expects a running node at $SUBSTRATE_RPC_WS and deps installed in web/.
# Called by test-e2e.sh and test-zombienet.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

WS_URL="${SUBSTRATE_RPC_WS:-ws://127.0.0.1:9944}"

cd "$ROOT_DIR/web"

node --input-type=module -e '
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { stack_template } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";

const WS_URL = "'"$WS_URL"'";
const client = createClient(withPolkadotSdkCompat(getWsProvider(WS_URL)));
const api = client.getTypedApi(stack_template);

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
function makeSigner(path) {
  const kp = derive(path);
  return getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign);
}
const aliceSigner = makeSigner("//Alice");
const bobAddress = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

let passed = 0;
let failed = 0;
const failures = [];

function pass(name) { passed++; console.log("  PASS: " + name); }
function fail(name, err) {
  failed++; failures.push(name);
  console.log("  FAIL: " + name + (err ? " (" + err + ")" : ""));
}

function waitForBlock(target) {
  return new Promise((resolve) => {
    let sub;
    sub = client.finalizedBlock$.subscribe((block) => {
      if (block.number > target) { sub.unsubscribe(); resolve(); }
    });
  });
}

// --- Chain ---
console.log("--- Chain ---");
try {
  const chain = await client.getChainSpecData();
  if (chain.name) pass("chain: " + chain.name);
  else fail("chain info");
} catch(e) { fail("chain info", e.message); }

// --- Create Will ---
console.log("--- Create Will ---");
let willCreated = false;
try {
  const result = await api.tx.EstateExecutor.create_will({
    bequests: [
      { type: "Transfer", value: { dest: bobAddress, amount: 10_000_000_000_000n } },
    ],
    block_interval: 10,
  }).signAndSubmit(aliceSigner);
  if (result.ok) { pass("create_will (block #" + result.block.number + ")"); willCreated = true; }
  else fail("create_will", JSON.stringify(result.dispatchError));
} catch(e) { fail("create_will", e.message); }

// --- Verify Storage ---
console.log("--- Verify Storage ---");
if (willCreated) {
  try {
    const w = await api.query.EstateExecutor.Wills.getValue(0n);
    if (w && w.status.type === "Active") pass("will is Active");
    else fail("will status", w?.status?.type);
    const bequests = await api.query.EstateExecutor.WillBequests.getValue(0n);
    if (bequests && bequests.length === 1) pass("stored 1 bequest (Transfer)");
    else fail("stored bequests", bequests?.length);
  } catch(e) { fail("verify storage", e.message); }
}

// --- Heartbeat ---
console.log("--- Heartbeat ---");
if (willCreated) {
  try {
    const result = await api.tx.EstateExecutor.heartbeat({ id: 0n }).signAndSubmit(aliceSigner);
    if (result.ok) pass("heartbeat");
    else fail("heartbeat", JSON.stringify(result.dispatchError));
  } catch(e) { fail("heartbeat", e.message); }
}

// --- Wait for expiry ---
console.log("--- Wait for expiry ---");
if (willCreated) {
  const sw = await api.query.EstateExecutor.Wills.getValue(0n);
  const expiry = sw.expiry_block;
  console.log("  Waiting for block > " + expiry + "...");
  await waitForBlock(expiry);
  pass("block passed expiry");
}

// --- Heartbeat after expiry ---
console.log("--- Heartbeat after expiry ---");
if (willCreated) {
  try {
    const result = await api.tx.EstateExecutor.heartbeat({ id: 0n }).signAndSubmit(aliceSigner);
    if (!result.ok) pass("heartbeat after expiry correctly rejected");
    else fail("heartbeat after expiry should have failed");
  } catch(e) { pass("heartbeat after expiry correctly rejected"); }
}

// --- Scheduler auto-executes ---
console.log("--- Scheduler auto-executes ---");
if (willCreated) {
  const bobBefore = (await api.query.System.Account.getValue(bobAddress)).data.free;
  // Auto-execution runs at expiry_block + 1. Wait another block beyond
  // that to give the scheduler a chance to dispatch.
  const swBefore = await api.query.EstateExecutor.Wills.getValue(0n);
  const scheduledAt = swBefore.expiry_block + 1;
  console.log("  Waiting for scheduler to fire at block " + scheduledAt + "...");
  await waitForBlock(scheduledAt);

  try {
    const w = await api.query.EstateExecutor.Wills.getValue(0n);
    if (w && w.status.type === "Executed") pass("will auto-executed");
    else fail("will status after scheduled block", w?.status?.type);
    if (w && w.executed_block > 0) pass("executed_block: #" + w.executed_block);
    else fail("executed_block not set");
  } catch(e) { fail("verify executed", e.message); }

  try {
    const bobAfter = (await api.query.System.Account.getValue(bobAddress)).data.free;
    const diff = bobAfter - bobBefore;
    if (diff === 10_000_000_000_000n) pass("Bob received 10 UNIT from scheduled bequest");
    else fail("Bob balance diff: " + diff);
  } catch(e) { fail("verify Bob balance", e.message); }

  try {
    const bequests = await api.query.EstateExecutor.WillBequests.getValue(0n);
    if (bequests && bequests.length === 1) pass("bequests preserved after execution");
    else fail("bequests after execution", bequests?.length);
  } catch(e) { fail("verify bequests after execution", e.message); }
}

// --- Cancel ---
console.log("--- Cancel ---");
try {
  const createResult = await api.tx.EstateExecutor.create_will({
    bequests: [
      { type: "TransferAll", value: { dest: bobAddress } },
    ],
    block_interval: 100,
  }).signAndSubmit(aliceSigner);

  if (!createResult.ok) fail("create for cancel");
  else {
    const cancelResult = await api.tx.EstateExecutor.cancel({ id: 1n }).signAndSubmit(aliceSigner);
    if (cancelResult.ok) pass("cancel");
    else fail("cancel", JSON.stringify(cancelResult.dispatchError));

    const w = await api.query.EstateExecutor.Wills.getValue(1n);
    if (!w) pass("will removed after cancel");
    else fail("will still in storage");

    const bequests = await api.query.EstateExecutor.WillBequests.getValue(1n);
    if (!bequests) pass("bequests removed after cancel");
    else fail("bequests still in storage");
  }
} catch(e) { fail("cancel test", e.message); }

// --- Results ---
console.log("");
console.log("===============================");
console.log("  Results: " + passed + " passed, " + failed + " failed");
console.log("===============================");

if (failed > 0) {
  console.log("");
  console.log("  Failures:");
  for (const f of failures) console.log("  - " + f);
  console.log("");
}

client.destroy();
process.exit(failed > 0 ? 1 : 0);
'

exit $?
