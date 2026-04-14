#!/usr/bin/env bash
# Shared E2E test suite for Dedman Switch.
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
import { Binary } from "polkadot-api";

const WS_URL = "'"$WS_URL"'";
const client = createClient(withPolkadotSdkCompat(getWsProvider(WS_URL)));
const api = client.getTypedApi(stack_template);

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
function makeSigner(path) {
  const kp = derive(path);
  return getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign);
}
const aliceSigner = makeSigner("//Alice");
const charlieSigner = makeSigner("//Charlie");
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

// --- Create Switch ---
console.log("--- Create Switch ---");
let switchCreated = false;
try {
  const remark = api.tx.System.remark({ remark: Binary.fromText("e2e-test") });
  const transfer = api.tx.Balances.transfer_allow_death({
    dest: { type: "Id", value: bobAddress },
    value: 10_000_000_000_000n,
  });
  const result = await api.tx.DeadmanSwitchPallet.create_switch({
    calls: [remark.decodedCall, transfer.decodedCall],
    block_interval: 10,
    trigger_reward: 1_000_000_000_000n,
  }).signAndSubmit(aliceSigner);
  if (result.ok) { pass("create_switch (block #" + result.block.number + ")"); switchCreated = true; }
  else fail("create_switch", JSON.stringify(result.dispatchError));
} catch(e) { fail("create_switch", e.message); }

// --- Verify Storage ---
console.log("--- Verify Storage ---");
if (switchCreated) {
  try {
    const sw = await api.query.DeadmanSwitchPallet.Switches.getValue(0n);
    if (sw && sw.status.type === "Active") pass("switch is Active");
    else fail("switch status", sw?.status?.type);
    const calls = await api.query.DeadmanSwitchPallet.SwitchCalls.getValue(0n);
    if (calls && calls.length === 2) pass("stored 2 calls (remark + transfer)");
    else fail("stored calls", calls?.length);
  } catch(e) { fail("verify storage", e.message); }
}

// --- Heartbeat ---
console.log("--- Heartbeat ---");
if (switchCreated) {
  try {
    const result = await api.tx.DeadmanSwitchPallet.heartbeat({ id: 0n }).signAndSubmit(aliceSigner);
    if (result.ok) pass("heartbeat");
    else fail("heartbeat", JSON.stringify(result.dispatchError));
  } catch(e) { fail("heartbeat", e.message); }
}

// --- Wait for expiry ---
console.log("--- Wait for expiry ---");
if (switchCreated) {
  const sw = await api.query.DeadmanSwitchPallet.Switches.getValue(0n);
  const expiry = sw.expiry_block;
  console.log("  Waiting for block > " + expiry + "...");
  await waitForBlock(expiry);
  pass("block passed expiry");
}

// --- Heartbeat after expiry ---
console.log("--- Heartbeat after expiry ---");
if (switchCreated) {
  try {
    const result = await api.tx.DeadmanSwitchPallet.heartbeat({ id: 0n }).signAndSubmit(aliceSigner);
    if (!result.ok) pass("heartbeat after expiry correctly rejected");
    else fail("heartbeat after expiry should have failed");
  } catch(e) { pass("heartbeat after expiry correctly rejected"); }
}

// --- Trigger ---
console.log("--- Trigger ---");
if (switchCreated) {
  const bobBefore = (await api.query.System.Account.getValue(bobAddress)).data.free;
  try {
    const result = await api.tx.DeadmanSwitchPallet.trigger({ id: 0n }).signAndSubmit(charlieSigner);
    if (result.ok) pass("trigger (block #" + result.block.number + ")");
    else fail("trigger", JSON.stringify(result.dispatchError));
  } catch(e) { fail("trigger", e.message); }

  try {
    const sw = await api.query.DeadmanSwitchPallet.Switches.getValue(0n);
    if (sw && sw.status.type === "Executed") pass("switch is Executed");
    else fail("switch status after trigger", sw?.status?.type);
    if (sw && sw.executed_block > 0) pass("executed_block: #" + sw.executed_block);
    else fail("executed_block not set");
  } catch(e) { fail("verify executed", e.message); }

  try {
    const bobAfter = (await api.query.System.Account.getValue(bobAddress)).data.free;
    const diff = bobAfter - bobBefore;
    if (diff === 10_000_000_000_000n) pass("Bob received 10 UNIT");
    else fail("Bob balance diff: " + diff);
  } catch(e) { fail("verify Bob balance", e.message); }

  try {
    const calls = await api.query.DeadmanSwitchPallet.SwitchCalls.getValue(0n);
    if (calls && calls.length === 2) pass("calls preserved after trigger");
    else fail("calls after trigger", calls?.length);
  } catch(e) { fail("verify calls after trigger", e.message); }
}

// --- Cancel ---
console.log("--- Cancel ---");
try {
  const remark = api.tx.System.remark({ remark: Binary.fromText("cancel-test") });
  const createResult = await api.tx.DeadmanSwitchPallet.create_switch({
    calls: [remark.decodedCall],
    block_interval: 100,
    trigger_reward: 500_000_000_000n,
  }).signAndSubmit(aliceSigner);

  if (!createResult.ok) fail("create for cancel");
  else {
    const cancelResult = await api.tx.DeadmanSwitchPallet.cancel({ id: 1n }).signAndSubmit(aliceSigner);
    if (cancelResult.ok) pass("cancel");
    else fail("cancel", JSON.stringify(cancelResult.dispatchError));

    const sw = await api.query.DeadmanSwitchPallet.Switches.getValue(1n);
    if (!sw) pass("switch removed after cancel");
    else fail("switch still in storage");

    const calls = await api.query.DeadmanSwitchPallet.SwitchCalls.getValue(1n);
    if (!calls) pass("calls removed after cancel");
    else fail("calls still in storage");
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
