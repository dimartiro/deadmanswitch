#!/usr/bin/env bash
# Manual RemoteTransfer XCM test: bypasses execute_will and submits
# the same XCM via Sudo.sudo(PolkadotXcm.send) so the message arrives
# at Asset Hub with Root-equivalent origin — the ESP sovereign — and
# WithdrawAsset actually lines up with the sovereign's balance.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR/web"

node --input-type=module -e '
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { stack_template, asset_hub } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address, ss58Decode } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";

const estate = createClient(withPolkadotSdkCompat(getWsProvider("ws://127.0.0.1:9944")));
const estateApi = estate.getTypedApi(stack_template);
const ah = createClient(withPolkadotSdkCompat(getWsProvider("ws://127.0.0.1:9948")));
const ahApi = ah.getTypedApi(asset_hub);

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const alice = { pubkey: derive("//Alice").publicKey, signer: getPolkadotSigner(derive("//Alice").publicKey, "Sr25519", derive("//Alice").sign) };
const bobAddr = ss58Address(derive("//Bob").publicKey);
const aliceAddr = ss58Address(alice.pubkey);

const AH_BALANCES = 10, AH_PROXY = 42, TKA = 3, PROXY_PROXY = 0;
const MULTIADDR_ID = 0, OPT_NONE = 0;

function compactEncode(n) {
  // SCALE Compact<u128>. Cover the 4 modes.
  if (n < 64n) return new Uint8Array([Number(n) << 2]);
  if (n < 16384n) {
    const v = (Number(n) << 2) | 1;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  }
  if (n < 1073741824n) {
    const v = (Number(n) << 2) | 2;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
  }
  // big-int mode
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = [];
  for (let i = hex.length - 2; i >= 0; i -= 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return new Uint8Array([(bytes.length - 4) * 4 + 3, ...bytes]);
}

function buildProxyCall(realPub, destPub, amount) {
  const inner = [AH_BALANCES, TKA, MULTIADDR_ID, ...realPub /* actually we want destPub here */];
  // Oops: let me reconstruct. transfer_keep_alive(dest, value)
  const innerCorrect = new Uint8Array([
    AH_BALANCES, TKA, MULTIADDR_ID,
    ...destPub,
    ...compactEncode(amount),
  ]);
  const outer = new Uint8Array([
    AH_PROXY, PROXY_PROXY, MULTIADDR_ID,
    ...realPub,
    OPT_NONE,
    ...innerCorrect,
  ]);
  return outer;
}

// Real = Alice, Dest = Bob, Amount = 1 ROC
const amount = 1_000_000_000_000n; // 1 ROC
const proxyCall = buildProxyCall(alice.pubkey, ss58Decode(bobAddr)[0], amount);
console.log("proxy call bytes len:", proxyCall.length);
console.log("proxy call hex:", Buffer.from(proxyCall).toString("hex"));

const fees = 100_000_000_000_000n; // 100 ROC

const xcmMessage = {
  type: "V5",
  value: [
    { type: "WithdrawAsset", value: [{ id: { parents: 1, interior: { type: "Here", value: undefined } }, fun: { type: "Fungible", value: fees } }] },
    { type: "BuyExecution", value: { fees: { id: { parents: 1, interior: { type: "Here", value: undefined } }, fun: { type: "Fungible", value: fees } }, weight_limit: { type: "Unlimited", value: undefined } } },
    { type: "Transact", value: {
        origin_kind: { type: "SovereignAccount", value: undefined },
        call: Binary.fromBytes(proxyCall),
        fallback_max_weight: undefined,
      },
    },
  ],
};

const dest = {
  type: "V5",
  value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: 1000 } } },
};

const sendCall = estateApi.tx.PolkadotXcm.send({
  dest,
  message: xcmMessage,
});
const sudoTx = estateApi.tx.Sudo.sudo({ call: sendCall.decodedCall });

console.log("Submitting Sudo(PolkadotXcm.send(...)) as Alice...");

const bobBefore = (await ahApi.query.System.Account.getValue(bobAddr)).data.free;
console.log("Bob AH balance before:", bobBefore.toString());

await new Promise((resolve, reject) => {
  let sub;
  const t = setTimeout(() => { sub?.unsubscribe(); reject(new Error("timeout")); }, 30000);
  sub = sudoTx.signSubmitAndWatch(alice.signer).subscribe({
    next: (e) => {
      if ((e.type === "txBestBlocksState" && e.found) || e.type === "finalized") {
        clearTimeout(t); sub?.unsubscribe();
        console.log("  submitted at block #" + e.block?.number, "ok=" + e.ok);
        resolve();
      }
    },
    error: (err) => { clearTimeout(t); reject(err); },
  });
});

// Give XCM a few seconds to travel + execute on Asset Hub
await new Promise(r => setTimeout(r, 30000));
const bobAfter = (await ahApi.query.System.Account.getValue(bobAddr)).data.free;
console.log("Bob AH balance after: ", bobAfter.toString());
console.log("delta:", (bobAfter - bobBefore).toString());

estate.destroy();
ah.destroy();
' 2>&1 | tail -25
