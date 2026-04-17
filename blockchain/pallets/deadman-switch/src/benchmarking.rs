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
		let call = frame_system::Call::<T>::remark { remark: vec![0u8; 32] };
		let calls = vec![Box::new(call.into())];
		let interval: BlockNumberFor<T> = 100u32.into();
		#[extrinsic_call]
		create_switch(RawOrigin::Signed(caller.clone()), calls, interval);

		assert!(Switches::<T>::contains_key(0));
	}

	#[benchmark]
	fn heartbeat() {
		let caller: T::AccountId = whitelisted_caller();
		// Seed real state (including a scheduled task) by going through
		// create_switch — otherwise `reschedule_named` has no task to update.
		let call = frame_system::Call::<T>::remark { remark: vec![0u8; 32] };
		let calls = vec![Box::new(call.into())];
		Pallet::<T>::create_switch(
			RawOrigin::Signed(caller.clone()).into(),
			calls,
			100u32.into(),
		)
		.unwrap();
		#[extrinsic_call]
		heartbeat(RawOrigin::Signed(caller.clone()), 0u64);
	}

	#[benchmark]
	fn execute_switch() {
		let caller: T::AccountId = whitelisted_caller();
		let call = frame_system::Call::<T>::remark { remark: vec![0u8; 32] };
		let calls = vec![Box::new(call.into())];
		Pallet::<T>::create_switch(
			RawOrigin::Signed(caller.clone()).into(),
			calls,
			100u32.into(),
		)
		.unwrap();
		#[extrinsic_call]
		execute_switch(RawOrigin::Root, 0u64);

		let switch = Switches::<T>::get(0).unwrap();
		assert_eq!(switch.status, SwitchStatus::Executed);
	}

	#[benchmark]
	fn cancel() {
		let caller: T::AccountId = whitelisted_caller();
		let call = frame_system::Call::<T>::remark { remark: vec![0u8; 32] };
		let calls = vec![Box::new(call.into())];
		Pallet::<T>::create_switch(
			RawOrigin::Signed(caller.clone()).into(),
			calls,
			100u32.into(),
		)
		.unwrap();
		#[extrinsic_call]
		cancel(RawOrigin::Signed(caller.clone()), 0u64);

		assert!(!Switches::<T>::contains_key(0));
	}

	impl_benchmark_test_suite!(DeadmanSwitch, crate::mock::new_test_ext(), crate::mock::Test);
}
