//! # Estate Executor Pallet
//!
//! Core executor pallet of the **Estate Protocol**. Stores a typed list
//! of `Bequest`s (a "will") on behalf of an owner. The will
//! auto-executes if the owner stops sending periodic heartbeats.
//!
//! ## Overview
//!
//! - `create_will`: Store bequests, schedule auto-execution via
//!   `pallet-scheduler` at `expiry_block + 1`.
//! - `heartbeat`: Owner resets the expiry block and reschedules the task.
//! - `execute_will`: Internal call invoked by the scheduler at expiry.
//!   Dispatches each bequest as `Signed(owner)` on a best-effort
//!   basis. Only callable with `Root` origin (i.e. by the scheduler or
//!   governance).
//! - `cancel`: Owner cancels the will and removes the scheduled task.
//!
//! ## Why Typed Bequests Instead of `Vec<RuntimeCall>`
//!
//! An earlier design stored SCALE-encoded `RuntimeCall`s paired with a
//! separate `beneficiaries` list. That created two sources of truth that
//! could drift out of sync (a will could declare Bob as beneficiary but
//! have a call transferring to Eve). The current design encodes the
//! recipient(s) **inside** each bequest variant, making
//! inconsistency impossible by construction.
//!
//! The runtime provides a [`crate::bequest::BequestBuilder`]
//! implementation that translates `Bequest<T>` into the concrete
//! `RuntimeCall` at execution time, so the pallet remains agnostic of
//! which pallets provide Balances, Proxy, etc.
//!
//! ## Why Scheduler Instead of Permissionless Trigger
//!
//! An earlier design let anyone call `trigger` after expiry and paid a
//! random reward. That created a keeper market but also an attack
//! vector: a high-reward will became a target to coerce the owner into
//! missing heartbeats. Switching to scheduler-driven execution removes
//! the third-party incentive entirely — no reward is held, no caller is
//! rewarded, execution happens deterministically in `on_initialize`.
//!
//! ## Best-Effort Execution
//!
//! Bequests are dispatched as `Signed(owner)` at execution time.
//! Each may succeed or fail independently — failures are logged via
//! events but do not revert the overall execution.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;

#[cfg(test)]
mod tests;

pub mod weights;

pub mod bequest;
pub use bequest::{Bequest, BequestBuilder, MaxMultisigDelegates};

pub mod identity;
pub use identity::IdentityCheck;

pub mod certificate;
pub use certificate::CertificateMinter;

pub mod tx_extensions;
pub use tx_extensions::BoostUrgentHeartbeats;

pub mod runtime_api;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

#[frame::pallet]
pub mod pallet {
	use alloc::vec::Vec;
	use crate::bequest::{Bequest, BequestBuilder};
	use crate::certificate::CertificateMinter;
	use crate::identity::IdentityCheck;
	use crate::weights::WeightInfo;
	use codec::Codec;
	use frame::prelude::*;
	use frame::traits::schedule::v3::Named as ScheduleNamed;
	use frame::traits::schedule::DispatchTime;
	use frame::deps::frame_support::traits::Bounded as PreimageBounded;
	use frame::traits::tokens::Balance as BalanceT;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	/// The `Bounded<Call, Hasher>` shape that `pallet-scheduler` wants for
	/// an inlined preimage. Extracted as an alias because the fully
	/// qualified form is an eyesore and trips `clippy::type_complexity`.
	type SchedulerBoundedCall<T> = PreimageBounded<
		<T as Config>::RuntimeCall,
		<<T as Config>::Scheduler as ScheduleNamed<
			BlockNumberFor<T>,
			<T as Config>::RuntimeCall,
			<T as Config>::PalletsOrigin,
		>>::Hasher,
	>;

	#[pallet::config]
	pub trait Config: frame_system::Config {
		type WeightInfo: WeightInfo;

		/// Balance type used by bequests carrying amounts.
		type Balance: BalanceT + MaxEncodedLen;

		/// The overarching call type. Bequests are translated into
		/// this and dispatched as `Signed(owner)` when the will executes.
		/// Must be able to wrap our own `Call<Self>` so we can schedule
		/// `execute_will` via `pallet-scheduler`.
		type RuntimeCall: Parameter
			+ Dispatchable<RuntimeOrigin = <Self as frame_system::Config>::RuntimeOrigin>
			+ GetDispatchInfo
			+ From<Call<Self>>
			+ From<frame_system::Call<Self>>;

		/// Origin type passed to the scheduler. The runtime aggregates all
		/// pallet origins into this type via `construct_runtime!`.
		type PalletsOrigin: From<frame_system::RawOrigin<Self::AccountId>>
			+ Parameter
			+ MaxEncodedLen
			+ Codec;

		/// On-chain task scheduler used to auto-execute wills at expiry.
		type Scheduler: ScheduleNamed<
			BlockNumberFor<Self>,
			<Self as Config>::RuntimeCall,
			Self::PalletsOrigin,
		>;

		/// Translates a `Bequest<Self>` into a concrete `RuntimeCall`
		/// at execution time. Implemented by the runtime.
		type BequestBuilder: BequestBuilder<Self>;

		/// Decides whether a candidate beneficiary has "enough" on-chain
		/// identity to be named in a will. Implemented by the runtime —
		/// in production it checks `pallet-identity` for a Reasonable or
		/// better judgment.
		type IdentityCheck: IdentityCheck<Self>;

		/// Mints a soulbound inheritance certificate NFT to a beneficiary
		/// once per (will, beneficiary) pair during execution.
		type CertificateMinter: CertificateMinter<Self>;

		/// Maximum number of bequests per will.
		#[pallet::constant]
		type MaxBequests: Get<u32>;
	}

	/// Unique identifier for each will.
	pub type WillId = u64;

	/// Priority used when scheduling the auto-execution task.
	const SCHEDULER_PRIORITY: u8 = 100;

	/// Deterministic scheduler task name for a given will.
	pub(crate) fn task_name(will_id: WillId) -> [u8; 32] {
		frame::hashing::blake2_256(&(b"estate_executor", will_id).encode())
	}

	/// Status of a will.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	pub enum WillStatus {
		/// The will is active and awaiting heartbeats.
		Active,
		/// The will has been executed.
		Executed,
	}

	/// A registered will. Bequests live in a separate storage map so
	/// that `Wills` stays small when clients only need metadata.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	#[scale_info(skip_type_params(T))]
	pub struct Will<T: Config> {
		/// The account that created and controls the will.
		pub owner: T::AccountId,
		/// The number of bequests in this will.
		pub bequest_count: u32,
		/// The block interval for the heartbeat period.
		pub block_interval: BlockNumberFor<T>,
		/// The block by which the owner must send a heartbeat.
		/// Auto-execution is scheduled for `expiry_block + 1` so a
		/// heartbeat at `expiry_block` itself is still valid.
		pub expiry_block: BlockNumberFor<T>,
		/// Current status.
		pub status: WillStatus,
		/// The block where the will was executed (zero if never).
		pub executed_block: BlockNumberFor<T>,
	}

	/// Auto-incrementing ID for the next will.
	#[pallet::storage]
	pub type NextWillId<T: Config> = StorageValue<_, WillId, ValueQuery>;

	/// All registered wills, keyed by WillId.
	#[pallet::storage]
	pub type Wills<T: Config> =
		StorageMap<_, Blake2_128Concat, WillId, Will<T>, OptionQuery>;

	/// Typed bequests for each will.
	#[pallet::storage]
	pub type WillBequests<T: Config> = StorageMap<
		_,
		Blake2_128Concat,
		WillId,
		BoundedVec<Bequest<T>, T::MaxBequests>,
		OptionQuery,
	>;

	/// Remembered NFT-collection id for the inheritance certificates
	/// collection. Lazily set the first time a certificate is minted.
	/// The actual collection lives in `pallet-nfts` in the runtime; this
	/// storage just bookkeeps which id was assigned.
	#[pallet::storage]
	pub type CertificateCollectionId<T: Config> = StorageValue<_, u32, OptionQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A new will was registered and its auto-execution scheduled.
		WillCreated {
			id: WillId,
			owner: T::AccountId,
			bequest_count: u32,
			expiry_block: BlockNumberFor<T>,
		},
		/// The owner sent a heartbeat; expiry and scheduled execution moved.
		HeartbeatReceived { id: WillId, new_expiry_block: BlockNumberFor<T> },
		/// The will executed — bequests dispatched (best-effort) and
		/// soulbound certificates minted to unique beneficiaries.
		WillExecuted {
			id: WillId,
			bequests_executed: u32,
			bequests_failed: u32,
			certificates_minted: u32,
			certificates_failed: u32,
		},
		/// A bequest was dispatched during execution.
		BequestDispatched {
			id: WillId,
			index: u32,
			result: DispatchResult,
		},
		/// An inheritance certificate NFT was successfully minted.
		InheritanceCertificateMinted {
			id: WillId,
			beneficiary: T::AccountId,
		},
		/// Minting a certificate failed for this beneficiary. The rest of
		/// the execution still proceeded.
		InheritanceCertificateFailed {
			id: WillId,
			beneficiary: T::AccountId,
			error: DispatchError,
		},
		/// The will was cancelled by the owner.
		WillCancelled { id: WillId },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The will does not exist.
		WillNotFound,
		/// Only the owner can perform this action.
		NotOwner,
		/// The will is not in Active status.
		WillNotActive,
		/// The will has already expired — heartbeat rejected.
		WillExpired,
		/// The block interval must be greater than zero.
		InvalidInterval,
		/// The block interval is too large and would cause overflow.
		BlockIntervalTooLarge,
		/// At least one bequest is required.
		NoBequests,
		/// Too many bequests (exceeds MaxBequests).
		TooManyBequests,
		/// A beneficiary named in a bequest does not have a verified
		/// on-chain identity.
		BeneficiaryNotVerified,
		/// A `Transfer` bequest was created with a zero amount.
		ZeroTransferAmount,
		/// A `MultisigProxy` bequest with enough delegates has an invalid
		/// threshold (zero, or greater than the number of delegates).
		/// Multisigs with fewer than the minimum number of delegates
		/// fail with [`Error::TooFewDelegates`] first.
		InvalidThreshold,
		/// A `MultisigProxy` bequest has fewer than the minimum number
		/// of delegates (2) required for a meaningful multisig.
		TooFewDelegates,
		/// The scheduler refused to schedule or reschedule the task.
		ScheduleFailed,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Register a new will with typed bequests.
		///
		/// Schedules `execute_will(id)` at `expiry_block + 1` via
		/// `pallet-scheduler`. The owner only pays the transaction fee.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::create_will())]
		pub fn create_will(
			origin: OriginFor<T>,
			bequests: Vec<Bequest<T>>,
			block_interval: BlockNumberFor<T>,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(block_interval > Zero::zero(), Error::<T>::InvalidInterval);
			ensure!(!bequests.is_empty(), Error::<T>::NoBequests);

			// Enforce the bequest cap before any per-bequest work — cheap
			// checks first, so an oversized submission is rejected without
			// paying the cost of validating every element.
			let bounded_bequests: BoundedVec<Bequest<T>, T::MaxBequests> =
				bequests
					.try_into()
					.map_err(|_| Error::<T>::TooManyBequests)?;

			// Per-bequest validation:
			//   * shape checks that the pallet can settle from the inputs
			//     alone (zero amount, multisig bounds), so bad data is
			//     rejected up front instead of creating a will that only
			//     fails at execution time;
			//   * identity checks that every named recipient has an
			//     on-chain identity — this is what makes the beneficiary
			//     list meaningful (anyone can be named, only verified
			//     accounts are accepted).
			for bequest in &bounded_bequests {
				match bequest {
					Bequest::Transfer { amount, .. } => {
						ensure!(
							*amount > Zero::zero(),
							Error::<T>::ZeroTransferAmount,
						);
					},
					Bequest::MultisigProxy { delegates, threshold } => {
						ensure!(
							delegates.len() >= 2,
							Error::<T>::TooFewDelegates,
						);
						ensure!(
							*threshold >= 1
								&& (*threshold as usize) <= delegates.len(),
							Error::<T>::InvalidThreshold,
						);
					},
					Bequest::TransferAll { .. } | Bequest::Proxy { .. } => {},
				}
				for recipient in bequest.recipients() {
					ensure!(
						T::IdentityCheck::is_verified(&recipient),
						Error::<T>::BeneficiaryNotVerified,
					);
				}
			}

			let current_block = frame_system::Pallet::<T>::block_number();
			let expiry_block = current_block
				.checked_add(&block_interval)
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;
			let dispatch_at = expiry_block
				.checked_add(&One::one())
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;

			let id = NextWillId::<T>::get();
			NextWillId::<T>::put(id + 1);

			let bequest_count = bounded_bequests.len() as u32;

			Wills::<T>::insert(
				id,
				Will {
					owner: who.clone(),
					bequest_count,
					block_interval,
					expiry_block,
					status: WillStatus::Active,
					executed_block: Zero::zero(),
				},
			);
			WillBequests::<T>::insert(id, bounded_bequests);

			let execute_call: <T as Config>::RuntimeCall =
				Call::<T>::execute_will { id }.into();
			let pallets_origin: T::PalletsOrigin =
				frame_system::RawOrigin::Root.into();
			let bounded_call: SchedulerBoundedCall<T> = PreimageBounded::Inline(
				BoundedVec::try_from(execute_call.encode())
					.map_err(|_| Error::<T>::ScheduleFailed)?,
			);
			T::Scheduler::schedule_named(
				task_name(id),
				DispatchTime::At(dispatch_at),
				None,
				SCHEDULER_PRIORITY,
				pallets_origin,
				bounded_call,
			)
			.map_err(|_| Error::<T>::ScheduleFailed)?;

			Self::deposit_event(Event::WillCreated {
				id,
				owner: who,
				bequest_count,
				expiry_block,
			});
			Ok(())
		}

		/// Send a heartbeat to reset the will's expiry and reschedule the
		/// auto-execution task.
		///
		/// Only the owner can call this. The will must be active and the
		/// expiry block must not have passed yet.
		///
		/// This call is **feeless** when the signer is the current owner
		/// of an active will — keeping your own will alive never costs a
		/// fee.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::heartbeat())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, id: &WillId| -> bool {
			let Ok(who) = ensure_signed(origin.clone()) else { return false; };
			Wills::<T>::get(id)
				.map(|w| w.owner == who && w.status == WillStatus::Active)
				.unwrap_or(false)
		})]
		pub fn heartbeat(origin: OriginFor<T>, id: WillId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let mut will = Wills::<T>::get(id).ok_or(Error::<T>::WillNotFound)?;

			ensure!(will.owner == who, Error::<T>::NotOwner);
			ensure!(will.status == WillStatus::Active, Error::<T>::WillNotActive);

			let current_block = frame_system::Pallet::<T>::block_number();
			ensure!(current_block <= will.expiry_block, Error::<T>::WillExpired);

			let new_expiry_block = current_block
				.checked_add(&will.block_interval)
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;
			let dispatch_at = new_expiry_block
				.checked_add(&One::one())
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;

			will.expiry_block = new_expiry_block;
			Wills::<T>::insert(id, will);

			T::Scheduler::reschedule_named(task_name(id), DispatchTime::At(dispatch_at))
				.map_err(|_| Error::<T>::ScheduleFailed)?;

			Self::deposit_event(Event::HeartbeatReceived { id, new_expiry_block });
			Ok(())
		}

		/// Execute the will: translate each bequest to a RuntimeCall
		/// and dispatch as the owner (best-effort). Only callable with
		/// `Root` origin.
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::execute_will())]
		pub fn execute_will(origin: OriginFor<T>, id: WillId) -> DispatchResult {
			ensure_root(origin)?;
			let mut will = Wills::<T>::get(id).ok_or(Error::<T>::WillNotFound)?;
			ensure!(will.status == WillStatus::Active, Error::<T>::WillNotActive);

			let mut bequests_executed = 0u32;
			let mut bequests_failed = 0u32;
			// Collect the deduplicated recipient set so we mint exactly one
			// certificate per (will, beneficiary) pair even if a recipient
			// appears across multiple bequests.
			let mut unique_recipients: Vec<T::AccountId> = Vec::new();
			if let Some(stored) = WillBequests::<T>::get(id) {
				for (i, dist) in stored.iter().enumerate() {
					let dispatch_result =
						T::BequestBuilder::dispatch(dist, &will.owner);
					if dispatch_result.is_ok() {
						bequests_executed += 1;
					} else {
						bequests_failed += 1;
					}
					Self::deposit_event(Event::BequestDispatched {
						id,
						index: i as u32,
						result: dispatch_result,
					});
					for r in dist.recipients() {
						if !unique_recipients.contains(&r) {
							unique_recipients.push(r);
						}
					}
				}
			}

			will.status = WillStatus::Executed;
			let executed_block = frame_system::Pallet::<T>::block_number();
			will.executed_block = executed_block;
			Wills::<T>::insert(id, will.clone());

			// Mint one inheritance certificate per unique recipient.
			// Individual mint failures are logged but do not revert the
			// whole execution — the bequests themselves already dispatched
			// as best-effort above.
			let mut certificates_minted = 0u32;
			let mut certificates_failed = 0u32;
			for beneficiary in unique_recipients.into_iter() {
				let mint_result = T::CertificateMinter::mint_inheritance_certificate(
					id,
					beneficiary.clone(),
					executed_block,
					will.owner.clone(),
				);
				match mint_result {
					Ok(()) => {
						certificates_minted += 1;
						Self::deposit_event(Event::InheritanceCertificateMinted {
							id,
							beneficiary,
						});
					},
					Err(e) => {
						certificates_failed += 1;
						Self::deposit_event(Event::InheritanceCertificateFailed {
							id,
							beneficiary,
							error: e,
						});
					},
				}
			}

			Self::deposit_event(Event::WillExecuted {
				id,
				bequests_executed,
				bequests_failed,
				certificates_minted,
				certificates_failed,
			});
			Ok(())
		}

		/// Cancel an active will.
		///
		/// Only the owner can cancel. The scheduled auto-execution is
		/// cancelled and the stored bequests are removed.
		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::cancel())]
		pub fn cancel(origin: OriginFor<T>, id: WillId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let will = Wills::<T>::get(id).ok_or(Error::<T>::WillNotFound)?;

			ensure!(will.owner == who, Error::<T>::NotOwner);
			ensure!(will.status == WillStatus::Active, Error::<T>::WillNotActive);

			let _ = T::Scheduler::cancel_named(task_name(id));

			Wills::<T>::remove(id);
			WillBequests::<T>::remove(id);

			Self::deposit_event(Event::WillCancelled { id });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// Public accessor for the certificate collection id. Returns
		/// `None` if no certificate has been minted yet.
		pub fn certificate_collection_id() -> Option<u32> {
			CertificateCollectionId::<T>::get()
		}

		/// Used by the runtime `CertificateMinter` impl to remember which
		/// `pallet-nfts` collection id was allocated on first mint.
		pub fn set_certificate_collection_id(id: u32) {
			CertificateCollectionId::<T>::put(id);
		}

		/// Returns the union of all recipients across a will's
		/// bequests. Deduplication is up to the caller.
		pub fn beneficiaries_of(id: WillId) -> Vec<T::AccountId> {
			WillBequests::<T>::get(id)
				.map(|ds| ds.iter().flat_map(|d| d.recipients()).collect())
				.unwrap_or_default()
		}

		/// Returns the IDs of all active wills that name `account` as a
		/// recipient of at least one bequest.
		pub fn inheritances_of(account: &T::AccountId) -> Vec<WillId> {
			Wills::<T>::iter()
				.filter_map(|(id, will)| {
					if will.status != WillStatus::Active {
						return None;
					}
					let names_account = WillBequests::<T>::get(id)
						.map(|ds| ds.iter().any(|d| d.recipients().contains(account)))
						.unwrap_or(false);
					if names_account { Some(id) } else { None }
				})
				.collect()
		}
	}
}
