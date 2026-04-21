//! Identity-verification abstraction.
//!
//! The pallet doesn't hard-code `pallet-identity` as a dependency — it
//! asks the runtime whether a given account has "enough" on-chain
//! identity to be a beneficiary. The runtime provides the concrete
//! meaning; tests use a simple hardcoded mock.
//!
//! This lets the pallet work with runtimes that use different identity
//! providers (pallet-identity, an L2 identity bridge, a testnet stub,
//! etc.) without recompiling the pallet.

use crate::pallet::Config;

/// Checks whether an account meets the identity requirements to be
/// named as a beneficiary in a will.
pub trait IdentityCheck<T: Config> {
	/// Returns true iff `account` has a verified on-chain identity
	/// acceptable to this runtime. The definition of "verified" is
	/// runtime-specific — in the Estate Protocol runtime it means an
	/// identity registered in `pallet-identity` with at least one
	/// `Reasonable` or `KnownGood` judgment.
	fn is_verified(account: &T::AccountId) -> bool;
}
