use crate::{mock::*, pallet::Error, SwitchCalls, Switches, SwitchStatus};
use frame::testing_prelude::*;
use frame::runtime::prelude::TokenError;

const REWARD: u64 = 1_000;

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
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![remark_call(b"hello")],
			10,
			REWARD,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.owner, 1);
		assert_eq!(switch.call_count, 1);
		assert_eq!(switch.trigger_reward, REWARD);
		assert_eq!(switch.status, SwitchStatus::Active);
		assert!(SwitchCalls::<Test>::get(0).is_some());
		// Only reward is held
		assert_eq!(Balances::free_balance(1), free_before - REWARD);
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
			REWARD,
		));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.call_count, 3);
		let stored = SwitchCalls::<Test>::get(0).unwrap();
		assert_eq!(stored.len(), 3);
	});
}

#[test]
fn create_switch_with_zero_reward() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![remark_call(b"no reward")],
			10,
			0,
		));
		// No hold
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn create_switch_fails_with_no_calls() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![], 10, REWARD,
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
				RuntimeOrigin::signed(1), calls, 10, REWARD,
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
				RuntimeOrigin::signed(1), vec![remark_call(b"x")], 0, REWARD,
			),
			Error::<Test>::InvalidInterval,
		);
	});
}

#[test]
fn create_switch_fails_if_insufficient_balance_for_reward() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, 10_000_000,
			),
			TokenError::FundsUnavailable,
		);
	});
}

#[test]
fn create_switch_overflow_block_interval() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			DeadmanSwitch::create_switch(
				RuntimeOrigin::signed(1), vec![remark_call(b"x")], u64::MAX, REWARD,
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
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
		));

		System::set_block_number(5);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 15);
	});
}

#[test]
fn heartbeat_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
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
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
		));
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
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
		));

		System::set_block_number(5);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 15);

		System::set_block_number(10);
		assert_ok!(DeadmanSwitch::heartbeat(RuntimeOrigin::signed(1), 0));
		assert_eq!(Switches::<Test>::get(0).unwrap().expiry_block, 20);
	});
}

// ── trigger ────────────────────────────────────────────────────────────

#[test]
fn trigger_executes_remark_call_and_pays_reward() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let caller_before = Balances::free_balance(3);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![remark_call(b"last words")],
			10,
			REWARD,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));

		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.status, SwitchStatus::Executed);
		// Caller got the reward
		assert_eq!(Balances::free_balance(3), caller_before + REWARD);
		// Stored calls preserved for querying
		assert!(SwitchCalls::<Test>::get(0).is_some());
	});
}

#[test]
fn trigger_executes_transfer_call_best_effort() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let bal2_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![transfer_call(2, 50_000)],
			10,
			REWARD,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		// Transfer executed as owner (account 1)
		assert_eq!(Balances::free_balance(2), bal2_before + 50_000);
	});
}

#[test]
fn trigger_transfer_fails_if_owner_has_no_balance() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Owner creates switch with transfer of 900k
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![transfer_call(2, 900_000)],
			10,
			REWARD,
		));
		// Owner spends most of their free balance
		assert_ok!(Balances::transfer_allow_death(
			RuntimeOrigin::signed(1), 4, 900_000,
		));

		System::set_block_number(12);
		// Trigger still succeeds (best-effort), but the transfer call fails
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		let switch = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch.status, SwitchStatus::Executed);
	});
}

#[test]
fn trigger_with_multiple_calls_partial_success() {
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
			REWARD,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		// First transfer succeeded
		assert_eq!(Balances::free_balance(2), bal2_before + 50_000);
	});
}

#[test]
fn trigger_transfer_all_to_beneficiary() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let alice_before = Balances::free_balance(1);
		let bob_before = Balances::free_balance(2);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![transfer_all_call(2)],
			10,
			REWARD,
		));

		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		// Reward is paid to caller first, releasing the hold.
		// Then transfer_all runs with no active holds, so Alice's
		// entire free balance goes to Bob and Alice ends at zero.
		assert_eq!(Balances::free_balance(1), 0);
		assert_eq!(Balances::free_balance(2), bob_before + alice_before - REWARD);
	});
}

#[test]
fn trigger_with_zero_reward() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let caller_before = Balances::free_balance(3);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![remark_call(b"no reward")],
			10,
			0,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		assert_eq!(Balances::free_balance(3), caller_before);
	});
}

#[test]
fn owner_can_trigger_own_switch() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let owner_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![remark_call(b"self trigger")],
			10,
			REWARD,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(1), 0));
		// Owner gets reward back (net zero cost)
		assert_eq!(Balances::free_balance(1), owner_before);
	});
}

#[test]
fn trigger_fails_before_expiry_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
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
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		assert_noop!(
			DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0),
			Error::<Test>::SwitchNotActive,
		);
	});
}

// ── cancel ─────────────────────────────────────────────────────────────

#[test]
fn cancel_returns_reward_and_cleans_calls() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
		));
		assert_eq!(Balances::free_balance(1), free_before - REWARD);

		assert_ok!(DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0));
		assert!(Switches::<Test>::get(0).is_none());
		assert!(SwitchCalls::<Test>::get(0).is_none());
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

#[test]
fn cancel_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
		));
		assert_noop!(
			DeadmanSwitch::cancel(RuntimeOrigin::signed(2), 0),
			Error::<Test>::NotOwner,
		);
	});
}

#[test]
fn cancel_after_expiry() {
	new_test_ext().execute_with(|| {
		let free_before = Balances::free_balance(1);
		System::set_block_number(1);
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1), vec![remark_call(b"x")], 10, REWARD,
		));
		System::set_block_number(20);
		assert_ok!(DeadmanSwitch::cancel(RuntimeOrigin::signed(1), 0));
		assert_eq!(Balances::free_balance(1), free_before);
	});
}

// ── proxy call ─────────────────────────────────────────────────────────

#[test]
fn trigger_executes_add_proxy_call() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Owner creates a switch that grants account 2 proxy access on trigger
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
			REWARD,
		));
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));
		// Account 2 now has proxy access to account 1
		let proxies = pallet_proxy::Proxies::<Test>::get(1);
		assert_eq!(proxies.0.len(), 1);
		assert_eq!(proxies.0[0].delegate, 2);
	});
}

// ── multisig call ──────────────────────────────────────────────────────

#[test]
fn trigger_creates_multisig_then_bob_and_charlie_transfer_to_dave() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Alice (1) creates a switch that, on trigger, transfers funds to a
		// 2-of-2 multisig account controlled by Bob (2) and Charlie (3).
		// After trigger, Bob and Charlie cooperate to transfer from the
		// multisig to Dave (4).

		// Derive the multisig account for Bob + Charlie (2-of-2)
		let multisig_account =
			pallet_multisig::Pallet::<Test>::multi_account_id(&[2, 3], 2);

		// Alice's switch: transfer 100k to the Bob+Charlie multisig account
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
			REWARD,
		));

		// Trigger the switch — funds transfer from Alice to the multisig account
		System::set_block_number(12);
		let dave_before = Balances::free_balance(4);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(4), 0));

		// Multisig account now has 100k
		assert_eq!(Balances::free_balance(multisig_account), 100_000);

		// Bob initiates a 2-of-2 transfer of 50k from multisig to Dave
		let transfer_to_dave = RuntimeCall::Balances(
			pallet_balances::Call::transfer_allow_death {
				dest: 4u64.into(),
				value: 50_000,
			},
		);
		let call_weight = transfer_to_dave.get_dispatch_info().call_weight;

		// Bob (2) submits first approval with the full call
		assert_ok!(pallet_multisig::Pallet::<Test>::as_multi(
			RuntimeOrigin::signed(2),
			2,
			vec![3],
			None,
			Box::new(transfer_to_dave.clone()),
			call_weight,
		));

		// Dave has NOT received funds yet — only 1 of 2 approvals
		assert_eq!(Balances::free_balance(4), dave_before + REWARD);

		// Charlie (3) approves — reaches threshold, transfer executes
		let call_hash: [u8; 32] =
			frame::deps::sp_runtime::traits::BlakeTwo256::hash_of(&transfer_to_dave).into();
		let timepoint = pallet_multisig::Pallet::<Test>::timepoint();
		assert_ok!(pallet_multisig::Pallet::<Test>::as_multi(
			RuntimeOrigin::signed(3),
			2,
			vec![2],
			Some(timepoint),
			Box::new(transfer_to_dave),
			call_weight,
		));

		// Dave received 50k from the multisig
		assert_eq!(Balances::free_balance(4), dave_before + REWARD + 50_000);

		// Multisig has 50k remaining
		assert_eq!(Balances::free_balance(multisig_account), 50_000);
	});
}

// ── proxy + multisig ───────────────────────────────────────────────────

#[test]
fn trigger_adds_multisig_proxy_then_bob_charlie_operate_alice_account() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Alice (1) creates a switch that, on trigger, adds a 2-of-2
		// multisig(Bob, Charlie) as proxy for her account. After trigger,
		// Bob and Charlie can operate Alice's account via proxy+multisig
		// without Alice needing to transfer funds anywhere.

		let multisig_account =
			pallet_multisig::Pallet::<Test>::multi_account_id(&[2, 3], 2);

		// Alice's switch: add the multisig account as proxy
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
			REWARD,
		));

		// Trigger the switch — multisig(Bob,Charlie) becomes proxy for Alice
		System::set_block_number(12);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(4), 0));

		// Verify proxy was added
		let proxies = pallet_proxy::Proxies::<Test>::get(1);
		assert_eq!(proxies.0.len(), 1);
		assert_eq!(proxies.0[0].delegate, multisig_account);

		// Now Bob and Charlie use multisig to execute a proxy call
		// transferring 50k FROM ALICE'S ACCOUNT to Dave
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

		// Bob (2) initiates the multisig proxy call
		assert_ok!(pallet_multisig::Pallet::<Test>::as_multi(
			RuntimeOrigin::signed(2),
			2,
			vec![3],
			None,
			Box::new(transfer_from_alice.clone()),
			call_weight,
		));

		// Dave has NOT received yet — 1 of 2 approvals
		assert_eq!(Balances::free_balance(4), dave_before);

		// Charlie (3) approves — threshold reached, proxy call executes
		let timepoint = pallet_multisig::Pallet::<Test>::timepoint();
		assert_ok!(pallet_multisig::Pallet::<Test>::as_multi(
			RuntimeOrigin::signed(3),
			2,
			vec![2],
			Some(timepoint),
			Box::new(transfer_from_alice),
			call_weight,
		));

		// Dave received 50k FROM ALICE'S ACCOUNT (not from a separate multisig account)
		assert_eq!(Balances::free_balance(4), dave_before + 50_000);
		assert_eq!(Balances::free_balance(1), alice_before - 50_000);
	});
}

// ── chained switches ───────────────────────────────────────────────────

#[test]
fn trigger_remark_then_create_second_switch_with_later_remark() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);

		// First switch: remark + create a second switch 10 blocks later
		let second_switch_call = Box::new(RuntimeCall::DeadmanSwitch(
			crate::Call::create_switch {
				calls: vec![Box::new(RuntimeCall::System(
					frame_system::Call::remark { remark: b"second message".to_vec() },
				))],
				block_interval: 10,
				trigger_reward: 0,
			},
		));
		assert_ok!(DeadmanSwitch::create_switch(
			RuntimeOrigin::signed(1),
			vec![
				remark_call(b"first message"),
				second_switch_call,
			],
			5,
			REWARD,
		));

		// Trigger first switch at block 7
		System::set_block_number(7);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 0));

		// First switch executed
		let switch0 = Switches::<Test>::get(0).unwrap();
		assert_eq!(switch0.status, SwitchStatus::Executed);

		// Second switch was created by the first trigger (id=1)
		let switch1 = Switches::<Test>::get(1).unwrap();
		assert_eq!(switch1.owner, 1);
		assert_eq!(switch1.call_count, 1);
		assert_eq!(switch1.expiry_block, 17); // block 7 + interval 10
		assert_eq!(switch1.status, SwitchStatus::Active);

		// Trigger second switch at block 18
		System::set_block_number(18);
		assert_ok!(DeadmanSwitch::trigger(RuntimeOrigin::signed(3), 1));

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
				RuntimeOrigin::none(), vec![remark_call(b"x")], 10, REWARD,
			),
			DispatchError::BadOrigin,
		);
	});
}
