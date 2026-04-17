use crate::{mock::*, pallet::Error, SwitchCalls, Switches, SwitchStatus};
use frame::testing_prelude::*;
use polkadot_sdk::{pallet_balances, pallet_multisig, pallet_proxy};

/// Helper: create a System.remark call
fn remark_call(data: &[u8]) -> Box<RuntimeCall> {
	Box::new(RuntimeCall::System(
		frame_system::Call::remark { remark: data.to_vec() },
	))
}

/// Helper: create a Balances.transfer_allow_death call
fn transfer_call(dest: u64, value: u64) -> Box<RuntimeCall> {
	Box::new(RuntimeCall::Balances(
		pallet_balances::Call::transfer_allow_death {
			dest: dest.into(),
			value,
		},
	))
}

/// Helper: create a Balances.transfer_all call
fn transfer_all_call(dest: u64) -> Box<RuntimeCall> {
	Box::new(RuntimeCall::Balances(
		pallet_balances::Call::transfer_all {
			dest: dest.into(),
			keep_alive: false,
		},
	))
}

// ── create_switch ──────────────────────────────────────────────────────

#[test]
fn create_switch_with_remark_call() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![remark_call(b"hello")],
			10,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.owner, 1);
		assert_eq!(switch.call_count, 1);
		assert_eq!(switch.status, SwitchStatus::Active);
		assert_eq!(switch.expiry_block, 11);
		assert!(SwitchCalls::<Test>::get(0).is_some());
		// No hold, no reward — free balance unchanged.
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn create_switch_with_multiple_calls() {
	new_test_ext().execute_with(|| {
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![
				remark_call(b"first"),
				remark_call(b"second"),
				transfer_call(2, 50_000),
			],
			10,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.call_count, 3);
		let stored = SwitchCalls::<Test>::get(0).unwrap();
		assert_eq!(stored.len(), 3);
	});
}

#[test]
fn create_switch_fails_with_no_calls() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![], 10,
			),
			Error::<Test>::NoCalls,
		);
	});
}

#[test]
fn create_switch_fails_with_too_many_calls() {
	new_test_ext().execute_with(|| {
		let calls: Vec<_> = (0..6).map(|i| remark_call(&[i])).collect();
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), calls, 10,
			),
			Error::<Test>::TooManyCalls,
		);
	});
}

#[test]
fn create_switch_fails_with_zero_interval() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![remark_call(b"x")], 0,
			),
			Error::<Test>::InvalidInterval,
		);
	});
}

#[test]
fn create_switch_overflow_block_interval() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![remark_call(b"x")], u64::MAX,
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
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));

		System::set_block_number(5);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 15);
	});
}

#[test]
fn heartbeat_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
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
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		// Expiry = 11. At block 12 the heartbeat is too late.
		System::set_block_number(12);
		assert_noop!(
			DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0),
			Error::<Test>::SwitchExpired,
		);
	});
}

#[test]
fn multiple_successive_heartbeats() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));

		System::set_block_number(5);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 15);

		System::set_block_number(10);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 20);
	});
}

#[test]
fn heartbeat_extends_scheduled_execution() {
	// Create a switch, heartbeat once to extend expiry, then run past the
	// ORIGINAL expiry and confirm the switch is still Active because the
	// scheduled task was moved to the new expiry.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		// Heartbeat at block 5 → new expiry = 15, new dispatch_at = 16.
		System::set_block_number(5);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));

		// Advance past the ORIGINAL dispatch_at (=12). Nothing should fire.
		run_to_block(13);
		assert_eq!(Switches::<Test>::get(0).unwrap().status, SwitchStatus::Active);

		// Advance past the NEW dispatch_at (=16). Execution fires.
		run_to_block(16);
		assert_eq!(Switches::<Test>::get(0).unwrap().status, SwitchStatus::Executed);
	});
}

// ── execute (driven by scheduler) ─────────────────────────────────────

#[test]
fn scheduler_executes_remark_at_expiry() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![remark_call(b"last words")],
			10,
		));
		// dispatch_at = 12. Run to 12.
		run_to_block(12);
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.status, SwitchStatus::Executed);
		// Stored calls preserved for frontend querying.
		assert!(SwitchCalls::<Test>::get(0).is_some());
	});
}

#[test]
fn scheduler_executes_transfer_call_best_effort() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let bal2_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![transfer_call(2, 50_000)],
			10,
		));
		run_to_block(12);
		// Transfer executed as owner (account 1)
		assert_eq!(Balances::free_balance(2), bal2_before + 50_000);
	});
}

#[test]
fn scheduler_execute_succeeds_even_if_owner_lacks_balance_for_stored_call() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Owner creates switch that would transfer 900k
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![transfer_call(2, 900_000)],
			10,
		));
		// Owner spends most of their free balance before the switch fires.
		assert_ok!(Balances::transfer_allow_death(
			RuntimeOrigin::signed(1), 4, 900_000,
		));

		run_to_block(12);
		// Execution still marks the switch as Executed even if the stored
		// call failed (best-effort).
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.status, SwitchStatus::Executed);
	});
}

#[test]
fn scheduler_executes_multiple_calls_partial_success() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let bal2_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![
				remark_call(b"this succeeds"),
				transfer_call(2, 50_000),
				transfer_call(2, 999_999_999), // will fail — insufficient balance
			],
			10,
		));
		run_to_block(12);
		// First transfer succeeded
		assert_eq!(Balances::free_balance(2), bal2_before + 50_000);
	});
}

#[test]
fn scheduler_executes_transfer_all_to_beneficiary() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let alice_before = Balances::free_balance(1);
		let bob_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![transfer_all_call(2)],
			10,
		));

		run_to_block(12);
		// No reward held, so Alice's full balance transfers to Bob.
		assert_eq!(Balances::free_balance(1), 0);
		assert_eq!(Balances::free_balance(2), bob_before + alice_before);
	});
}

#[test]
fn switch_stays_active_before_scheduled_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		// expiry = 11, dispatch_at = 12. At block 11, still Active.
		run_to_block(11);
		assert_eq!(Switches::<Test>::get(0).unwrap().status, SwitchStatus::Active);
	});
}

#[test]
fn execute_switch_requires_root_origin() {
	// An outside account cannot bypass the heartbeat by calling execute_switch.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		assert_noop!(
			DeadmanSwitch::execute_switch(RuntimeOrigin::signed(3), 0),
			DispatchError::BadOrigin,
		);
		// Owner also cannot force-execute via signed origin.
		assert_noop!(
			DeadmanSwitch::execute_switch(RuntimeOrigin::signed(1), 0),
			DispatchError::BadOrigin,
		);
	});
}

#[test]
fn root_can_force_execute() {
	// Root (governance/sudo) can force-execute; this is the same path the
	// scheduler uses.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		assert_ok!(DeadmanSwitch::execute_switch(RuntimeOrigin::root(), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().status, SwitchStatus::Executed);
	});
}

#[test]
fn scheduled_execution_runs_only_once() {
	// Once Executed, the switch cannot be executed again even if root tries.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		run_to_block(12);
		assert_noop!(
			DeadmanSwitch::execute_switch(RuntimeOrigin::root(), 0),
			Error::<Test>::SwitchNotActive,
		);
	});
}

// ── cancel ─────────────────────────────────────────────────────────────

#[test]
fn cancel_removes_switch_and_calls() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		assert_ok!(DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0));
		assert!(Switches::<Test>::get(0).is_none());
		assert!(SwitchCalls::<Test>::get(0).is_none());
		// No hold was ever taken.
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn cancel_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		assert_noop!(
			DeadmanSwitch::cancel(RuntimeOrigin::signed(2), 0),
			Error::<Test>::NotOwner,
		);
	});
}

#[test]
fn cancel_prevents_scheduled_execution() {
	// After cancel, running past the original dispatch_at should not execute
	// anything and should not panic — the scheduled task was cancelled.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let bal2_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![transfer_call(2, 50_000)], 10,
		));
		assert_ok!(DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0));
		run_to_block(20);
		// The stored transfer must not have executed.
		assert_eq!(Balances::free_balance(2), bal2_before);
	});
}

#[test]
fn cancel_fails_after_execution() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10,
		));
		run_to_block(12);
		assert_noop!(
			DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0),
			Error::<Test>::SwitchNotActive,
		);
	});
}

// ── proxy call ─────────────────────────────────────────────────────────

#[test]
fn scheduler_executes_add_proxy_call() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let add_proxy_call = Box::new(RuntimeCall::Proxy(
			pallet_proxy::Call::add_proxy {
				delegate: 2u64.into(),
				proxy_type: crate::mock::ProxyType::Any,
				delay: 0,
			},
		));
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![add_proxy_call],
			10,
		));
		run_to_block(12);
		let proxies = pallet_proxy::Proxies::<Test>::get(1);
		assert_eq!(proxies.0.len(), 1);
		assert_eq!(proxies.0[0].delegate, 2);
	});
}

// ── multisig call ──────────────────────────────────────────────────────

#[test]
fn scheduler_executes_multisig_fund_then_bob_and_charlie_transfer_to_dave() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Alice (1) creates a switch that, on execution, transfers funds to a
		// 2-of-2 multisig account controlled by Bob (2) and Charlie (3).
		let multisig_account =
			pallet_multisig::Pallet::<Test>::multi_account_id(&[2, 3], 2);

		let fund_multisig = Box::new(RuntimeCall::Balances(
			pallet_balances::Call::transfer_allow_death {
				dest: multisig_account.into(),
				value: 100_000,
			},
		));
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![fund_multisig],
			10,
		));

		run_to_block(12);
		assert_eq!(Balances::free_balance(multisig_account), 100_000);

		// Bob and Charlie cooperate to send 50k to Dave.
		let dave_before = Balances::free_balance(4);
		let transfer_to_dave = RuntimeCall::Balances(
			pallet_balances::Call::transfer_allow_death {
				dest: 4u64.into(),
				value: 50_000,
			},
		);
		let call_weight = transfer_to_dave.get_dispatch_info().call_weight;

		assert_ok!(pallet_multisig::Pallet::<Test>::as_multi(
			RuntimeOrigin::signed(2),
			2,
			vec![3],
			None,
			Box::new(transfer_to_dave.clone()),
			call_weight,
		));
		assert_eq!(Balances::free_balance(4), dave_before);

		let timepoint = pallet_multisig::Pallet::<Test>::timepoint();
		assert_ok!(pallet_multisig::Pallet::<Test>::as_multi(
			RuntimeOrigin::signed(3),
			2,
			vec![2],
			Some(timepoint),
			Box::new(transfer_to_dave),
			call_weight,
		));
		assert_eq!(Balances::free_balance(4), dave_before + 50_000);
		assert_eq!(Balances::free_balance(multisig_account), 50_000);
	});
}

// ── proxy + multisig ───────────────────────────────────────────────────

#[test]
fn scheduler_adds_multisig_proxy_then_bob_charlie_operate_alice_account() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let multisig_account =
			pallet_multisig::Pallet::<Test>::multi_account_id(&[2, 3], 2);

		let add_proxy_call = Box::new(RuntimeCall::Proxy(
			pallet_proxy::Call::add_proxy {
				delegate: multisig_account.into(),
				proxy_type: crate::mock::ProxyType::Any,
				delay: 0,
			},
		));
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![add_proxy_call],
			10,
		));

		run_to_block(12);
		let proxies = pallet_proxy::Proxies::<Test>::get(1);
		assert_eq!(proxies.0.len(), 1);
		assert_eq!(proxies.0[0].delegate, multisig_account);

		// Bob and Charlie operate Alice's account via proxy+multisig.
		let transfer_from_alice = RuntimeCall::Proxy(
			pallet_proxy::Call::proxy {
				real: 1u64.into(),
				force_proxy_type: None,
				call: Box::new(RuntimeCall::Balances(
					pallet_balances::Call::transfer_allow_death {
						dest: 4u64.into(),
						value: 50_000,
					},
				)),
			},
		);
		let call_weight = transfer_from_alice.get_dispatch_info().call_weight;

		let alice_before = Balances::free_balance(1);
		let dave_before = Balances::free_balance(4);

		assert_ok!(pallet_multisig::Pallet::<Test>::as_multi(
			RuntimeOrigin::signed(2),
			2,
			vec![3],
			None,
			Box::new(transfer_from_alice.clone()),
			call_weight,
		));
		assert_eq!(Balances::free_balance(4), dave_before);

		let timepoint = pallet_multisig::Pallet::<Test>::timepoint();
		assert_ok!(pallet_multisig::Pallet::<Test>::as_multi(
			RuntimeOrigin::signed(3),
			2,
			vec![2],
			Some(timepoint),
			Box::new(transfer_from_alice),
			call_weight,
		));

		assert_eq!(Balances::free_balance(4), dave_before + 50_000);
		assert_eq!(Balances::free_balance(1), alice_before - 50_000);
	});
}

// ── chained switches ───────────────────────────────────────────────────

#[test]
fn scheduler_executes_remark_then_creates_second_switch_with_later_remark() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);

		// First switch: remark + create a second switch 10 blocks later.
		let second_switch_call = Box::new(RuntimeCall::DeadmanSwitch(
			crate::Call::create_switch {
				calls: vec![Box::new(RuntimeCall::System(
					frame_system::Call::remark { remark: b"second message".to_vec() },
				))],
				block_interval: 10,
			},
		));
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![
				remark_call(b"first message"),
				second_switch_call,
			],
			5,
		));

		// First switch: expiry 6, dispatch_at 7. Run to 7.
		run_to_block(7);
		let switch0 = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch0.status, SwitchStatus::Executed);

		// Second switch was created by the first execution (id=1), owned by
		// the original owner (because the first switch executes as owner).
		let switch1 = Switches::<Test>::get(1).unwrap();
		assert_eq!(switch1.owner, 1);
		assert_eq!(switch1.call_count, 1);
		// second switch expiry = create_block + interval = 7 + 10 = 17.
		assert_eq!(switch1.expiry_block, 17);
		assert_eq!(switch1.status, SwitchStatus::Active);

		// Advance past the second dispatch_at (=18).
		run_to_block(18);
		let switch1 = Switches::<Test>::get(1).unwrap();
		assert_eq!(switch1.status, SwitchStatus::Executed);
	});
}

// ── misc ───────────────────────────────────────────────────────────────

#[test]
fn unsigned_origin_is_rejected() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::none(), vec![remark_call(b"x")], 10,
			),
			DispatchError::BadOrigin,
		);
	});
}
