use frame::{
	deps::{frame_support::weights::constants::RocksDbWeight, frame_system::GenesisConfig},
	prelude::*,
	runtime::prelude::*,
	testing_prelude::*,
};

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
	pub type DeadmanSwitch = crate;
	#[runtime::pallet_index(3)]
	pub type Proxy = pallet_proxy;
	#[runtime::pallet_index(4)]
	pub type Multisig = pallet_multisig;
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
	pub const MaxCalls: u32 = 5;
	pub const MaxCallSize: u32 = 1024;
}

impl crate::Config for Test {
	type WeightInfo = ();
	type Currency = Balances;
	type Balance = u64;
	type RuntimeHoldReason = RuntimeHoldReason;
	type RuntimeCall = RuntimeCall;
	type MaxCalls = MaxCalls;
	type MaxCallSize = MaxCallSize;
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
