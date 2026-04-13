//! # Deadman Switch Pallet
//!
//! A deadman switch pallet that allows users to lock funds with a periodic
//! heartbeat requirement. If the owner fails to send a heartbeat before the
//! expiry block, anyone can trigger the switch to release funds to multiple
//! beneficiaries.
//!
//! ## Overview
//!
//! - `create_switch`: Lock funds for a list of beneficiaries + trigger reward
//! - `heartbeat`: Owner resets the expiry block (proves they are still active)
//! - `trigger`: Anyone calls this after expiry block passes — each beneficiary
//!   receives their designated amount, caller receives the trigger reward
//! - `cancel`: Owner cancels and reclaims all held funds (only while active)

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

		/// Maximum number of beneficiaries per switch.
		#[pallet::constant]
		type MaxBeneficiaries: Get<u32>;
	}

	/// Reason for holding funds.
	#[pallet::composite_enum]
	pub enum HoldReason {
		/// Funds locked in a deadman switch.
		DeadmanSwitch,
	}

	/// Unique identifier for each switch.
	pub type SwitchId = u64;

	/// A beneficiary entry with their designated amount.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
	#[scale_info(skip_type_params(T))]
	pub struct Beneficiary<T: Config> {
		/// The account that receives funds.
		pub account: T::AccountId,
		/// The amount designated for this beneficiary.
		pub amount: T::Balance,
	}

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
		/// The list of beneficiaries and their designated amounts.
		pub beneficiaries: BoundedVec<Beneficiary<T>, T::MaxBeneficiaries>,
		/// The total deposit (sum of all beneficiary amounts).
		pub total_deposit: T::Balance,
		/// The reward offered to whoever triggers the switch.
		pub trigger_reward: T::Balance,
		/// The block interval for the heartbeat period.
		pub block_interval: BlockNumberFor<T>,
		/// The block number by which the owner must send a heartbeat.
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
			total_deposit: T::Balance,
			trigger_reward: T::Balance,
			beneficiary_count: u32,
			expiry_block: BlockNumberFor<T>,
		},
		/// The owner sent a heartbeat, resetting the expiry block.
		HeartbeatReceived { id: SwitchId, new_expiry_block: BlockNumberFor<T> },
		/// The switch was triggered — funds distributed to beneficiaries, reward to caller.
		SwitchTriggered {
			id: SwitchId,
			caller: T::AccountId,
			total_deposit: T::Balance,
			caller_reward: T::Balance,
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
		/// A beneficiary cannot be the same as the owner.
		BeneficiaryIsOwner,
		/// Each beneficiary amount must be greater than zero.
		DepositTooLow,
		/// The beneficiary list is empty.
		NoBeneficiaries,
		/// Too many beneficiaries (exceeds MaxBeneficiaries).
		TooManyBeneficiaries,
		/// Duplicate beneficiary in the list.
		DuplicateBeneficiary,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Create a new deadman switch with multiple beneficiaries.
		///
		/// Holds the sum of all beneficiary amounts + trigger_reward from the
		/// caller. On trigger, each beneficiary receives their designated
		/// amount, and the caller receives the trigger reward.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::create_switch())]
		pub fn create_switch(
			origin: OriginFor<T>,
			beneficiaries_input: Vec<(T::AccountId, T::Balance)>,
			block_interval: BlockNumberFor<T>,
			trigger_reward: T::Balance,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(block_interval > Zero::zero(), Error::<T>::InvalidInterval);
			ensure!(!beneficiaries_input.is_empty(), Error::<T>::NoBeneficiaries);
			ensure!(
				beneficiaries_input.len() <= T::MaxBeneficiaries::get() as usize,
				Error::<T>::TooManyBeneficiaries,
			);

			let mut total_deposit = T::Balance::zero();
			let mut beneficiaries = BoundedVec::new();

			for (account, amount) in beneficiaries_input {
				ensure!(amount > Zero::zero(), Error::<T>::DepositTooLow);
				ensure!(account != who, Error::<T>::BeneficiaryIsOwner);
				// Check for duplicates
				ensure!(
					!beneficiaries.iter().any(|b: &Beneficiary<T>| b.account == account),
					Error::<T>::DuplicateBeneficiary,
				);
				total_deposit = total_deposit + amount;
				beneficiaries
					.try_push(Beneficiary { account, amount })
					.map_err(|_| Error::<T>::TooManyBeneficiaries)?;
			}

			let total_hold = total_deposit + trigger_reward;

			// Hold total deposit + trigger reward from the owner
			T::Currency::hold(&HoldReason::DeadmanSwitch.into(), &who, total_hold)?;

			let current_block = frame_system::Pallet::<T>::block_number();
			let expiry_block = current_block
				.checked_add(&block_interval)
				.ok_or(Error::<T>::BlockIntervalTooLarge)?;

			let id = NextSwitchId::<T>::get();
			NextSwitchId::<T>::put(id + 1);

			let beneficiary_count = beneficiaries.len() as u32;

			Switches::<T>::insert(
				id,
				Switch {
					owner: who.clone(),
					beneficiaries,
					total_deposit,
					trigger_reward,
					block_interval,
					expiry_block,
					status: SwitchStatus::Active,
				},
			);

			Self::deposit_event(Event::SwitchCreated {
				id,
				owner: who,
				total_deposit,
				trigger_reward,
				beneficiary_count,
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
		/// Anyone can call this once the expiry block has passed. Each
		/// beneficiary receives their designated amount from the hold,
		/// and the caller receives the trigger reward.
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::trigger())]
		pub fn trigger(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let caller = ensure_signed(origin)?;
			let mut switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			let current_block = frame_system::Pallet::<T>::block_number();
			ensure!(current_block > switch.expiry_block, Error::<T>::NotYetExpired);

			// Transfer each beneficiary's amount from hold
			for beneficiary in &switch.beneficiaries {
				T::Currency::transfer_on_hold(
					&HoldReason::DeadmanSwitch.into(),
					&switch.owner,
					&beneficiary.account,
					beneficiary.amount,
					frame::traits::tokens::Precision::BestEffort,
					frame::traits::tokens::Restriction::Free,
					frame::traits::tokens::Fortitude::Polite,
				)?;
			}

			// Transfer trigger reward from hold to caller
			let caller_reward = switch.trigger_reward;
			if caller_reward > Zero::zero() {
				T::Currency::transfer_on_hold(
					&HoldReason::DeadmanSwitch.into(),
					&switch.owner,
					&caller,
					caller_reward,
					frame::traits::tokens::Precision::BestEffort,
					frame::traits::tokens::Restriction::Free,
					frame::traits::tokens::Fortitude::Polite,
				)?;
			}

			let total_deposit = switch.total_deposit;
			switch.status = SwitchStatus::Executed;
			Switches::<T>::insert(id, switch);

			Self::deposit_event(Event::SwitchTriggered {
				id,
				caller,
				total_deposit,
				caller_reward,
			});
			Ok(())
		}

		/// Cancel an active switch and reclaim all held funds.
		///
		/// Only the owner can cancel. The switch must be active.
		/// The total deposit and trigger reward are released back to the owner.
		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::cancel())]
		pub fn cancel(origin: OriginFor<T>, id: SwitchId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let switch = Switches::<T>::get(id).ok_or(Error::<T>::SwitchNotFound)?;

			ensure!(switch.owner == who, Error::<T>::NotOwner);
			ensure!(switch.status == SwitchStatus::Active, Error::<T>::SwitchNotActive);

			// Release total deposit + trigger reward back to the owner
			let returned = switch.total_deposit + switch.trigger_reward;
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
