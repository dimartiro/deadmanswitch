//! Custom `TransactionExtension`: boosts transaction-pool priority for
//! heartbeat calls against wills that are close to expiring.
//!
//! ## Why this exists
//!
//! Scheduled execution is deterministic at `expiry_block + 1`. If an owner
//! sends a `heartbeat` *just before* expiry and the block is congested,
//! the heartbeat could be delayed and miss the deadline — the will
//! would fire even though the owner is alive.
//!
//! This extension watches incoming heartbeats and, when the underlying
//! will is within `URGENCY_WINDOW` blocks of expiry, returns a
//! `ValidTransaction` with priority saturated to `u64::MAX`. Collators
//! order the pool by priority, so an urgent heartbeat jumps ahead of
//! ordinary traffic (including any spam an attacker is using to try to
//! push the heartbeat out of the block).
//!
//! ## What it demonstrates
//!
//! Unlike `pallet-skip-feeless-payment` (an off-the-shelf wrapper), this
//! is a **hand-written `TransactionExtension`**: struct, trait impl,
//! lifecycle (`validate` / `prepare` / `post_dispatch`), and runtime
//! wiring done from first principles.
//!
//! ## What it does NOT claim
//!
//! Priority boosting is not a guarantee — if the urgency window itself is
//! saturated by even higher-priority operational traffic, the tx can
//! still be delayed. It raises the cost of the congestion attack, it
//! does not close it. The definitive fix for the scheduler-Agenda
//! predictability is off-chain-worker driven execution (planned).

use crate::{pallet::Call, Config, Pallet, WillId, WillStatus, Wills};
use codec::{Decode, DecodeWithMemTracking, Encode};
use core::marker::PhantomData;
use frame::deps::frame_support::{
	CloneNoBound, DebugNoBound, DefaultNoBound, EqNoBound, PartialEqNoBound,
};
use frame::prelude::*;
use frame::traits::IsSubType;
use scale_info::TypeInfo;
use frame::deps::sp_runtime::{
	traits::{
		DispatchInfoOf, DispatchOriginOf, PostDispatchInfoOf, TransactionExtension,
		ValidateResult,
	},
	transaction_validity::{
		TransactionPriority, TransactionSource, TransactionValidityError, ValidTransaction,
	},
};

/// Heartbeats against wills that expire in fewer than this many blocks
/// are treated as urgent and receive maximum transaction priority.
pub const URGENCY_WINDOW: u32 = 10;

/// `TransactionExtension` that promotes urgent heartbeats to the front of
/// the transaction pool. All other calls are unaffected.
///
/// The `*NoBound` derives are FRAME helpers that derive the standard traits
/// **without** adding `T: Trait` bounds — `T` here is a phantom type
/// parameter and never needs to satisfy `Default`/`Debug`/etc. itself.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	TypeInfo,
	CloneNoBound,
	DebugNoBound,
	DefaultNoBound,
	EqNoBound,
	PartialEqNoBound,
)]
#[scale_info(skip_type_params(T))]
pub struct BoostUrgentHeartbeats<T>(PhantomData<T>);

impl<T> BoostUrgentHeartbeats<T> {
	pub fn new() -> Self {
		Self::default()
	}
}

/// Returns true if the will `id` exists, is active, and expires within
/// `URGENCY_WINDOW` blocks of the current block.
fn is_heartbeat_urgent<T: Config>(id: WillId) -> bool {
	let Some(will) = Wills::<T>::get(id) else {
		return false;
	};
	if will.status != WillStatus::Active {
		return false;
	}
	let now = frame_system::Pallet::<T>::block_number();
	if will.expiry_block < now {
		return false;
	}
	let blocks_until_expiry = will.expiry_block.saturating_sub(now);
	blocks_until_expiry <= URGENCY_WINDOW.into()
}

impl<T: Config + Send + Sync> TransactionExtension<<T as frame_system::Config>::RuntimeCall>
	for BoostUrgentHeartbeats<T>
where
	<T as frame_system::Config>::RuntimeCall: IsSubType<Call<T>>,
{
	const IDENTIFIER: &'static str = "BoostUrgentHeartbeats";
	type Implicit = ();
	type Val = ();
	type Pre = ();

	fn weight(&self, _call: &<T as frame_system::Config>::RuntimeCall) -> Weight {
		// One storage read in the worst case (the matched heartbeat), plus
		// a block-number read. Keep a small conservative constant so the
		// extension's weight does not crowd out real work.
		<T as frame_system::Config>::DbWeight::get().reads(1)
	}

	fn validate(
		&self,
		origin: DispatchOriginOf<<T as frame_system::Config>::RuntimeCall>,
		call: &<T as frame_system::Config>::RuntimeCall,
		_info: &DispatchInfoOf<<T as frame_system::Config>::RuntimeCall>,
		_len: usize,
		_self_implicit: Self::Implicit,
		_inherited_implication: &impl Encode,
		_source: TransactionSource,
	) -> ValidateResult<Self::Val, <T as frame_system::Config>::RuntimeCall> {
		let mut valid = ValidTransaction::default();
		if let Some(Call::heartbeat { id }) = call.is_sub_type() {
			if is_heartbeat_urgent::<T>(*id) {
				valid.priority = TransactionPriority::MAX;
			}
		}
		Ok((valid, (), origin))
	}

	fn prepare(
		self,
		_val: Self::Val,
		_origin: &DispatchOriginOf<<T as frame_system::Config>::RuntimeCall>,
		_call: &<T as frame_system::Config>::RuntimeCall,
		_info: &DispatchInfoOf<<T as frame_system::Config>::RuntimeCall>,
		_len: usize,
	) -> Result<Self::Pre, TransactionValidityError> {
		Ok(())
	}

	fn post_dispatch_details(
		_pre: Self::Pre,
		_info: &DispatchInfoOf<<T as frame_system::Config>::RuntimeCall>,
		_post_info: &PostDispatchInfoOf<<T as frame_system::Config>::RuntimeCall>,
		_len: usize,
		_result: &DispatchResult,
	) -> Result<Weight, TransactionValidityError> {
		Ok(Weight::zero())
	}
}

// The extension holds no per-tx data, but the compiler still needs a
// `Pallet` reference to keep `T` anchored when the user exports the type
// from `lib.rs`.
#[allow(dead_code)]
fn _anchor_pallet_type<T: Config>() -> PhantomData<Pallet<T>> {
	PhantomData
}
