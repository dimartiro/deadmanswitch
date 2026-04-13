use crate::{mock::*, pallet::Error, Switches, SwitchStatus};
use frame::testing_prelude::*;
use frame::runtime::prelude::TokenError;

const DEPOSIT: u64 = 100_000;

#[test]
fn create_switch_works() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.owner, 1);
		assert_eq!(switch.beneficiary, 2);
		assert_eq!(switch.deposit, DEPOSIT);
		assert_eq!(switch.block_interval, 10);
		assert_eq!(switch.status, SwitchStatus::Active);
		// Funds are held
		assert_eq!(Balances::free_balance(1), free_before - DEPOSIT);
	});
}

#[test]
fn create_switch_fails_with_zero_interval() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), 2, 0, DEPOSIT),
			Error::<Test>::InvalidInterval,
		);
	});
}

#[test]
fn create_switch_fails_with_zero_deposit() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), 2, 10, 0),
			Error::<Test>::DepositTooLow,
		);
	});
}

#[test]
fn create_switch_fails_if_beneficiary_is_owner() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), 1, 10, DEPOSIT),
			Error::<Test>::BeneficiaryIsOwner,
		);
	});
}

#[test]
fn create_switch_fails_if_insufficient_balance() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(RuntimeOrigin::signed(1), 2, 10, 10_000_000),
			TokenError::FundsUnavailable,
		);
	});
}

#[test]
fn heartbeat_resets_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
		));
		// expiry_block = 1 + 10 = 11

		System::set_block_number(5);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		let switch = Switches::<Test>::get(0).unwrap();
		// new expiry_block = 5 + 10 = 15
		assert_eq!(switch.expiry_block, 15);
	});
}

#[test]
fn heartbeat_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
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
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
		));
		// expiry_block = 11, move past it
		System::set_block_number(12);
		assert_noop!(
			DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0),
			Error::<Test>::NotYetExpired,
		);
	});
}

#[test]
fn trigger_works_after_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let beneficiary_balance_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
		));
		// expiry_block = 11
		System::set_block_number(12);
		// Anyone (account 3) can trigger
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.status, SwitchStatus::Executed);
		// Beneficiary received the funds
		assert_eq!(
			Balances::free_balance(2),
			beneficiary_balance_before + DEPOSIT
		);
	});
}

#[test]
fn trigger_fails_before_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
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
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
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
fn cancel_works_and_returns_funds() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
		));
		assert_eq!(Balances::free_balance(1), free_before - DEPOSIT);

		assert_ok!(DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0));
		assert!(Switches::<Test>::get(0).is_none());
		// Funds returned
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn cancel_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			2,
			10,
			DEPOSIT,
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
			DeadmanSwitch::create_switch(RuntimeOrigin::none(), 2, 10, DEPOSIT),
			DispatchError::BadOrigin,
		);
	});
}
