//! Benchmarking setup for pallet-deadman-switch

use super::*;
use frame::{deps::frame_benchmarking::v2::*, prelude::*};

#[benchmarks]
mod benchmarks {
	use super::*;
	#[cfg(test)]
	use crate::pallet::Pallet as DeadmanSwitch;
	use frame_system::RawOrigin;

	#[benchmark]
	fn create_switch() {
		let caller: T::AccountId = whitelisted_caller();
		let beneficiary: T::AccountId = account("beneficiary", 0, 0);
		let interval: BlockNumberFor<T> = 100u32.into();
		let deposit: T::Balance = 1000u32.into();
		let trigger_reward: T::Balance = 100u32.into();
		#[extrinsic_call]
		create_switch(RawOrigin::Signed(caller.clone()), beneficiary, interval, deposit, trigger_reward);

		assert!(Switches::<T>::contains_key(0));
	}

	#[benchmark]
	fn heartbeat() {
		let caller: T::AccountId = whitelisted_caller();
		let beneficiary: T::AccountId = account("beneficiary", 0, 0);
		let interval: BlockNumberFor<T> = 100u32.into();
		let current_block = frame_system::Pallet::<T>::block_number();
		Switches::<T>::insert(
			0u64,
			Switch {
				owner: caller.clone(),
				beneficiary,
				deposit: 1000u32.into(),
				trigger_reward: 100u32.into(),
				block_interval: interval,
				expiry_block: current_block + interval,
				status: SwitchStatus::Active,
			},
		);
		NextSwitchId::<T>::put(1u64);
		#[extrinsic_call]
		heartbeat(RawOrigin::Signed(caller.clone()), 0u64);
	}

	#[benchmark]
	fn trigger() {
		let caller: T::AccountId = whitelisted_caller();
		let beneficiary: T::AccountId = account("beneficiary", 0, 0);
		Switches::<T>::insert(
			0u64,
			Switch {
				owner: caller.clone(),
				beneficiary,
				deposit: 1000u32.into(),
				trigger_reward: 100u32.into(),
				block_interval: 10u32.into(),
				expiry_block: 0u32.into(),
				status: SwitchStatus::Active,
			},
		);
		NextSwitchId::<T>::put(1u64);
		frame_system::Pallet::<T>::set_block_number(5u32.into());
		#[extrinsic_call]
		trigger(RawOrigin::Signed(caller.clone()), 0u64);
	}

	#[benchmark]
	fn cancel() {
		let caller: T::AccountId = whitelisted_caller();
		let beneficiary: T::AccountId = account("beneficiary", 0, 0);
		let interval: BlockNumberFor<T> = 100u32.into();
		let current_block = frame_system::Pallet::<T>::block_number();
		Switches::<T>::insert(
			0u64,
			Switch {
				owner: caller.clone(),
				beneficiary,
				deposit: 1000u32.into(),
				trigger_reward: 100u32.into(),
				block_interval: interval,
				expiry_block: current_block + interval,
				status: SwitchStatus::Active,
			},
		);
		NextSwitchId::<T>::put(1u64);
		#[extrinsic_call]
		cancel(RawOrigin::Signed(caller.clone()), 0u64);

		assert!(!Switches::<T>::contains_key(0));
	}

	impl_benchmark_test_suite!(DeadmanSwitch, crate::mock::new_test_ext(), crate::mock::Test);
}
