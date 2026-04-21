use frame::{
	deps::{frame_support::weights::constants::RocksDbWeight, frame_system::GenesisConfig},
	prelude::*,
	runtime::prelude::*,
	testing_prelude::*,
};
use polkadot_sdk::{pallet_balances, pallet_multisig, pallet_proxy, pallet_scheduler};

/// Proxy type for the mock runtime.
#[derive(
	Copy,
	Clone,
	Eq,
	PartialEq,
	Ord,
	PartialOrd,
	Encode,
	Decode,
	codec::DecodeWithMemTracking,
	RuntimeDebug,
	MaxEncodedLen,
	scale_info::TypeInfo,
)]
pub enum ProxyType {
	Any,
}

impl Default for ProxyType {
	fn default() -> Self {
		Self::Any
	}
}

impl frame::traits::InstanceFilter<RuntimeCall> for ProxyType {
	fn filter(&self, _c: &RuntimeCall) -> bool {
		true
	}
}

// Configure a mock runtime to test the pallet.
#[frame_construct_runtime]
mod test_runtime {
	#[runtime::runtime]
	#[runtime::derive(
		RuntimeCall,
		RuntimeEvent,
		RuntimeError,
		RuntimeOrigin,
		RuntimeFreezeReason,
		RuntimeHoldReason,
		RuntimeSlashReason,
		RuntimeLockId,
		RuntimeTask,
		RuntimeViewFunction
	)]
	pub struct Test;

	#[runtime::pallet_index(0)]
	pub type System = frame_system;
	#[runtime::pallet_index(1)]
	pub type Balances = pallet_balances;
	#[runtime::pallet_index(2)]
	pub type EstateExecutor = crate;
	#[runtime::pallet_index(3)]
	pub type Proxy = pallet_proxy;
	#[runtime::pallet_index(4)]
	pub type Multisig = pallet_multisig;
	#[runtime::pallet_index(5)]
	pub type Scheduler = pallet_scheduler;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Nonce = u64;
	type Block = MockBlock<Test>;
	type BlockHashCount = ConstU64<250>;
	type DbWeight = RocksDbWeight;
	type AccountData = pallet_balances::AccountData<u64>;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig)]
impl pallet_balances::Config for Test {
	type AccountStore = System;
}

parameter_types! {
	pub const MaxBequests: u32 = 5;
	pub MaximumSchedulerWeight: frame::prelude::Weight =
		frame::prelude::Weight::from_parts(2_000_000_000_000, u64::MAX);
}

impl pallet_scheduler::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeOrigin = RuntimeOrigin;
	type PalletsOrigin = OriginCaller;
	type RuntimeCall = RuntimeCall;
	type MaximumWeight = MaximumSchedulerWeight;
	type ScheduleOrigin = frame_system::EnsureRoot<u64>;
	type MaxScheduledPerBlock = ConstU32<100>;
	type WeightInfo = ();
	type OriginPrivilegeCmp = frame::traits::EqualPrivilegeOnly;
	type Preimages = ();
	type BlockNumberProvider = System;
}

/// `BequestBuilder` impl for the mock runtime — maps each
/// `Bequest<Test>` variant to the equivalent `RuntimeCall`.
pub struct TestBequestBuilder;
impl crate::bequest::BequestBuilder<Test> for TestBequestBuilder {
	fn build_call(dist: &crate::bequest::Bequest<Test>) -> RuntimeCall {
		use crate::bequest::Bequest;
		match dist {
			Bequest::Transfer { dest, amount } =>
				RuntimeCall::Balances(pallet_balances::Call::transfer_allow_death {
					dest: (*dest).into(),
					value: *amount,
				}),
			Bequest::TransferAll { dest } =>
				RuntimeCall::Balances(pallet_balances::Call::transfer_all {
					dest: (*dest).into(),
					keep_alive: false,
				}),
			Bequest::Proxy { delegate } =>
				RuntimeCall::Proxy(pallet_proxy::Call::add_proxy {
					delegate: (*delegate).into(),
					proxy_type: ProxyType::Any,
					delay: 0,
				}),
			Bequest::MultisigProxy { delegates, threshold } => {
				let multisig =
					pallet_multisig::Pallet::<Test>::multi_account_id(
						&delegates.to_vec(),
						*threshold,
					);
				RuntimeCall::Proxy(pallet_proxy::Call::add_proxy {
					delegate: multisig.into(),
					proxy_type: ProxyType::Any,
					delay: 0,
				})
			},
		}
	}
}

/// Mock identity check: accounts 1..=4 are treated as verified.
/// Accounts 5+ are unverified — tests use them to exercise the rejection
/// path. This avoids dragging `pallet-identity` into the pallet's mock
/// while still letting us test the integration point.
pub struct MockIdentityCheck;
impl crate::identity::IdentityCheck<Test> for MockIdentityCheck {
	fn is_verified(account: &u64) -> bool {
		(1..=4).contains(account)
	}
}

/// Mock certificate minter: records each mint call in a thread-local
/// bucket so tests can assert exactly which `(will_id, beneficiary)`
/// pairs received a certificate. The real pallet-nfts is NOT required
/// to be in the mock.
use core::cell::RefCell;
thread_local! {
	static MINTED: RefCell<std::vec::Vec<(crate::WillId, u64)>> =
		const { RefCell::new(std::vec::Vec::new()) };
}

pub struct MockCertificateMinter;
impl crate::certificate::CertificateMinter<Test> for MockCertificateMinter {
	fn mint_inheritance_certificate(
		will_id: crate::WillId,
		beneficiary: u64,
		_executed_block: u64,
		_owner: u64,
	) -> DispatchResult {
		MINTED.with(|m| m.borrow_mut().push((will_id, beneficiary)));
		Ok(())
	}
}

/// Test-only: current set of minted certificates, cloned out of the
/// thread-local for assertions.
pub fn minted_certificates() -> std::vec::Vec<(crate::WillId, u64)> {
	MINTED.with(|m| m.borrow().clone())
}

/// Test-only: clear the mock's mint log between tests.
pub fn reset_minted_certificates() {
	MINTED.with(|m| m.borrow_mut().clear());
}

impl crate::Config for Test {
	type WeightInfo = ();
	type Balance = u64;
	type RuntimeCall = RuntimeCall;
	type PalletsOrigin = OriginCaller;
	type Scheduler = Scheduler;
	type BequestBuilder = TestBequestBuilder;
	type IdentityCheck = MockIdentityCheck;
	type CertificateMinter = MockCertificateMinter;
	type MaxBequests = MaxBequests;
}

impl pallet_proxy::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type Currency = Balances;
	type ProxyType = ProxyType;
	type ProxyDepositBase = ConstU64<1>;
	type ProxyDepositFactor = ConstU64<1>;
	type MaxProxies = ConstU32<16>;
	type WeightInfo = ();
	type MaxPending = ConstU32<16>;
	type CallHasher = frame::deps::sp_runtime::traits::BlakeTwo256;
	type AnnouncementDepositBase = ConstU64<1>;
	type AnnouncementDepositFactor = ConstU64<1>;
	type BlockNumberProvider = System;
}

impl pallet_multisig::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type Currency = Balances;
	type DepositBase = ConstU64<1>;
	type DepositFactor = ConstU64<1>;
	type MaxSignatories = ConstU32<10>;
	type WeightInfo = ();
	type BlockNumberProvider = System;
}

/// Build genesis storage with funded accounts.
pub fn new_test_ext() -> TestState {
	let mut t = GenesisConfig::<Test>::default().build_storage().unwrap();
	pallet_balances::GenesisConfig::<Test> {
		balances: vec![
			(1, 1_000_000),
			(2, 1_000_000),
			(3, 1_000_000),
			(4, 1_000_000),
		],
		dev_accounts: None,
	}
	.assimilate_storage(&mut t)
	.unwrap();
	t.into()
}

/// Drive the scheduler: advance to `to` by running `on_initialize` on each
/// intervening block. Mirrors how the real runtime drives pallet-scheduler.
pub fn run_to_block(to: u64) {
	while System::block_number() < to {
		let next = System::block_number() + 1;
		System::set_block_number(next);
		<Scheduler as frame::traits::Hooks<_>>::on_initialize(next);
	}
}
