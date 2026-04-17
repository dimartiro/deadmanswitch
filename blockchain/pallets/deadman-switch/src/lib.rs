//! # Deadman Switch Pallet
//!
//! A deadman switch pallet that stores arbitrary runtime calls and executes
//! them on the owner's behalf if they fail to send periodic heartbeats.
//!
//! ## Overview
//!
//! - `create_switch`: Store calls and schedule their auto-execution via
//!   `pallet-scheduler` at `expiry_block + 1`.
//! - `heartbeat`: Owner resets the expiry block and reschedules the task.
//! - `execute_switch`: Internal call invoked by the scheduler at expiry.
//!   Dispatches the stored calls as `Signed(owner)` on a best-effort basis.
//!   Only callable with Root origin (i.e. by the scheduler or governance).
//! - `cancel`: Owner cancels the switch and removes the scheduled task.
//!
//! ## Why Scheduler Instead of Permissionless Trigger
//!
//! An earlier design let anyone call `trigger` after expiry and paid a random
//! reward. That created a keeper market but also an attack vector: a
//! high-reward switch became a target to coerce the owner into missing
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
//! ## Runtime Upgrade Warning
//!
//! Stored calls are encoded at creation time. A runtime upgrade that changes
//! call encoding may invalidate stored calls. If this happens, the owner
//! should cancel and recreate the switch.

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
		/// `Signed(owner)` when the switch executes. This type must also be
		/// able to wrap our own `Call<Self>` so we can schedule
		/// `execute_switch` via `pallet-scheduler`.
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

		/// On-chain task scheduler used to auto-execute switches at expiry.
		type Scheduler: ScheduleNamed<
			BlockNumberFor<Self>,
			<Self as Config>::RuntimeCall,
			Self::PalletsOrigin,
		>;

		/// Maximum number of stored calls per switch.
		#[pallet::constant]
		type MaxCalls: Get<u32>;

		/// Maximum encoded size (bytes) of a single stored call.
		#[pallet::constant]
		type MaxCallSize: Get<u32>;
	}

	/// Unique identifier for each switch.
	pub type SwitchId = u64;

	/// Priority used when scheduling the auto-execution task.
	const SCHEDULER_PRIORITY: u8 = 100;

	/// Deterministic scheduler task name for a given switch.
	pub(crate) fn task_name(switch_id: SwitchId) -> [u8; 32] {
		frame::hashing::blake2_256(&(b"deadman_switch", switch_id).encode())
	}

	/// Status of a deadman switch.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	pub enum SwitchStatus {
		/// The switch is active and awaiting heartbeats.
		Active,
		/// The switch has been executed and stored calls dispatched.
		Executed,
	}

	/// A deadman switch entry.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	#[scale_info(skip_type_params(T))]
	pub struct Switch<T: Config> {
		/// The account that created and controls the switch.
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
		pub status: SwitchStatus,
		/// The block where the switch was executed (zero if never).
		pub executed_block: BlockNumberFor<T>,
	}

	/// Auto-incrementing ID for the next switch.
	#[pallet::storage]
	pub type NextSwitchId<T: Config> = StorageValue<_, SwitchId, ValueQuery>;

	/// All deadman switches, keyed by SwitchId.
	#[pallet::storage]
	pub type Switches<T: Config> =
		StorageMap<_, Blake2_128Concat, SwitchId, Switch<T>, OptionQuery>;

	/// Stored calls for each switch, keyed by SwitchId.
	/// Each inner BoundedVec holds one encoded call.
	#[pallet::storage]
	pub type SwitchCalls<T: Config> = StorageMap<
		_,
		Blake2_128Concat,
		SwitchId,
		BoundedVec<BoundedVec<u8, T::MaxCallSize>, T::MaxCalls>,
		OptionQuery,
	>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A new deadman switch was created and its auto-execution scheduled.
		SwitchCreated {
			id: SwitchId,
			owner: T::AccountId,
			call_count: u32,
			expiry_block: BlockNumberFor<T>,
		},
		/// The owner sent a heartbeat; expiry and scheduled execution moved.
		HeartbeatReceived { id: SwitchId, new_expiry_block: BlockNumberFor<T> },
		/// The switch executed — stored calls dispatched (best-effort).
		SwitchExecuted {
			id: SwitchId,
			calls_executed: u32,
			calls_failed: u32,
		},
		/// A stored call was dispatched during execution.
		CallDispatched {
			id: SwitchId,
			call_index: u32,
			result: DispatchResult,
		},
		/// The switch was cancelled by the owner.
		SwitchCancelled { id: SwitchId },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The switch does not exist.
		SwitchNotFound,
		/// Only the owner can perform this action.
		NotOwner,
		/// The switch is not in Active status.
		SwitchNotActive,
		/// The switch has already expired — heartbeat rejected.
		SwitchExpired,
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
		/// The scheduler refused to schedule or reschedule the task.
		ScheduleFailed,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Create a new deadman switch with stored calls.
		///
		/// Schedules `execute_switch(id)` at `expiry_block + 1` via
		/// `pallet-scheduler`. No reward or hold is required — the owner only
		/// pays the transaction fee.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::create_switch())]
		pub fn create_switch(
			origin: OriginFor<T>,
			calls: Vec<Box<<T as Config>::RuntimeCall>>,
			block_interval: BlockNumberFor<T>,
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

			let current_block = frame_system::Pallet::<T>::block_number();
			let expiry_block = current_block
				.checked_add(&block_interval)
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;
			let dispatch_at = expiry_block
				.checked_add(&One::one())
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;

			let id = NextSwitchId::<T>::get();
			NextSwitchId::<T>::put(id + 1);

			let call_count = encoded_calls.len() as u32;

			Switches::<T>::insert(
				id,
				Switch {
					owner: who.clone(),
					call_count,
					block_interval,
					expiry_block,
					status: SwitchStatus::Active,
					executed_block: Zero::zero(),
				},
			);
			SwitchCalls::<T>::insert(id, encoded_calls);

			let execute_call: <T as Config>::RuntimeCall =
				Call::<T>::execute_switch { id }.into();
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

			Self::deposit_event(Event::SwitchCreated {
				id,
				owner: who,
				call_count,
				expiry_block,
			});
			Ok(())
		}

		/// Send a heartbeat to reset the switch expiry and reschedule the
		/// auto-execution task.
		///
		/// Only the owner can call this. The switch must be active and the
		/// expiry block must not have passed yet.
		///
		/// This call is **feeless** when the signer is the current owner of
		/// an active switch — keeping your own switch alive never costs fee,
		/// so you can never run out of UNIT and lose your deadman protection.
		/// Any other caller (or heartbeat against a non-existent / executed
		/// switch) pays normal fees.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::heartbeat())]
		#[pallet::feeless_if(|origin: &OriginFor<T>, id: &SwitchId| -> bool {
			let Ok(who) = ensure_signed(origin.clone()) else { return false; };
			Switches::<T>::get(id)
				.map(|s| s.owner == who && s.status == SwitchStatus::Active)
				.unwrap_or(false)
		})]
		pub fn heartbeat(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let mut switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.owner == who, Error::<T>::NotOwner);
			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			let current_block = frame_system::Pallet::<T>::block_number();
			ensure!(current_block <= switch.expiry_block, Error::<T>::SwitchExpired);

			let new_expiry_block = current_block
				.checked_add(&switch.block_interval)
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;
			let dispatch_at = new_expiry_block
				.checked_add(&One::one())
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;

			switch.expiry_block = new_expiry_block;
			Switches::<T>::insert(id, switch);

			T::Scheduler::reschedule_named(task_name(id), DispatchTime::At(dispatch_at))
				.map_err(|_| Error::<T>::ScheduleFailed)?;

			Self::deposit_event(Event::HeartbeatReceived { id, new_expiry_block });
			Ok(())
		}

		/// Execute the switch: dispatch stored calls as the owner
		/// (best-effort). Only callable with `Root` origin — the scheduler
		/// invokes this at the scheduled block, and governance/sudo can
		/// also force-execute if needed.
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::execute_switch())]
		pub fn execute_switch(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			ensure_root(origin)?;
			let mut switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;
			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			let mut calls_executed = 0u32;
			let mut calls_failed = 0u32;
			if let Some(stored_calls) = SwitchCalls::<T>::get(id) {
				let owner_origin: T::RuntimeOrigin =
					frame_system::RawOrigin::Signed(switch.owner.clone()).into();
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

			switch.status = SwitchStatus::Executed;
			switch.executed_block = frame_system::Pallet::<T>::block_number();
			Switches::<T>::insert(id, switch);

			Self::deposit_event(Event::SwitchExecuted {
				id,
				calls_executed,
				calls_failed,
			});
			Ok(())
		}

		/// Cancel an active switch.
		///
		/// Only the owner can cancel. The scheduled auto-execution is
		/// cancelled and the stored calls are removed. Any scheduler error
		/// is ignored — if the task is already gone, the switch is still
		/// cleaned up.
		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::cancel())]
		pub fn cancel(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.owner == who, Error::<T>::NotOwner);
			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			let _ = T::Scheduler::cancel_named(task_name(id));

			Switches::<T>::remove(id);
			SwitchCalls::<T>::remove(id);

			Self::deposit_event(Event::SwitchCancelled { id });
			Ok(())
		}
	}
}
