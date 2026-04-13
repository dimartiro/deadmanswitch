use frame::{
	deps::{frame_support::weights::constants::RocksDbWeight, frame_system::GenesisConfig},
	prelude::*,
	runtime::prelude::*,
	testing_prelude::*,
};

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
	pub const MaxBeneficiaries: u32 = 10;
}

impl crate::Config for Test {
	type WeightInfo = ();
	type Currency = Balances;
	type Balance = u64;
	type RuntimeHoldReason = RuntimeHoldReason;
	type MaxBeneficiaries = MaxBeneficiaries;
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
