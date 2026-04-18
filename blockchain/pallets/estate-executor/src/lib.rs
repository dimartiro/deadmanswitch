//! # Estate Executor Pallet
//!
//! Core executor pallet of the **Estate Protocol**. Stores arbitrary runtime
//! calls (a "will") on behalf of an owner. The will auto-executes if the
//! owner stops sending periodic heartbeats.
//!
//! ## Overview
//!
//! - `create_will`: Store calls + a list of beneficiaries, schedule
//!   auto-execution via `pallet-scheduler` at `expiry_block + 1`.
//! - `heartbeat`: Owner resets the expiry block and reschedules the task.
//! - `execute_will`: Internal call invoked by the scheduler at expiry.
//!   Dispatches the stored calls as `Signed(owner)` on a best-effort basis.
//!   Only callable with `Root` origin (i.e. by the scheduler or governance).
//! - `cancel`: Owner cancels the will and removes the scheduled task.
//!
//! ## Why Scheduler Instead of Permissionless Trigger
//!
//! An earlier design let anyone call `trigger` after expiry and paid a random
//! reward. That created a keeper market but also an attack vector: a
//! high-reward will became a target to coerce the owner into missing
//! heartbeats. Switching to scheduler-driven execution removes the
//! third-party incentive entirely — no reward is held, no caller is
//! rewarded, execution happens deterministically in `on_initialize`.
//!
//! ## Best-Effort Execution
//!
//! Stored calls are dispatched as `Signed(owner)` at execution time. Each
//! call may succeed or fail independently — failures are logged via events
//! but do not revert the overall execution.
//!
//! ## Beneficiaries
//!
//! Each will declares an explicit list of beneficiary accounts. This is
//! purely informational at the executor layer — the actual benefit of a
//! will is whatever its stored calls do (transfers, proxy grants, etc.).
//! The beneficiaries list lets other pallets and runtime APIs answer
//! questions like "which wills name account X as a beneficiary?" without
//! parsing every stored call.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;

#[cfg(test)]
mod tests;

pub mod weights;

pub mod tx_extensions;
pub use tx_extensions::BoostUrgentHeartbeats;

pub mod runtime_api;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

#[frame::pallet]
pub mod pallet {
	use alloc::{boxed::Box, vec::Vec};
	use crate::weights::WeightInfo;
	use codec::Codec;
	use frame::prelude::*;
	use frame::traits::schedule::v3::Named as ScheduleNamed;
	use frame::traits::schedule::DispatchTime;
	use frame::deps::frame_support::traits::Bounded as PreimageBounded;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		type WeightInfo: WeightInfo;

		/// The overarching call type. Stored calls are dispatched as
		/// `Signed(owner)` when the will executes. This type must also be
		/// able to wrap our own `Call<Self>` so we can schedule
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

		/// Maximum number of stored calls per will.
		#[pallet::constant]
		type MaxCalls: Get<u32>;

		/// Maximum encoded size (bytes) of a single stored call.
		#[pallet::constant]
		type MaxCallSize: Get<u32>;

		/// Maximum number of beneficiaries per will.
		#[pallet::constant]
		type MaxBeneficiaries: Get<u32>;
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
		/// The will has been executed and its stored calls dispatched.
		Executed,
	}

	/// A registered will.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	#[scale_info(skip_type_params(T))]
	pub struct Will<T: Config> {
		/// The account that created and controls the will.
		pub owner: T::AccountId,
		/// The number of stored calls.
		pub call_count: u32,
		/// The block interval for the heartbeat period.
		pub block_interval: BlockNumberFor<T>,
		/// The block by which the owner must send a heartbeat. Auto-execution
		/// is scheduled for `expiry_block + 1` so a heartbeat at
		/// `expiry_block` itself is still valid.
		pub expiry_block: BlockNumberFor<T>,
		/// Current status.
		pub status: WillStatus,
		/// The block where the will was executed (zero if never).
		pub executed_block: BlockNumberFor<T>,
		/// Accounts named as beneficiaries of this will. Informational —
		/// the actual benefit comes from whatever the stored calls do.
		pub beneficiaries: BoundedVec<T::AccountId, T::MaxBeneficiaries>,
	}

	/// Auto-incrementing ID for the next will.
	#[pallet::storage]
	pub type NextWillId<T: Config> = StorageValue<_, WillId, ValueQuery>;

	/// All registered wills, keyed by WillId.
	#[pallet::storage]
	pub type Wills<T: Config> =
		StorageMap<_, Blake2_128Concat, WillId, Will<T>, OptionQuery>;

	/// Stored calls for each will, keyed by WillId. Each inner BoundedVec
	/// holds one encoded call.
	#[pallet::storage]
	pub type WillCalls<T: Config> = StorageMap<
		_,
		Blake2_128Concat,
		WillId,
		BoundedVec<BoundedVec<u8, T::MaxCallSize>, T::MaxCalls>,
		OptionQuery,
	>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A new will was registered and its auto-execution scheduled.
		WillCreated {
			id: WillId,
			owner: T::AccountId,
			call_count: u32,
			expiry_block: BlockNumberFor<T>,
		},
		/// The owner sent a heartbeat; expiry and scheduled execution moved.
		HeartbeatReceived { id: WillId, new_expiry_block: BlockNumberFor<T> },
		/// The will executed — stored calls dispatched (best-effort).
		WillExecuted {
			id: WillId,
			calls_executed: u32,
			calls_failed: u32,
		},
		/// A stored call was dispatched during execution.
		CallDispatched {
			id: WillId,
			call_index: u32,
			result: DispatchResult,
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
		/// At least one call is required.
		NoCalls,
		/// Too many calls (exceeds MaxCalls).
		TooManyCalls,
		/// A call exceeds the maximum encoded size.
		CallTooLarge,
		/// Too many beneficiaries (exceeds MaxBeneficiaries).
		TooManyBeneficiaries,
		/// The scheduler refused to schedule or reschedule the task.
		ScheduleFailed,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Register a new will with stored calls and a list of beneficiaries.
		///
		/// Schedules `execute_will(id)` at `expiry_block + 1` via
		/// `pallet-scheduler`. No reward or hold is required — the owner only
		/// pays the transaction fee.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::create_will())]
		pub fn create_will(
			origin: OriginFor<T>,
			calls: Vec<Box<<T as Config>::RuntimeCall>>,
			block_interval: BlockNumberFor<T>,
			beneficiaries: Vec<T::AccountId>,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(block_interval > Zero::zero(), Error::<T>::InvalidInterval);
			ensure!(!calls.is_empty(), Error::<T>::NoCalls);
			ensure!(
				calls.len() <= T::MaxCalls::get() as usize,
				Error::<T>::TooManyCalls,
			);

			// Encode and validate calls
			let mut encoded_calls = BoundedVec::new();
			for call in &calls {
				let encoded: BoundedVec<u8, T::MaxCallSize> = call
					.encode()
					.try_into()
					.map_err(|_| Error::<T>::CallTooLarge)?;
				encoded_calls
					.try_push(encoded)
					.map_err(|_| Error::<T>::TooManyCalls)?;
			}

			let bounded_beneficiaries: BoundedVec<T::AccountId, T::MaxBeneficiaries> =
				beneficiaries
					.try_into()
					.map_err(|_| Error::<T>::TooManyBeneficiaries)?;

			let current_block = frame_system::Pallet::<T>::block_number();
			let expiry_block = current_block
				.checked_add(&block_interval)
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;
			let dispatch_at = expiry_block
				.checked_add(&One::one())
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;

			let id = NextWillId::<T>::get();
			NextWillId::<T>::put(id + 1);

			let call_count = encoded_calls.len() as u32;

			Wills::<T>::insert(
				id,
				Will {
					owner: who.clone(),
					call_count,
					block_interval,
					expiry_block,
					status: WillStatus::Active,
					executed_block: Zero::zero(),
					beneficiaries: bounded_beneficiaries,
				},
			);
			WillCalls::<T>::insert(id, encoded_calls);

			let execute_call: <T as Config>::RuntimeCall =
				Call::<T>::execute_will { id }.into();
			let pallets_origin: T::PalletsOrigin =
				frame_system::RawOrigin::Root.into();
			let bounded_call: PreimageBounded<
				<T as Config>::RuntimeCall,
				<T::Scheduler as ScheduleNamed<
					BlockNumberFor<T>,
					<T as Config>::RuntimeCall,
					T::PalletsOrigin,
				>>::Hasher,
			> = PreimageBounded::Inline(
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
				call_count,
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
		/// This call is **feeless** when the signer is the current owner of
		/// an active will — keeping your own will alive never costs a fee,
		/// so you can never run out of UNIT and lose your protection. Any
		/// other caller (or heartbeat against a non-existent / executed
		/// will) pays normal fees.
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

		/// Execute the will: dispatch stored calls as the owner
		/// (best-effort). Only callable with `Root` origin — the scheduler
		/// invokes this at the scheduled block, and governance/sudo can
		/// also force-execute if needed.
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::execute_will())]
		pub fn execute_will(origin: OriginFor<T>, id: WillId) -> DispatchResult {
			ensure_root(origin)?;
			let mut will = Wills::<T>::get(id).ok_or(Error::<T>::WillNotFound)?;
			ensure!(will.status == WillStatus::Active, Error::<T>::WillNotActive);

			let mut calls_executed = 0u32;
			let mut calls_failed = 0u32;
			if let Some(stored_calls) = WillCalls::<T>::get(id) {
				let owner_origin: T::RuntimeOrigin =
					frame_system::RawOrigin::Signed(will.owner.clone()).into();
				for (i, encoded_call) in stored_calls.iter().enumerate() {
					match <T as Config>::RuntimeCall::decode(&mut &encoded_call[..]) {
						Ok(call) => {
							let result = call.dispatch(owner_origin.clone());
							let dispatch_result =
								result.map(|_| ()).map_err(|e| e.error);
							if dispatch_result.is_ok() {
								calls_executed += 1;
							} else {
								calls_failed += 1;
							}
							Self::deposit_event(Event::CallDispatched {
								id,
								call_index: i as u32,
								result: dispatch_result,
							});
						},
						Err(_) => {
							calls_failed += 1;
							Self::deposit_event(Event::CallDispatched {
								id,
								call_index: i as u32,
								result: Err(DispatchError::Other("CallDecodeFailed")),
							});
						},
					}
				}
			}

			will.status = WillStatus::Executed;
			will.executed_block = frame_system::Pallet::<T>::block_number();
			Wills::<T>::insert(id, will);

			Self::deposit_event(Event::WillExecuted {
				id,
				calls_executed,
				calls_failed,
			});
			Ok(())
		}

		/// Cancel an active will.
		///
		/// Only the owner can cancel. The scheduled auto-execution is
		/// cancelled and the stored calls are removed. Any scheduler error
		/// is ignored — if the task is already gone, the will is still
		/// cleaned up.
		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::cancel())]
		pub fn cancel(origin: OriginFor<T>, id: WillId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let will = Wills::<T>::get(id).ok_or(Error::<T>::WillNotFound)?;

			ensure!(will.owner == who, Error::<T>::NotOwner);
			ensure!(will.status == WillStatus::Active, Error::<T>::WillNotActive);

			let _ = T::Scheduler::cancel_named(task_name(id));

			Wills::<T>::remove(id);
			WillCalls::<T>::remove(id);

			Self::deposit_event(Event::WillCancelled { id });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// Returns the IDs of all active wills naming `account` as a
		/// beneficiary. Used by the runtime API.
		pub fn inheritances_of(account: &T::AccountId) -> Vec<WillId> {
			Wills::<T>::iter()
				.filter_map(|(id, will)| {
					if will.status == WillStatus::Active
						&& will.beneficiaries.contains(account)
					{
						Some(id)
					} else {
						None
					}
				})
				.collect()
		}
	}
}
