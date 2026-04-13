//! # Deadman Switch Pallet
//!
//! A deadman switch pallet that allows users to lock funds with a periodic
//! heartbeat requirement. If the owner fails to send a heartbeat before the
//! expiry_block, anyone can trigger the switch to release funds to the beneficiary.
//!
//! ## Overview
//!
//! - `create_switch`: Lock a deposit and set a beneficiary + block interval
//! - `heartbeat`: Owner resets the expiry_block (proves they are still active)
//! - `trigger`: Anyone calls this after expiry_block passes to release funds
//! - `cancel`: Owner cancels and reclaims funds (only while active)

#![cfg_attr(not(feature = "std"), no_std)]

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
	use crate::weights::WeightInfo;
	use frame::prelude::*;
	use frame::traits::fungible::{Inspect, Mutate, MutateHold};

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		type WeightInfo: WeightInfo;

		/// The fungible type for holding and transferring deposits.
		type Currency: Inspect<Self::AccountId, Balance = Self::Balance>
			+ Mutate<Self::AccountId>
			+ MutateHold<Self::AccountId, Reason = Self::RuntimeHoldReason>;

		/// The balance type (must match Currency).
		type Balance: frame::traits::tokens::Balance;

		/// Overarching hold reason.
		type RuntimeHoldReason: From<HoldReason>;
	}

	/// Reason for holding funds.
	#[pallet::composite_enum]
	pub enum HoldReason {
		/// Funds locked in a deadman switch.
		DeadmanSwitch,
	}

	/// Unique identifier for each switch.
	pub type SwitchId = u64;

	/// Status of a deadman switch.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	pub enum SwitchStatus {
		/// The switch is active and awaiting heartbeats.
		Active,
		/// The switch has been triggered and funds released.
		Executed,
	}

	/// A deadman switch entry.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	#[scale_info(skip_type_params(T))]
	pub struct Switch<T: Config> {
		/// The account that created and controls the switch.
		pub owner: T::AccountId,
		/// The account that receives funds when the switch triggers.
		pub beneficiary: T::AccountId,
		/// The amount of funds locked.
		pub deposit: T::Balance,
		/// The block interval for the heartbeat period.
		pub block_interval: BlockNumberFor<T>,
		/// The block number expiry_block — heartbeat must arrive before this.
		pub expiry_block: BlockNumberFor<T>,
		/// Current status.
		pub status: SwitchStatus,
	}

	/// Auto-incrementing ID for the next switch.
	#[pallet::storage]
	pub type NextSwitchId<T: Config> = StorageValue<_, SwitchId, ValueQuery>;

	/// All deadman switches, keyed by SwitchId.
	#[pallet::storage]
	pub type Switches<T: Config> =
		StorageMap<_, Blake2_128Concat, SwitchId, Switch<T>, OptionQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A new deadman switch was created.
		SwitchCreated {
			id: SwitchId,
			owner: T::AccountId,
			beneficiary: T::AccountId,
			deposit: T::Balance,
			expiry_block: BlockNumberFor<T>,
		},
		/// The owner sent a heartbeat, resetting the expiry_block.
		HeartbeatReceived { id: SwitchId, new_expiry_block: BlockNumberFor<T> },
		/// The switch was triggered and funds released to the beneficiary.
		SwitchTriggered {
			id: SwitchId,
			beneficiary: T::AccountId,
			amount: T::Balance,
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
		/// The switch has not yet expired (expiry_block not passed).
		NotYetExpired,
		/// The block interval must be greater than zero.
		InvalidInterval,
		/// The beneficiary cannot be the same as the owner.
		BeneficiaryIsOwner,
		/// The deposit must be greater than zero.
		DepositTooLow,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Create a new deadman switch.
		///
		/// The caller becomes the owner. Funds are held from the caller's
		/// account. The expiry_block is set to `current_block + block_interval`.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::create_switch())]
		pub fn create_switch(
			origin: OriginFor<T>,
			beneficiary: T::AccountId,
			block_interval: BlockNumberFor<T>,
			deposit: T::Balance,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(block_interval > Zero::zero(), Error::<T>::InvalidInterval);
			ensure!(deposit > Zero::zero(), Error::<T>::DepositTooLow);
			ensure!(beneficiary != who, Error::<T>::BeneficiaryIsOwner);

			// Hold funds from the owner
			T::Currency::hold(&HoldReason::DeadmanSwitch.into(), &who, deposit)?;

			let current_block = frame_system::Pallet::<T>::block_number();
			let expiry_block = current_block + block_interval;

			let id = NextSwitchId::<T>::get();
			NextSwitchId::<T>::put(id + 1);

			Switches::<T>::insert(
				id,
				Switch {
					owner: who.clone(),
					beneficiary: beneficiary.clone(),
					deposit,
					block_interval,
					expiry_block,
					status: SwitchStatus::Active,
				},
			);

			Self::deposit_event(Event::SwitchCreated {
				id,
				owner: who,
				beneficiary,
				deposit,
				expiry_block,
			});
			Ok(())
		}

		/// Send a heartbeat to reset the switch expiry_block.
		///
		/// Only the owner can call this. The switch must be active and
		/// the expiry_block must not have passed yet.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::heartbeat())]
		pub fn heartbeat(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let mut switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.owner == who, Error::<T>::NotOwner);
			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			let current_block = frame_system::Pallet::<T>::block_number();
			ensure!(current_block <= switch.expiry_block, Error::<T>::NotYetExpired);

			let new_expiry_block = current_block + switch.block_interval;
			switch.expiry_block = new_expiry_block;
			Switches::<T>::insert(id, switch);

			Self::deposit_event(Event::HeartbeatReceived { id, new_expiry_block });
			Ok(())
		}

		/// Trigger an expired switch, releasing funds to the beneficiary.
		///
		/// Anyone can call this once the expiry_block has passed. The held funds
		/// are released from the owner and transferred to the beneficiary.
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::trigger())]
		pub fn trigger(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let _who = ensure_signed(origin)?;
			let mut switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			let current_block = frame_system::Pallet::<T>::block_number();
			ensure!(current_block > switch.expiry_block, Error::<T>::NotYetExpired);

			// Transfer directly from hold to beneficiary (atomic, no intermediate free state)
			let amount = switch.deposit;
			T::Currency::transfer_on_hold(
				&HoldReason::DeadmanSwitch.into(),
				&switch.owner,
				&switch.beneficiary,
				amount,
				frame::traits::tokens::Precision::BestEffort,
				frame::traits::tokens::Restriction::Free,
				frame::traits::tokens::Fortitude::Polite,
			)?;

			switch.status = SwitchStatus::Executed;
			Switches::<T>::insert(id, switch.clone());

			Self::deposit_event(Event::SwitchTriggered {
				id,
				beneficiary: switch.beneficiary,
				amount,
			});
			Ok(())
		}

		/// Cancel an active switch and reclaim funds.
		///
		/// Only the owner can cancel. The switch must be active.
		/// Held funds are released back to the owner.
		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::cancel())]
		pub fn cancel(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.owner == who, Error::<T>::NotOwner);
			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			// Release held funds back to the owner
			let returned = switch.deposit;
			T::Currency::release(
				&HoldReason::DeadmanSwitch.into(),
				&who,
				returned,
				frame::traits::tokens::Precision::BestEffort,
			)?;

			Switches::<T>::remove(id);

			Self::deposit_event(Event::SwitchCancelled { id, returned });
			Ok(())
		}
	}
}
