//! Inheritance certificate minting abstraction.
//!
//! When a will executes, the Estate Executor pallet mints one soulbound
//! NFT per (will, beneficiary) pair as a permanent proof of inheritance.
//! The pallet does not depend on `pallet-nfts` directly; the runtime
//! supplies a [`CertificateMinter`] implementation that knows how to
//! drive whichever NFT pallet it hosts.

use crate::pallet::{Config, WillId};
use frame::prelude::DispatchResult;

/// Mints a single inheritance certificate on behalf of a will execution.
///
/// The runtime implementation is responsible for:
///
/// - Ensuring the destination collection exists (create on first use).
/// - Generating a unique item id.
/// - Recording attributes (`will_id`, `executed_block`, `owner`).
/// - Locking the item so it cannot be transferred (soulbound).
///
/// Idempotency is NOT required: the pallet only calls this once per
/// `(will_id, beneficiary)` pair.
pub trait CertificateMinter<T: Config> {
	fn mint_inheritance_certificate(
		will_id: WillId,
		beneficiary: T::AccountId,
		executed_block: BlockNumberFor<T>,
		owner: T::AccountId,
	) -> DispatchResult;
}

// Re-export for convenience in consumers.
use frame::prelude::BlockNumberFor;
