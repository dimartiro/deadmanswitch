#!/usr/bin/env bash
# Seed on-chain identities on People Chain for dev accounts
# (Alice/Bob/Charlie/Dave). Run once after zombienet is up — the frontend
# flow assumes these exist.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PEOPLE_WS="${PEOPLE_RPC_WS:-ws://127.0.0.1:9946}"

cd "$ROOT_DIR/web"

node --input-type=module -e '
import { createClient, FixedSizeBinary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { people_chain } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";

const WS = "'"$PEOPLE_WS"'";
console.log(`Seeding identities on ${WS}...`);

const client = createClient(withPolkadotSdkCompat(getWsProvider(WS)));
const api = client.getTypedApi(people_chain);

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const accounts = ["Alice", "Bob", "Charlie", "Dave"].map((name) => {
  const kp = derive("//" + name);
  return { name, signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign), pubkey: kp.publicKey };
});

function buildInfo(name) {
  const bytes = new TextEncoder().encode(name);
  let display;
  if (bytes.length === 0) display = { type: "None", value: undefined };
  else if (bytes.length === 1) display = { type: "Raw1", value: bytes[0] };
  else display = { type: `Raw${bytes.length}`, value: FixedSizeBinary.fromBytes(bytes) };
  const none = { type: "None", value: undefined };
  return {
    display, legal: none, web: none, matrix: none, email: none,
    pgp_fingerprint: undefined, image: none, twitter: none,
    github: none, discord: none,
  };
}

// Resolve as soon as the tx is in a best block (or times out). Waiting
// for finalisation hangs for ~30s on zombienet startup because the
// relay chain hasn’t finalised any parachain blocks yet.
function submitBestBlock(tx, signer, name, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let sub;
    const timer = setTimeout(() => {
      sub?.unsubscribe();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sub = tx.signSubmitAndWatch(signer).subscribe({
      next: (event) => {
        console.log(`  [${name}] event=${event.type}${event.found !== undefined ? ` found=${event.found}` : ""}`);
        if ((event.type === "txBestBlocksState" && event.found) || event.type === "finalized") {
          clearTimeout(timer);
          sub?.unsubscribe();
          if (event.dispatchError) {
            reject(new Error(JSON.stringify(event.dispatchError)));
          } else {
            resolve({ block: event.block?.number });
          }
        }
      },
      error: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}

// Dispatch all set_identity calls in parallel. Each targets a distinct
// signer so nonces do not collide; a single lingering subscription from
// a prior iteration (sequential mode) was observed to stall later
// submissions, so parallel is actually safer here.
const results = await Promise.allSettled(
  accounts.map(async ({ name, signer }) => {
    const tx = api.tx.Identity.set_identity({ info: buildInfo(name) });
    const res = await submitBestBlock(tx, signer, name);
    return { name, block: res.block };
  }),
);

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const who = accounts[i].name;
  if (r.status === "fulfilled") console.log(`  ${who}: registered at block #${r.value.block}`);
  else console.log(`  ${who}: FAILED - ${r.reason?.message ?? r.reason}`);
}

client.destroy();
process.exit(results.some((r) => r.status === "rejected") ? 1 : 0);
'
