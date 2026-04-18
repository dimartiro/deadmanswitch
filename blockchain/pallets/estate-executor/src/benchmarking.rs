//! Benchmarking setup for pallet-estate-executor

use super::*;
use frame::{deps::frame_benchmarking::v2::*, prelude::*};

#[benchmarks]
mod benchmarks {
	use super::*;
	#[cfg(test)]
	use crate::pallet::Pallet as EstateExecutor;
	use frame_system::RawOrigin;

	#[benchmark]
	fn create_will() {
		let caller: T::AccountId = whitelisted_caller();
		let call = frame_system::Call::<T>::remark { remark: vec![0u8; 32] };
		let calls = vec![Box::new(call.into())];
		let interval: BlockNumberFor<T> = 100u32.into();
		let beneficiaries: Vec<T::AccountId> = vec![caller.clone()];
		#[extrinsic_call]
		create_will(RawOrigin::Signed(caller.clone()), calls, interval, beneficiaries);

		assert!(Wills::<T>::contains_key(0));
	}

	#[benchmark]
	fn heartbeat() {
		let caller: T::AccountId = whitelisted_caller();
		// Seed real state (including a scheduled task) by going through
		// create_will — otherwise `reschedule_named` has no task to update.
		let call = frame_system::Call::<T>::remark { remark: vec![0u8; 32] };
		let calls = vec![Box::new(call.into())];
		Pallet::<T>::create_will(
			RawOrigin::Signed(caller.clone()).into(),
			calls,
			100u32.into(),
			vec![caller.clone()],
		)
		.unwrap();
		#[extrinsic_call]
		heartbeat(RawOrigin::Signed(caller.clone()), 0u64);
	}

	#[benchmark]
	fn execute_will() {
		let caller: T::AccountId = whitelisted_caller();
		let call = frame_system::Call::<T>::remark { remark: vec![0u8; 32] };
		let calls = vec![Box::new(call.into())];
		Pallet::<T>::create_will(
			RawOrigin::Signed(caller.clone()).into(),
			calls,
			100u32.into(),
			vec![caller.clone()],
		)
		.unwrap();
		#[extrinsic_call]
		execute_will(RawOrigin::Root, 0u64);

		let will = Wills::<T>::get(0).unwrap();
		assert_eq!(will.status, WillStatus::Executed);
	}

	#[benchmark]
	fn cancel() {
		let caller: T::AccountId = whitelisted_caller();
		let call = frame_system::Call::<T>::remark { remark: vec![0u8; 32] };
		let calls = vec![Box::new(call.into())];
		Pallet::<T>::create_will(
			RawOrigin::Signed(caller.clone()).into(),
			calls,
			100u32.into(),
			vec![caller.clone()],
		)
		.unwrap();
		#[extrinsic_call]
		cancel(RawOrigin::Signed(caller.clone()), 0u64);

		assert!(!Wills::<T>::contains_key(0));
	}

	impl_benchmark_test_suite!(EstateExecutor, crate::mock::new_test_ext(), crate::mock::Test);
}
