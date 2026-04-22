use crate::{
	bequest::{Bequest, MaxMultisigDelegates},
	mock::*,
	pallet::Error,
	WillBequests, WillStatus, Wills,
};
use frame::testing_prelude::*;
use polkadot_sdk::pallet_multisig;

// ── bequest helpers ──────────────────────────────────────────────

fn transfer(dest: u64, amount: u64) -> Bequest<Test> {
	Bequest::Transfer { dest, amount }
}

fn transfer_all(dest: u64) -> Bequest<Test> {
	Bequest::TransferAll { dest }
}

fn proxy(delegate: u64) -> Bequest<Test> {
	Bequest::Proxy { delegate }
}

fn multisig_proxy(delegates: &[u64], threshold: u16) -> Bequest<Test> {
	Bequest::MultisigProxy {
		delegates: BoundedVec::<_, MaxMultisigDelegates>::try_from(delegates.to_vec())
			.unwrap(),
		threshold,
	}
}

// ── create_will ────────────────────────────────────────────────────────

#[test]
fn create_will_with_transfer() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let free_before = Balances::free_balance(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![transfer(2, 100)],
			10,
		));
		let will = Wills::<Test>::get(0).unwrap();
		assert_eq!(will.owner, 1);
		assert_eq!(will.bequest_count, 1);
		assert_eq!(will.status, WillStatus::Active);
		assert_eq!(will.expiry_block, 11);
		assert!(WillBequests::<Test>::get(0).is_some());
		// No local balance movement at create time: the bequest will
		// eventually execute against Asset Hub.
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn create_will_with_multiple_bequests() {
	new_test_ext().execute_with(|| {
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![
				transfer(2, 100),
				transfer(3, 50),
				proxy(4),
			],
			10,
		));
		let will = Wills::<Test>::get(0).unwrap();
		assert_eq!(will.bequest_count, 3);
	});
}

#[test]
fn create_will_fails_with_no_bequests() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			EstateExecutor::create_will(RuntimeOrigin::signed(1), vec![], 10),
			Error::<Test>::NoBequests,
		);
	});
}

#[test]
fn create_will_fails_with_too_many_bequests() {
	new_test_ext().execute_with(|| {
		let d: Vec<_> = (0..6).map(|i| transfer(2, i)).collect();
		assert_noop!(
			EstateExecutor::create_will(RuntimeOrigin::signed(1), d, 10),
			Error::<Test>::TooManyBequests,
		);
	});
}

#[test]
fn create_will_fails_with_zero_interval() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			EstateExecutor::create_will(
				RuntimeOrigin::signed(1), vec![transfer(2, 100)], 0,
			),
			Error::<Test>::InvalidInterval,
		);
	});
}

#[test]
fn create_will_overflow_block_interval() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			EstateExecutor::create_will(
				RuntimeOrigin::signed(1), vec![transfer(2, 100)], u64::MAX,
			),
			Error::<Test>::BlockIntervalTooLarge,
		);
	});
}

// ── heartbeat ──────────────────────────────────────────────────────────

#[test]
fn heartbeat_resets_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));

		System::set_block_number(5);
		assert_ok!(EstateExecutor::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Wills::<Test>::get(0).unwrap().expiry_block, 15);
	});
}

#[test]
fn heartbeat_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		assert_noop!(
			EstateExecutor::heartbeat(RuntimeOrigin::signed(2), 0),
			Error::<Test>::NotOwner,
		);
	});
}

#[test]
fn heartbeat_fails_if_expired() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		System::set_block_number(12);
		assert_noop!(
			EstateExecutor::heartbeat(RuntimeOrigin::signed(1), 0),
			Error::<Test>::WillExpired,
		);
	});
}

#[test]
fn multiple_successive_heartbeats() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		System::set_block_number(5);
		assert_ok!(EstateExecutor::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Wills::<Test>::get(0).unwrap().expiry_block, 15);

		System::set_block_number(10);
		assert_ok!(EstateExecutor::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Wills::<Test>::get(0).unwrap().expiry_block, 20);
	});
}

#[test]
fn heartbeat_extends_scheduled_execution() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		System::set_block_number(5);
		assert_ok!(EstateExecutor::heartbeat(RuntimeOrigin::signed(1), 0));

		run_to_block(13);
		assert_eq!(Wills::<Test>::get(0).unwrap().status, WillStatus::Active);

		run_to_block(16);
		assert_eq!(Wills::<Test>::get(0).unwrap().status, WillStatus::Executed);
	});
}

// ── execute (driven by scheduler) ─────────────────────────────────────

#[test]
fn scheduler_executes_transfer_at_expiry() {
	new_test_ext().execute_with(|| {
		reset_ah_ops();
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![transfer(2, 50_000)],
			10,
		));
		run_to_block(12);
		assert_eq!(Wills::<Test>::get(0).unwrap().status, WillStatus::Executed);
		assert_eq!(
			ah_ops(),
			vec![AhOp::Transfer { owner: 1, dest: 2, amount: 50_000 }],
		);
	});
}

#[test]
fn scheduler_executes_transfer_all() {
	new_test_ext().execute_with(|| {
		reset_ah_ops();
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![transfer_all(2)],
			10,
		));
		run_to_block(12);
		assert_eq!(ah_ops(), vec![AhOp::TransferAll { owner: 1, dest: 2 }]);
	});
}

#[test]
fn scheduler_execute_dispatches_regardless_of_local_balance() {
	new_test_ext().execute_with(|| {
		reset_ah_ops();
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![transfer(2, 900_000)],
			10,
		));
		// Drain the owner's local balance — bequests now target Asset Hub
		// so local balance is irrelevant to dispatch success.
		assert_ok!(Balances::transfer_allow_death(
			RuntimeOrigin::signed(1), 4, 900_000,
		));
		run_to_block(12);
		assert_eq!(Wills::<Test>::get(0).unwrap().status, WillStatus::Executed);
		assert_eq!(
			ah_ops(),
			vec![AhOp::Transfer { owner: 1, dest: 2, amount: 900_000 }],
		);
	});
}

#[test]
fn scheduler_executes_every_bequest_in_order() {
	new_test_ext().execute_with(|| {
		reset_ah_ops();
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![
				transfer(2, 50_000),
				transfer(3, 25_000),
			],
			10,
		));
		run_to_block(12);
		assert_eq!(
			ah_ops(),
			vec![
				AhOp::Transfer { owner: 1, dest: 2, amount: 50_000 },
				AhOp::Transfer { owner: 1, dest: 3, amount: 25_000 },
			],
		);
	});
}

#[test]
fn will_stays_active_before_scheduled_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		run_to_block(11);
		assert_eq!(Wills::<Test>::get(0).unwrap().status, WillStatus::Active);
	});
}

#[test]
fn execute_will_requires_root_origin() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		assert_noop!(
			EstateExecutor::execute_will(RuntimeOrigin::signed(3), 0),
			DispatchError::BadOrigin,
		);
		assert_noop!(
			EstateExecutor::execute_will(RuntimeOrigin::signed(1), 0),
			DispatchError::BadOrigin,
		);
	});
}

#[test]
fn root_can_force_execute() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		assert_ok!(EstateExecutor::execute_will(RuntimeOrigin::root(), 0));
		assert_eq!(Wills::<Test>::get(0).unwrap().status, WillStatus::Executed);
	});
}

#[test]
fn scheduled_execution_runs_only_once() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		run_to_block(12);
		assert_noop!(
			EstateExecutor::execute_will(RuntimeOrigin::root(), 0),
			Error::<Test>::WillNotActive,
		);
	});
}

// ── cancel ─────────────────────────────────────────────────────────────

#[test]
fn cancel_removes_will_and_bequests() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let free_before = Balances::free_balance(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		assert_ok!(EstateExecutor::cancel(RuntimeOrigin::signed(1), 0));
		assert!(Wills::<Test>::get(0).is_none());
		assert!(WillBequests::<Test>::get(0).is_none());
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn cancel_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		assert_noop!(
			EstateExecutor::cancel(RuntimeOrigin::signed(2), 0),
			Error::<Test>::NotOwner,
		);
	});
}

#[test]
fn cancel_prevents_scheduled_execution() {
	new_test_ext().execute_with(|| {
		reset_ah_ops();
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 50_000)], 10,
		));
		assert_ok!(EstateExecutor::cancel(RuntimeOrigin::signed(1), 0));
		run_to_block(20);
		assert!(ah_ops().is_empty());
	});
}

#[test]
fn cancel_fails_after_execution() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		run_to_block(12);
		assert_noop!(
			EstateExecutor::cancel(RuntimeOrigin::signed(1), 0),
			Error::<Test>::WillNotActive,
		);
	});
}

// ── beneficiaries_of / inheritances_of ────────────────────────────────

#[test]
fn beneficiaries_of_unions_recipients() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![
				transfer(2, 100),
				transfer(3, 50),
				multisig_proxy(&[2, 3, 4], 2),
			],
			10,
		));
		let mut b = crate::Pallet::<Test>::beneficiaries_of(0);
		b.sort();
		assert_eq!(b, vec![2, 2, 3, 3, 4]);
	});
}

// ── identity verification ─────────────────────────────────────────────

#[test]
fn create_will_fails_if_beneficiary_unverified() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Account 5 is outside the mock's verified range (1..=4).
		assert_noop!(
			EstateExecutor::create_will(
				RuntimeOrigin::signed(1), vec![transfer(5, 100)], 10,
			),
			Error::<Test>::BeneficiaryNotVerified,
		);
	});
}

#[test]
fn create_will_fails_if_any_recipient_unverified() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			EstateExecutor::create_will(
				RuntimeOrigin::signed(1),
				vec![transfer(2, 100), transfer(5, 50)],
				10,
			),
			Error::<Test>::BeneficiaryNotVerified,
		);
	});
}

#[test]
fn create_will_fails_if_multisig_delegate_unverified() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			EstateExecutor::create_will(
				RuntimeOrigin::signed(1),
				vec![multisig_proxy(&[2, 5], 2)],
				10,
			),
			Error::<Test>::BeneficiaryNotVerified,
		);
	});
}

#[test]
fn inheritances_of_returns_active_wills_naming_account() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![transfer(2, 100), transfer(3, 50)],
			10,
		));
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![transfer(3, 25)],
			10,
		));
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![multisig_proxy(&[4, 3], 2)],
			10,
		));

		let mut for_two = crate::Pallet::<Test>::inheritances_of(&2);
		for_two.sort();
		assert_eq!(for_two, vec![0]);

		let mut for_three = crate::Pallet::<Test>::inheritances_of(&3);
		for_three.sort();
		assert_eq!(for_three, vec![0, 1, 2]);

		let mut for_four = crate::Pallet::<Test>::inheritances_of(&4);
		for_four.sort();
		assert_eq!(for_four, vec![2]);

		assert!(crate::Pallet::<Test>::inheritances_of(&5).is_empty());
	});
}

#[test]
fn inheritances_of_excludes_executed_wills() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1), vec![transfer(2, 100)], 10,
		));
		assert_eq!(crate::Pallet::<Test>::inheritances_of(&2), vec![0]);

		run_to_block(12);
		assert!(crate::Pallet::<Test>::inheritances_of(&2).is_empty());
	});
}

// ── inheritance certificates ──────────────────────────────────────────

#[test]
fn execute_mints_certificate_once_per_unique_beneficiary() {
	new_test_ext().execute_with(|| {
		reset_minted_certificates();
		System::set_block_number(1);
		// Bob appears in two bequests; Charlie in one. Expect two mints
		// total (one per unique beneficiary), not three.
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![transfer(2, 100), proxy(2), transfer(3, 50)],
			10,
		));
		run_to_block(12);
		let mut minted = minted_certificates();
		minted.sort();
		assert_eq!(minted, vec![(0, 2), (0, 3)]);
	});
}

#[test]
fn multisig_proxy_mints_one_certificate_per_delegate() {
	new_test_ext().execute_with(|| {
		reset_minted_certificates();
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![multisig_proxy(&[2, 3, 4], 2)],
			10,
		));
		run_to_block(12);
		let mut minted = minted_certificates();
		minted.sort();
		assert_eq!(minted, vec![(0, 2), (0, 3), (0, 4)]);
	});
}

// ── proxy / multisig proxy ────────────────────────────────────────────

#[test]
fn scheduler_records_add_proxy_on_asset_hub() {
	new_test_ext().execute_with(|| {
		reset_ah_ops();
		System::set_block_number(1);
		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![proxy(2)],
			10,
		));
		run_to_block(12);
		assert_eq!(ah_ops(), vec![AhOp::AddProxy { owner: 1, delegate: 2 }]);
	});
}

#[test]
fn scheduler_records_multisig_proxy_with_derived_account() {
	new_test_ext().execute_with(|| {
		reset_ah_ops();
		System::set_block_number(1);
		let multisig_account =
			pallet_multisig::Pallet::<Test>::multi_account_id(&[2, 3], 2);

		assert_ok!(EstateExecutor::create_will(
			RuntimeOrigin::signed(1),
			vec![multisig_proxy(&[2, 3], 2)],
			10,
		));
		run_to_block(12);

		assert_eq!(
			ah_ops(),
			vec![AhOp::AddProxy { owner: 1, delegate: multisig_account }],
		);
	});
}

// ── misc ───────────────────────────────────────────────────────────────

#[test]
fn unsigned_origin_is_rejected() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			EstateExecutor::create_will(
				RuntimeOrigin::none(), vec![transfer(2, 100)], 10,
			),
			DispatchError::BadOrigin,
		);
	});
}
