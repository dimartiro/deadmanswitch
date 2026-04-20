//! Benchmarking setup for pallet-estate-executor

use super::*;
use crate::bequest::Bequest;
use frame::{deps::frame_benchmarking::v2::*, prelude::*};

#[benchmarks]
mod benchmarks {
	use super::*;
	#[cfg(test)]
	use crate::pallet::Pallet as EstateExecutor;
	use frame_system::RawOrigin;

	fn single_transfer<T: Config>(dest: T::AccountId) -> Vec<Bequest<T>> {
		vec![Bequest::Transfer { dest, amount: 1u32.into() }]
	}

	#[benchmark]
	fn create_will() {
		let caller: T::AccountId = whitelisted_caller();
		let bequests = single_transfer::<T>(caller.clone());
		let interval: BlockNumberFor<T> = 100u32.into();
		#[extrinsic_call]
		create_will(RawOrigin::Signed(caller.clone()), bequests, interval);

		assert!(Wills::<T>::contains_key(0));
	}

	#[benchmark]
	fn heartbeat() {
		let caller: T::AccountId = whitelisted_caller();
		Pallet::<T>::create_will(
			RawOrigin::Signed(caller.clone()).into(),
			single_transfer::<T>(caller.clone()),
			100u32.into(),
		)
		.unwrap();
		#[extrinsic_call]
		heartbeat(RawOrigin::Signed(caller.clone()), 0u64);
	}

	#[benchmark]
	fn execute_will() {
		let caller: T::AccountId = whitelisted_caller();
		Pallet::<T>::create_will(
			RawOrigin::Signed(caller.clone()).into(),
			single_transfer::<T>(caller.clone()),
			100u32.into(),
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
		Pallet::<T>::create_will(
			RawOrigin::Signed(caller.clone()).into(),
			single_transfer::<T>(caller.clone()),
			100u32.into(),
		)
		.unwrap();
		#[extrinsic_call]
		cancel(RawOrigin::Signed(caller.clone()), 0u64);

		assert!(!Wills::<T>::contains_key(0));
	}

	impl_benchmark_test_suite!(EstateExecutor, crate::mock::new_test_ext(), crate::mock::Test);
}
