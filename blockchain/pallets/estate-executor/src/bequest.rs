//! Typed bequest primitives for the Estate Executor.
//!
//! The pallet no longer stores arbitrary `RuntimeCall`s — it stores a
//! small enum of **curated bequest patterns**. Each variant carries its
//! recipients inline, so beneficiary information is **structurally tied
//! to the bequest that benefits them**. There is no separate
//! beneficiaries list that could drift out of sync.
//!
//! At execution time, the runtime translates each `Bequest<T>` into the
//! concrete `RuntimeCall` via the [`BequestBuilder`] trait.

use crate::pallet::Config;
use codec::{Decode, DecodeWithMemTracking, Encode, MaxEncodedLen};
use frame::deps::frame_support::{
	CloneNoBound, DebugNoBound, EqNoBound, PartialEqNoBound,
};
use frame::prelude::*;
use scale_info::TypeInfo;

/// Upper bound on delegates per `MultisigProxy` bequest.
///
/// Declared here rather than in `Config` because the bound is intrinsic
/// to the enum and decodes/encodes the same way regardless of the
/// runtime.
pub type MaxMultisigDelegates = frame::traits::ConstU32<10>;

/// A typed bequest — one "thing that happens on behalf of the owner"
/// when the will executes. Each variant carries its recipient(s) inline.
///
/// The `*NoBound` derives are needed because `T: Config` appears only in
/// associated types (`T::AccountId`, `T::Balance`); the derives don't
/// need `T` itself to implement `Clone`/`Debug`/etc.
#[derive(
	Encode, Decode, DecodeWithMemTracking, TypeInfo, MaxEncodedLen,
	CloneNoBound, DebugNoBound, EqNoBound, PartialEqNoBound,
)]
#[scale_info(skip_type_params(T))]
pub enum Bequest<T: Config> {
	/// Transfer a fixed amount to `dest`.
	Transfer { dest: T::AccountId, amount: T::Balance },
	/// Transfer the owner's entire free balance to `dest`.
	TransferAll { dest: T::AccountId },
	/// Grant `delegate` unrestricted proxy access to the owner's account.
	Proxy { delegate: T::AccountId },
	/// Grant a multisig of `delegates` (threshold `threshold`) unrestricted
	/// proxy access to the owner's account.
	MultisigProxy {
		delegates: BoundedVec<T::AccountId, MaxMultisigDelegates>,
		threshold: u16,
	},
	/// Transfer `amount` on Asset Hub from the will's owner to `dest`.
	/// The owner must have pre-granted `ProxyType::Any` on Asset Hub to
	/// Estate Protocol's sovereign account (done once via the "Link to
	/// Asset Hub" flow). Executed by emitting an XCM
	/// `Transact(Proxy.proxy(Balances.transfer))` where `real` is taken
	/// from the will's owner — not stored on-chain, so a will can't be
	/// crafted to move another account's funds.
	RemoteTransfer { dest: T::AccountId, amount: T::Balance },
}

impl<T: Config> Bequest<T> {
	/// The account(s) that benefit from this bequest. Used by
	/// `Pallet::beneficiaries_of` and the `inheritances_of` runtime API.
	pub fn recipients(&self) -> alloc::vec::Vec<T::AccountId> {
		use alloc::vec;
		match self {
			Bequest::Transfer { dest, .. } => vec![dest.clone()],
			Bequest::TransferAll { dest } => vec![dest.clone()],
			Bequest::Proxy { delegate } => vec![delegate.clone()],
			Bequest::MultisigProxy { delegates, .. } => delegates.to_vec(),
			Bequest::RemoteTransfer { dest, .. } => vec![dest.clone()],
		}
	}
}

/// Translates a `Bequest<T>` into a concrete `RuntimeCall` at execution
/// time. Implemented by the runtime so the pallet stays agnostic of
/// which pallets provide Balances, Proxy, etc.
pub trait BequestBuilder<T: Config> {
	/// Dispatch a single bequest. The trait owns the origin choice —
	/// local variants run as `Signed(owner)`; XCM variants bypass the
	/// dispatch system entirely (e.g. `pallet_xcm::send_xcm` with
	/// `Here`) so the message arrives at its destination with a clean
	/// parachain-sovereign origin instead of a descended one.
	fn dispatch(
		bequest: &Bequest<T>,
		owner: &T::AccountId,
	) -> DispatchResult;
}
