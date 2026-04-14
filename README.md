# Dedman Switch

A Substrate pallet that lets users store arbitrary runtime calls that execute automatically on their behalf if they fail to send periodic heartbeats. Built on the Polkadot SDK.

If the owner stops checking in, anyone can trigger the switch — executing the stored calls as the owner and earning a reward for doing so.
