#!/usr/bin/env bash
# Grant `ProxyType::Any` on Asset Hub from each dev testator (Alice,
# Bob, Charlie, Dave) to Estate Protocol's sibling sovereign account.
# After this runs, RemoteTransfer bequests originated from Estate
# Protocol can move funds on behalf of these accounts via
# Transact(Proxy.proxy(...)). In prod, end users would sign this call
# themselves through the "Link to Asset Hub" button in the frontend;
# here we automate it for dev and e2e testing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETHUB_WS="${ASSETHUB_RPC_WS:-ws://127.0.0.1:9948}"

cd "$ROOT_DIR/web"

node --input-type=module -e '
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";

const WS = "'"$ASSETHUB_WS"'";
console.log(`Setting up proxies on Asset Hub at ${WS}...`);

const client = createClient(withPolkadotSdkCompat(getWsProvider(WS)));
const api = await client.getUnsafeApi();

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
function mk(name) {
  const kp = derive("//" + name);
  return {
    name,
    pubkey: kp.publicKey,
    signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign),
  };
}

// Sibling parachain sovereign derivation on Asset Hub:
//   b"sibl" ++ u32_le(para_id) ++ pad-to-32-bytes
function siblingSovereign(paraId) {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode("sibl"), 0);
  new DataView(buf.buffer).setUint32(4, paraId, true);
  return buf;
}

const ESTATE_PARA_ID = 2000;
const delegate = ss58Address(siblingSovereign(ESTATE_PARA_ID));
console.log(`  Delegate (Estate sovereign on Asset Hub): ${delegate}`);

function submitBestBlock(tx, signer, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let sub;
    const timer = setTimeout(() => {
      sub?.unsubscribe();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sub = tx.signSubmitAndWatch(signer).subscribe({
      next: (event) => {
        if ((event.type === "txBestBlocksState" && event.found) || event.type === "finalized") {
          clearTimeout(timer);
          sub?.unsubscribe();
          if (event.dispatchError) reject(new Error(JSON.stringify(event.dispatchError)));
          else resolve({ block: event.block?.number });
        }
      },
      error: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}

async function addProxy(account, pubkey) {
  const [existing] = await api.query.Proxy.Proxies.getValue(
    ss58Address(pubkey),
  );
  if (existing.some((p) => p.delegate === delegate)) {
    console.log(`  ${account.name}: already linked (skipping)`);
    return;
  }
  const tx = api.tx.Proxy.add_proxy({
    delegate: { type: "Id", value: delegate },
    proxy_type: { type: "Any", value: undefined },
    delay: 0,
  });
  const res = await submitBestBlock(tx, account.signer);
  console.log(`  ${account.name}: proxy granted at block #${res.block}`);
}

// Only pre-link Alice and Bob. Charlie and Dave are left unlinked so
// we can exercise the "Link to Asset Hub" button flow in the frontend.
const testators = ["Alice", "Bob"].map(mk);

const results = await Promise.allSettled(
  testators.map((t) => addProxy(t, t.pubkey)),
);
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.status === "rejected") {
    console.log(`  ${testators[i].name}: FAILED - ${r.reason?.message ?? r.reason}`);
  }
}

// Fund the ESP sovereign so it can pay XCM execution fees on Asset
// Hub. Without this, the first `WithdrawAsset` instruction in our
// remote-transfer XCM would fail (sovereign balance 0), aborting the
// Transact before the Proxy.proxy call runs. Dave donates his full
// balance and gets reaped — Alice and Bob stay clean for testing.
const sovBalance = (await api.query.System.Account.getValue(delegate)).data.free;
const FUND_THRESHOLD = 10n * 10n ** 12n; // 10 ROC
if (sovBalance < FUND_THRESHOLD) {
  const payer = mk("Dave");
  const fundTx = api.tx.Balances.transfer_all({
    dest: { type: "Id", value: delegate },
    keep_alive: false,
  });
  try {
    const res = await submitBestBlock(fundTx, payer.signer);
    console.log(`  sovereign funded by Dave (full balance) at block #${res.block}`);
  } catch (e) {
    console.log(`  sovereign funding FAILED - ${e?.message ?? e}`);
  }
} else {
  console.log(`  sovereign already has ${sovBalance} planck, skipping funding`);
}

client.destroy();
process.exit(results.some((r) => r.status === "rejected") ? 1 : 0);
'
