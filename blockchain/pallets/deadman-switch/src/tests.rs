use crate::{mock::*, pallet::Error, Switches, SwitchStatus};
use frame::testing_prelude::*;
use frame::runtime::prelude::TokenError;

const DEPOSIT: u64 = 100_000;
const REWARD: u64 = 1_000;
const TOTAL_HOLD: u64 = DEPOSIT + REWARD;

#[test]
fn create_switch_holds_deposit_plus_reward() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
			REWARD,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.owner, 1);
		assert_eq!(switch.beneficiary, 2);
		assert_eq!(switch.deposit, DEPOSIT);
		assert_eq!(switch.trigger_reward, REWARD);
		assert_eq!(switch.block_interval, 10);
		assert_eq!(switch.status, SwitchStatus::Active);
		// deposit + trigger reward are held
		assert_eq!(Balances::free_balance(1), free_before - TOTAL_HOLD);
	});
}

#[test]
fn create_switch_with_zero_reward() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
			0, // no reward
		));
		// Only deposit is held
		assert_eq!(Balances::free_balance(1), free_before - DEPOSIT);
	});
}

#[test]
fn create_switch_fails_with_zero_interval() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), 2, 0, DEPOSIT, REWARD),
			Error::<Test>::InvalidInterval,
		);
	});
}

#[test]
fn create_switch_fails_with_zero_deposit() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), 2, 10, 0, REWARD),
			Error::<Test>::DepositTooLow,
		);
	});
}

#[test]
fn create_switch_fails_if_beneficiary_is_owner() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), 1, 10, DEPOSIT, REWARD),
			Error::<Test>::BeneficiaryIsOwner,
		);
	});
}

#[test]
fn create_switch_fails_if_insufficient_balance() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), 2, 10, 10_000_000, REWARD),
			TokenError::FundsUnavailable,
		);
	});
}

#[test]
fn heartbeat_resets_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
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
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
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
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
		));
		System::set_block_number(12);
		assert_noop!(
			DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0),
			Error::<Test>::NotYetExpired,
		);
	});
}

#[test]
fn trigger_sends_deposit_to_beneficiary_and_reward_to_caller() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let beneficiary_before = Balances::free_balance(2);
		let caller_before = Balances::free_balance(3);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
		));
		System::set_block_number(12);
		// Account 3 triggers and earns the reward
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.status, SwitchStatus::Executed);
		// Beneficiary gets the full deposit
		assert_eq!(Balances::free_balance(2), beneficiary_before + DEPOSIT);
		// Caller gets the trigger reward
		assert_eq!(Balances::free_balance(3), caller_before + REWARD);
	});
}

#[test]
fn trigger_with_zero_reward() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let beneficiary_before = Balances::free_balance(2);
		let caller_before = Balances::free_balance(3);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, 0,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		// Beneficiary gets the full deposit
		assert_eq!(Balances::free_balance(2), beneficiary_before + DEPOSIT);
		// Caller gets nothing
		assert_eq!(Balances::free_balance(3), caller_before);
	});
}

#[test]
fn owner_can_trigger_own_switch_and_receives_reward() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let owner_before = Balances::free_balance(1);
		let beneficiary_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
		));
		// Owner held deposit + reward
		assert_eq!(Balances::free_balance(1), owner_before - TOTAL_HOLD);

		System::set_block_number(12);
		// Owner triggers their own switch
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(1), 0));
		// Owner gets the reward back (lost the deposit)
		assert_eq!(Balances::free_balance(1), owner_before - DEPOSIT);
		// Beneficiary gets the full deposit
		assert_eq!(Balances::free_balance(2), beneficiary_before + DEPOSIT);
	});
}

#[test]
fn trigger_fails_before_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
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
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
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
fn cancel_returns_deposit_plus_reward() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
		));
		assert_eq!(Balances::free_balance(1), free_before - TOTAL_HOLD);

		assert_ok!(DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0));
		assert!(Switches::<Test>::get(0).is_none());
		// Full amount returned (deposit + reward)
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn cancel_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), 2, 10, DEPOSIT, REWARD,
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
			DeadmanSwitch::create_switch(RuntimeOrigin::none(), 2, 10, DEPOSIT, REWARD),
			DispatchError::BadOrigin,
		);
	});
}
