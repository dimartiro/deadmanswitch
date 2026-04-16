//! # Deadman Switch Pallet
//!
//! A deadman switch pallet that allows users to store arbitrary runtime calls
//! that execute on their behalf if they fail to send periodic heartbeats.
//!
//! ## Overview
//!
//! - `create_switch`: Store calls to execute on trigger + hold a trigger reward
//! - `heartbeat`: Owner resets the expiry block (proves they are still active)
//! - `trigger`: Anyone calls this after expiry block passes — stored calls are
//!   dispatched as the owner (best-effort), caller receives the trigger reward
//! - `cancel`: Owner cancels and reclaims the trigger reward (only while active)
//!
//! ## Best-Effort Execution
//!
//! Stored calls are dispatched as `Signed(owner)` at trigger time. Each call
//! may succeed or fail independently — failures are logged via events but do
//! not revert the trigger. Call success depends on the owner's state at
//! trigger time (e.g. sufficient balance for transfers).
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

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

#[frame::pallet]
pub mod pallet {
	use alloc::{boxed::Box, vec::Vec};
	use crate::weights::WeightInfo;
	use frame::prelude::*;
	use frame::traits::fungible::{Inspect, Mutate, MutateHold};
	use frame::traits::Randomness;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		type WeightInfo: WeightInfo;

		/// The fungible type for holding the trigger reward.
		type Currency: Inspect<Self::AccountId, Balance = Self::Balance>
			+ Mutate<Self::AccountId>
			+ MutateHold<Self::AccountId, Reason = Self::RuntimeHoldReason>;

		/// The balance type (must match Currency).
		type Balance: frame::traits::tokens::Balance;

		/// Overarching hold reason.
		type RuntimeHoldReason: From<HoldReason>;

		/// The overarching call type. Stored calls are dispatched as `Signed(owner)`
		/// when the switch is triggered.
		type RuntimeCall: Parameter
			+ Dispatchable<RuntimeOrigin = <Self as frame_system::Config>::RuntimeOrigin>
			+ GetDispatchInfo;

		/// Source of on-chain randomness for opaque rewards.
		/// At trigger time, a random fraction of `max_reward` is paid to the
		/// caller and the remainder is burned — nobody knows the split in advance.
		type Randomness: Randomness<
			<Self as frame_system::Config>::Hash,
			BlockNumberFor<Self>,
		>;

		/// Maximum number of stored calls per switch.
		#[pallet::constant]
		type MaxCalls: Get<u32>;

		/// Maximum encoded size (bytes) of a single stored call.
		#[pallet::constant]
		type MaxCallSize: Get<u32>;
	}

	/// Reason for holding funds.
	#[pallet::composite_enum]
	pub enum HoldReason {
		/// Trigger reward locked in a deadman switch.
		DeadmanSwitch,
	}

	/// Unique identifier for each switch.
	pub type SwitchId = u64;

	/// Status of a deadman switch.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	pub enum SwitchStatus {
		/// The switch is active and awaiting heartbeats.
		Active,
		/// The switch has been triggered and calls executed.
		Executed,
	}

	/// A deadman switch entry.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	#[scale_info(skip_type_params(T))]
	pub struct Switch<T: Config> {
		/// The account that created and controls the switch.
		pub owner: T::AccountId,
		/// Maximum reward held — the actual payout is determined randomly at
		/// trigger time so that nobody can predict the incentive in advance.
		pub max_reward: T::Balance,
		/// The number of stored calls.
		pub call_count: u32,
		/// The block interval for the heartbeat period.
		pub block_interval: BlockNumberFor<T>,
		/// The block number by which the owner must send a heartbeat.
		pub expiry_block: BlockNumberFor<T>,
		/// Current status.
		pub status: SwitchStatus,
		/// The block number where the switch was triggered (0 if not yet triggered).
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
	/// Calls are stored as encoded bytes because RuntimeCall does not implement
	/// MaxEncodedLen. Each inner BoundedVec holds one encoded call.
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
		/// A new deadman switch was created.
		SwitchCreated {
			id: SwitchId,
			owner: T::AccountId,
			call_count: u32,
			expiry_block: BlockNumberFor<T>,
		},
		/// The owner sent a heartbeat, resetting the expiry block.
		HeartbeatReceived { id: SwitchId, new_expiry_block: BlockNumberFor<T> },
		/// The switch was triggered — calls dispatched, random reward paid to
		/// caller, remainder burned.
		SwitchTriggered {
			id: SwitchId,
			caller: T::AccountId,
			caller_reward: T::Balance,
			burned: T::Balance,
			calls_executed: u32,
			calls_failed: u32,
		},
		/// A stored call was dispatched during trigger.
		CallDispatched {
			id: SwitchId,
			call_index: u32,
			result: DispatchResult,
		},
		/// The switch was cancelled by the owner.
		SwitchCancelled { id: SwitchId, returned: T::Balance },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The switch does not exist.
		SwitchNotFound,
		/// Only the owner can perform this action.
		NotOwner,
		/// The switch is not in Active status.
		SwitchNotActive,
		/// The switch has not yet expired (expiry block not passed).
		NotYetExpired,
		/// The switch has already expired.
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
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Create a new deadman switch with stored calls.
		///
		/// Holds `max_reward` from the caller. On trigger, a random fraction
		/// of the held amount is paid to the caller and the rest is burned —
		/// nobody can predict the payout in advance.
		///
		/// Stored calls are encoded at creation time. A runtime upgrade may
		/// invalidate them — cancel and recreate the switch if needed.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::create_switch())]
		pub fn create_switch(
			origin: OriginFor<T>,
			calls: Vec<Box<<T as Config>::RuntimeCall>>,
			block_interval: BlockNumberFor<T>,
			max_reward: T::Balance,
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

			// Hold max reward from the owner
			if max_reward > Zero::zero() {
				T::Currency::hold(
					&HoldReason::DeadmanSwitch.into(),
					&who,
					max_reward,
				)?;
			}

			let current_block = frame_system::Pallet::<T>::block_number();
			let expiry_block = current_block
				.checked_add(&block_interval)
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;

			let id = NextSwitchId::<T>::get();
			NextSwitchId::<T>::put(id + 1);

			let call_count = encoded_calls.len() as u32;

			Switches::<T>::insert(
				id,
				Switch {
					owner: who.clone(),
					max_reward,
					call_count,
					block_interval,
					expiry_block,
					status: SwitchStatus::Active,
				executed_block: Zero::zero(),
				},
			);

			SwitchCalls::<T>::insert(id, encoded_calls);

			Self::deposit_event(Event::SwitchCreated {
				id,
				owner: who,
				call_count,
				expiry_block,
			});
			Ok(())
		}

		/// Send a heartbeat to reset the switch expiry block.
		///
		/// Only the owner can call this. The switch must be active and
		/// the expiry block must not have passed yet.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::heartbeat())]
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
			switch.expiry_block = new_expiry_block;
			Switches::<T>::insert(id, switch);

			Self::deposit_event(Event::HeartbeatReceived { id, new_expiry_block });
			Ok(())
		}

		/// Trigger an expired switch.
		///
		/// Anyone can call this once the expiry block has passed. Stored
		/// calls are dispatched as `Signed(owner)` — each call may succeed
		/// or fail independently (best-effort). The caller receives a
		/// random fraction of the held reward; the remainder is burned.
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::trigger())]
		pub fn trigger(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let caller = ensure_signed(origin)?;
			let mut switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			let current_block = frame_system::Pallet::<T>::block_number();
			ensure!(current_block > switch.expiry_block, Error::<T>::NotYetExpired);

			// Determine a random reward between 0 and max_reward.
			// The remainder is burned so that nobody can predict the payout.
			let max_reward = switch.max_reward;
			let (caller_reward, burned) = if max_reward > Zero::zero() {
				let (hash, _) = T::Randomness::random(
					&(b"deadman-switch-reward", id).encode(),
				);
				let raw = u32::decode(&mut hash.as_ref()).unwrap_or(0);
				let ratio = Perbill::from_rational(raw, u32::MAX);
				let reward = ratio * max_reward;
				let burn = max_reward.saturating_sub(reward);

				// Transfer random reward to caller FIRST,
				// so the owner has no active holds when calls execute.
				if reward > Zero::zero() {
					T::Currency::transfer_on_hold(
						&HoldReason::DeadmanSwitch.into(),
						&switch.owner,
						&caller,
						reward,
						frame::traits::tokens::Precision::BestEffort,
						frame::traits::tokens::Restriction::Free,
						frame::traits::tokens::Fortitude::Polite,
					)?;
				}

				// Burn the remainder from hold
				if burn > Zero::zero() {
					T::Currency::burn_held(
						&HoldReason::DeadmanSwitch.into(),
						&switch.owner,
						burn,
						frame::traits::tokens::Precision::BestEffort,
						frame::traits::tokens::Fortitude::Force,
					)?;
				}

				(reward, burn)
			} else {
				(Zero::zero(), Zero::zero())
			};

			// Execute stored calls as the owner (best-effort)
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
			switch.executed_block = current_block;
			Switches::<T>::insert(id, switch);

			Self::deposit_event(Event::SwitchTriggered {
				id,
				caller,
				caller_reward,
				burned,
				calls_executed,
				calls_failed,
			});
			Ok(())
		}

		/// Cancel an active switch and reclaim the trigger reward.
		///
		/// Only the owner can cancel. The switch must be active.
		/// Stored calls are removed from storage.
		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::cancel())]
		pub fn cancel(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.owner == who, Error::<T>::NotOwner);
			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			// Release max reward back to the owner
			let returned = switch.max_reward;
			if returned > Zero::zero() {
				T::Currency::release(
					&HoldReason::DeadmanSwitch.into(),
					&who,
					returned,
					frame::traits::tokens::Precision::BestEffort,
				)?;
			}

			Switches::<T>::remove(id);
			SwitchCalls::<T>::remove(id);

			Self::deposit_event(Event::SwitchCancelled { id, returned });
			Ok(())
		}

	}
}
