use crate::{mock::*, pallet::Error, Switches, SwitchStatus};
use frame::testing_prelude::*;
use frame::runtime::prelude::TokenError;

const REWARD: u64 = 1_000;

#[test]
fn create_switch_with_single_beneficiary() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![(2, 100_000)],
			10,
			REWARD,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.owner, 1);
		assert_eq!(switch.beneficiaries.len(), 1);
		assert_eq!(switch.beneficiaries[0].account, 2);
		assert_eq!(switch.beneficiaries[0].amount, 100_000);
		assert_eq!(switch.total_deposit, 100_000);
		assert_eq!(switch.trigger_reward, REWARD);
		assert_eq!(switch.status, SwitchStatus::Active);
		assert_eq!(Balances::free_balance(1), free_before - 100_000 - REWARD);
	});
}

#[test]
fn create_switch_with_multiple_beneficiaries() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![(2, 50_000), (3, 30_000)], // 50k + 30k = 80k
			10,
			REWARD,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.beneficiaries.len(), 2);
		assert_eq!(switch.total_deposit, 80_000);
		assert_eq!(Balances::free_balance(1), free_before - 80_000 - REWARD);
	});
}

#[test]
fn create_switch_with_zero_reward() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![(2, 100_000)],
			10,
			0,
		));
		assert_eq!(Balances::free_balance(1), free_before - 100_000);
	});
}

#[test]
fn create_switch_fails_with_no_beneficiaries() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), vec![], 10, REWARD),
			Error::<Test>::NoBeneficiaries,
		);
	});
}

#[test]
fn create_switch_fails_with_zero_interval() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![(2, 100_000)], 0, REWARD,
			),
			Error::<Test>::InvalidInterval,
		);
	});
}

#[test]
fn create_switch_fails_with_zero_amount() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![(2, 0)], 10, REWARD,
			),
			Error::<Test>::DepositTooLow,
		);
	});
}

#[test]
fn create_switch_fails_if_beneficiary_is_owner() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![(1, 100_000)], 10, REWARD,
			),
			Error::<Test>::BeneficiaryIsOwner,
		);
	});
}

#[test]
fn create_switch_fails_with_duplicate_beneficiary() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1),
				vec![(2, 50_000), (2, 30_000)],
				10,
				REWARD,
			),
			Error::<Test>::DuplicateBeneficiary,
		);
	});
}

#[test]
fn create_switch_fails_if_insufficient_balance() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![(2, 10_000_000)], 10, REWARD,
			),
			TokenError::FundsUnavailable,
		);
	});
}

#[test]
fn heartbeat_resets_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));

		System::set_block_number(5);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.expiry_block, 15);
	});
}

#[test]
fn heartbeat_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));
		assert_noop!(
			DeadmanSwitch::heartbeat(RuntimeOrigin::signed(2), 0),
			Error::<Test>::NotOwner,
		);
	});
}

#[test]
fn heartbeat_fails_if_expired() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));
		System::set_block_number(12);
		assert_noop!(
			DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0),
			Error::<Test>::SwitchExpired,
		);
	});
}

#[test]
fn trigger_distributes_to_all_beneficiaries_and_rewards_caller() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let bal2_before = Balances::free_balance(2);
		let bal3_before = Balances::free_balance(3);
		// Account 4 will be the trigger caller
		let bal4_before = Balances::free_balance(4);

		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![(2, 50_000), (3, 30_000)],
			10,
			REWARD,
		));

		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(4), 0));

		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.status, SwitchStatus::Executed);
		// Each beneficiary gets their designated amount
		assert_eq!(Balances::free_balance(2), bal2_before + 50_000);
		assert_eq!(Balances::free_balance(3), bal3_before + 30_000);
		// Caller gets the reward
		assert_eq!(Balances::free_balance(4), bal4_before + REWARD);
	});
}

#[test]
fn trigger_single_beneficiary() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let bal2_before = Balances::free_balance(2);
		let bal3_before = Balances::free_balance(3);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		assert_eq!(Balances::free_balance(2), bal2_before + 100_000);
		assert_eq!(Balances::free_balance(3), bal3_before + REWARD);
	});
}

#[test]
fn trigger_with_zero_reward() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let bal2_before = Balances::free_balance(2);
		let bal3_before = Balances::free_balance(3);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, 0,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		assert_eq!(Balances::free_balance(2), bal2_before + 100_000);
		assert_eq!(Balances::free_balance(3), bal3_before);
	});
}

#[test]
fn owner_can_trigger_own_switch_and_receives_reward() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let owner_before = Balances::free_balance(1);
		let bal2_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));

		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(1), 0));
		// Owner lost the deposit but got the reward back
		assert_eq!(Balances::free_balance(1), owner_before - 100_000);
		assert_eq!(Balances::free_balance(2), bal2_before + 100_000);
	});
}

#[test]
fn trigger_fails_before_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));
		System::set_block_number(5);
		assert_noop!(
			DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0),
			Error::<Test>::NotYetExpired,
		);
	});
}

#[test]
fn trigger_fails_if_already_executed() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		assert_noop!(
			DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0),
			Error::<Test>::SwitchNotActive,
		);
	});
}

#[test]
fn cancel_returns_all_funds() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 50_000), (3, 30_000)], 10, REWARD,
		));
		// 80k deposit + 1k reward held
		assert_eq!(Balances::free_balance(1), free_before - 80_000 - REWARD);

		assert_ok!(DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0));
		assert!(Switches::<Test>::get(0).is_none());
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn cancel_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));
		assert_noop!(
			DeadmanSwitch::cancel(RuntimeOrigin::signed(2), 0),
			Error::<Test>::NotOwner,
		);
	});
}

#[test]
fn unsigned_origin_is_rejected() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::none(), vec![(2, 100_000)], 10, REWARD,
			),
			DispatchError::BadOrigin,
		);
	});
}

#[test]
fn create_switch_at_max_beneficiaries() {
	new_test_ext().execute_with(|| {
		// MaxBeneficiaries = 10 in mock
		let beneficiaries: Vec<(u64, u64)> = (10..20).map(|i| (i, 1_000)).collect();
		assert_eq!(beneficiaries.len(), 10);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), beneficiaries, 10, REWARD,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.beneficiaries.len(), 10);
	});
}

#[test]
fn create_switch_exceeds_max_beneficiaries() {
	new_test_ext().execute_with(|| {
		let beneficiaries: Vec<(u64, u64)> = (10..21).map(|i| (i, 1_000)).collect();
		assert_eq!(beneficiaries.len(), 11);
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), beneficiaries, 10, REWARD,
			),
			Error::<Test>::TooManyBeneficiaries,
		);
	});
}

#[test]
fn create_switch_overflow_block_interval() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![(2, 1_000)], u64::MAX, REWARD,
			),
			Error::<Test>::BlockIntervalTooLarge,
		);
	});
}

#[test]
fn heartbeat_overflow_block_interval() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Create with a normal interval
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 1_000)], 10, REWARD,
		));
		// Manually set block_interval to near-max to trigger overflow on heartbeat
		Switches::<Test>::mutate(0, |s| {
			if let Some(switch) = s {
				switch.block_interval = u64::MAX;
			}
		});
		assert_noop!(
			DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0),
			Error::<Test>::BlockIntervalTooLarge,
		);
	});
}

#[test]
fn multiple_successive_heartbeats() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));
		// expiry = 11

		System::set_block_number(5);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 15);

		System::set_block_number(10);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 20);

		System::set_block_number(18);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 28);
	});
}

#[test]
fn cancel_after_expiry() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![(2, 100_000)], 10, REWARD,
		));
		// expiry = 11, move past it
		System::set_block_number(20);
		// Owner can still cancel even after expiry (status is still Active)
		assert_ok!(DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0));
		assert_eq!(Balances::free_balance(1), free_before);
	});
}
