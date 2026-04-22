#!/usr/bin/env bash
# Open bidirectional HRMP channels between Estate Protocol (para 2000)
# and Asset Hub (para 1000) via sudo on the relay. Run once after
# zombienet is up.
#
# We can't use zombienet's built-in `[[hrmp_channels]]` genesis hook:
# it injects the channel-open DMQ messages before the parachains have
# booted, and our parachain runtime panics with "DMQ head mismatch"
# when it tries to process them. Opening post-boot via sudo is fine —
# the DMQ message arrives after the parachain has valid state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELAY_WS="${RELAY_RPC_WS:-ws://127.0.0.1:9949}"

cd "$ROOT_DIR/web"

node --input-type=module -e '
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";

const WS = "'"$RELAY_WS"'";
console.log(`Opening HRMP channels via ${WS}...`);

const client = createClient(withPolkadotSdkCompat(getWsProvider(WS)));
const api = await client.getUnsafeApi();

const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)));
const aliceKp = derive("//Alice");
const alice = getPolkadotSigner(aliceKp.publicKey, "Sr25519", aliceKp.sign);

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

async function openChannel(sender, recipient) {
  const inner = api.tx.Hrmp.force_open_hrmp_channel({
    sender,
    recipient,
    max_capacity: 8,
    max_message_size: 8192,
  });
  const sudoCall = api.tx.Sudo.sudo({ call: inner.decodedCall });
  const res = await submitBestBlock(sudoCall, alice);
  console.log(`  channel ${sender} -> ${recipient} opened at block #${res.block}`);
}

try {
  await openChannel(2000, 1000);
  await openChannel(1000, 2000);
} catch (e) {
  console.log(`  FAILED - ${e?.message ?? e}`);
  client.destroy();
  process.exit(1);
}

client.destroy();
process.exit(0);
'
