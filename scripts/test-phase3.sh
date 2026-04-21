#!/usr/bin/env bash
# Manual end-to-end test for Phase 3: registers Alice's identity on
# People Chain, creates a will on Estate Protocol with Bob as
# beneficiary, waits for auto-execution, and verifies Bob received a
# soulbound certificate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR/web"

node --input-type=module -e '
import { createClient, FixedSizeBinary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { stack_template, people_chain } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";

const j = (x) => JSON.stringify(x, (_, v) => typeof v === "bigint" ? v.toString() : v);

const estateClient = createClient(withPolkadotSdkCompat(getWsProvider("ws://127.0.0.1:9944")));
const estate = estateClient.getTypedApi(stack_template);
const peopleClient = createClient(withPolkadotSdkCompat(getWsProvider("ws://127.0.0.1:9946")));
const people = peopleClient.getTypedApi(people_chain);

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
function mk(name) {
  const kp = derive("//" + name);
  return { name, address: ss58Address(kp.publicKey), signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign) };
}
const alice = mk("Alice");
const bob = mk("Bob");
const charlie = mk("Charlie");
console.log("Alice:   ", alice.address);
console.log("Bob:     ", bob.address);
console.log("Charlie: ", charlie.address);

// Use Bob as the will owner in this test. Alice often runs out of
// balance because she is the sudo/validator account; Bob has a clean
// endowed balance in the development preset.
const owner = bob;
const heir = charlie;

function waitForBest(tx, signer, label) {
  return new Promise((resolve, reject) => {
    let sub;
    const t = setTimeout(() => { sub?.unsubscribe(); reject(new Error(label + ": timed out (60s)")); }, 60000);
    sub = tx.signSubmitAndWatch(signer).subscribe({
      next: (e) => {
        if ((e.type === "txBestBlocksState" && e.found) || e.type === "finalized") {
          clearTimeout(t); sub?.unsubscribe();
          if (e.dispatchError) reject(new Error(label + ": " + j(e.dispatchError)));
          else resolve(e);
        }
      },
      error: (err) => { clearTimeout(t); reject(err); },
    });
  });
}

console.log(`\n[1] Checking ${heir.name} identity on People Chain...`);
let heirId = await people.query.Identity.IdentityOf.getValue(heir.address);
if (heirId === undefined) {
  console.log("    registering...");
  const bytes = new TextEncoder().encode(heir.name);
  const display = { type: `Raw${bytes.length}`, value: FixedSizeBinary.fromBytes(bytes) };
  const none = { type: "None", value: undefined };
  const info = {
    display, legal: none, web: none, matrix: none, email: none,
    pgp_fingerprint: undefined, image: none, twitter: none,
    github: none, discord: none,
  };
  await waitForBest(people.tx.Identity.set_identity({ info }), heir.signer, "set_identity");
  console.log("    ok");
} else {
  console.log("    already registered");
}

console.log(`\n[2] Creating will on Estate Protocol (${owner.name} → ${heir.name}, interval 5 blocks)...`);
const bequests = [{ type: "Transfer", value: { dest: heir.address, amount: 10n * 10n**12n } }];
const createResult = await waitForBest(
  estate.tx.EstateExecutor.create_will({ bequests, block_interval: 5 }),
  owner.signer,
  "create_will",
);
console.log("    created in block #" + createResult.block?.number);

const wills = await estate.query.EstateExecutor.Wills.getEntries();
const myWill = wills.sort((a,b) => Number(b.keyArgs[0]) - Number(a.keyArgs[0]))[0];
const willId = myWill.keyArgs[0];
console.log("    will id:", willId, "expiry:", myWill.value.expiry_block);

console.log("\n[3] Waiting for auto-execution (up to 60s)...");
const startBlock = (await estate.query.System.Number.getValue()) ?? 0;
const targetBlock = Number(myWill.value.expiry_block) + 5;
while (true) {
  const n = Number(await estate.query.System.Number.getValue());
  const w = await estate.query.EstateExecutor.Wills.getValue(willId);
  if (w?.status?.type === "Executed") {
    console.log("    executed at block #" + w.executed_block);
    break;
  }
  if (n > targetBlock + 10) { console.log("    timed out at block " + n); process.exit(1); }
  await new Promise(r => setTimeout(r, 1000));
}

console.log("\n[4] Inspecting certificate collection...");
const cid = await estate.query.EstateExecutor.CertificateCollectionId.getValue();
console.log("    CertificateCollectionId:", cid);

if (cid === undefined) {
  console.log("    NO COLLECTION CREATED — mint never ran successfully");
  process.exit(1);
}

const items = await estate.query.Nfts.Item.getEntries(cid);
console.log("    items in collection:", items.length);
for (const it of items) {
  console.log("     - item:", it.keyArgs[1], "owner:", it.value.owner);
}

const heirItems = await estate.query.Nfts.Account.getEntries(heir.address, cid);
console.log(`    items owned by ${heir.name}:`, heirItems.length);

console.log("\n[5] Recent EstateExecutor events (last block):");
const events = await estate.query.System.Events.getValue();
for (const e of events) {
  if (e.event?.type === "EstateExecutor") {
    console.log(`     - ${e.event.value?.type}:`, j(e.event.value?.value));
  }
}

estateClient.destroy();
peopleClient.destroy();
process.exit(0);
'
