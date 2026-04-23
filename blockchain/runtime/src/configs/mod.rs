mod xcm_config;

use polkadot_sdk::{staging_xcm as xcm, *};

use cumulus_pallet_parachain_system::RelayNumberMonotonicallyIncreases;
use cumulus_primitives_core::{AggregateMessageOrigin, ParaId};
use frame_support::{
	derive_impl,
	dispatch::DispatchClass,
	parameter_types,
	traits::{
		ConstBool, ConstU32, ConstU64, ConstU8, EitherOfDiverse, TransformOrigin, VariantCountOf,
	},
	weights::{ConstantMultiplier, Weight},
	PalletId,
};
use frame_system::{
	limits::{BlockLength, BlockWeights},
	EnsureRoot, EnsureSigned,
};
use pallet_xcm::{EnsureXcm, IsVoiceOfBody};
use parachains_common::message_queue::{NarrowOriginToSibling, ParaIdToSibling};
use polkadot_runtime_common::{
	xcm_sender::NoPriceForMessageDelivery, BlockHashCount, SlowAdjustingFeeUpdate,
};
use codec::{Encode, Decode, MaxEncodedLen};
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_runtime::{traits::BlakeTwo256, Perbill, RuntimeDebug};
use sp_version::RuntimeVersion;
use xcm::latest::prelude::*;
use xcm::VersionedXcm;

use super::{
	weights::{BlockExecutionWeight, ExtrinsicBaseWeight, RocksDbWeight},
	AccountId, Aura, Balance, Balances, Block, BlockNumber, CollatorSelection, ConsensusHook, Hash,
	MessageQueue, Nonce, OriginCaller, PalletInfo, ParachainSystem, Runtime, RuntimeCall,
	RuntimeEvent, RuntimeFreezeReason, RuntimeHoldReason, RuntimeOrigin, RuntimeTask, Scheduler,
	Session, SessionKeys, Signature, System, Timestamp, XcmpQueue, AVERAGE_ON_INITIALIZE_RATIO,
	EXISTENTIAL_DEPOSIT, HOURS, MAXIMUM_BLOCK_WEIGHT, MICRO_UNIT, NORMAL_DISPATCH_RATIO,
	SLOT_DURATION, VERSION,
};
use xcm_config::{RelayLocation, XcmOriginToTransactDispatchOrigin};

parameter_types! {
	pub const Version: RuntimeVersion = VERSION;
	pub RuntimeBlockLength: BlockLength =
		BlockLength::max_with_normal_ratio(5 * 1024 * 1024, NORMAL_DISPATCH_RATIO);
	pub RuntimeBlockWeights: BlockWeights = BlockWeights::builder()
		.base_block(BlockExecutionWeight::get())
		.for_class(DispatchClass::all(), |weights| {
			weights.base_extrinsic = ExtrinsicBaseWeight::get();
		})
		.for_class(DispatchClass::Normal, |weights| {
			weights.max_total = Some(NORMAL_DISPATCH_RATIO * MAXIMUM_BLOCK_WEIGHT);
		})
		.for_class(DispatchClass::Operational, |weights| {
			weights.max_total = Some(MAXIMUM_BLOCK_WEIGHT);
			weights.reserved = Some(
				MAXIMUM_BLOCK_WEIGHT - NORMAL_DISPATCH_RATIO * MAXIMUM_BLOCK_WEIGHT
			);
		})
		.avg_block_initialization(AVERAGE_ON_INITIALIZE_RATIO)
		.build_or_panic();
	pub const SS58Prefix: u16 = 42;
}

#[derive_impl(frame_system::config_preludes::ParaChainDefaultConfig)]
impl frame_system::Config for Runtime {
	type AccountId = AccountId;
	type Nonce = Nonce;
	type Hash = Hash;
	type Block = Block;
	type BlockHashCount = BlockHashCount;
	type Version = Version;
	type AccountData = pallet_balances::AccountData<Balance>;
	type DbWeight = RocksDbWeight;
	type BlockWeights = RuntimeBlockWeights;
	type BlockLength = RuntimeBlockLength;
	type SS58Prefix = SS58Prefix;
	type OnSetCode = cumulus_pallet_parachain_system::ParachainSetCode<Self>;
	type MaxConsumers = frame_support::traits::ConstU32<16>;
}

impl cumulus_pallet_weight_reclaim::Config for Runtime {
	type WeightInfo = ();
}

impl pallet_timestamp::Config for Runtime {
	type Moment = u64;
	type OnTimestampSet = Aura;
	type MinimumPeriod = ConstU64<0>;
	type WeightInfo = ();
}

impl pallet_authorship::Config for Runtime {
	type FindAuthor = pallet_session::FindAccountFromAuthorIndex<Self, Aura>;
	type EventHandler = (CollatorSelection,);
}

parameter_types! {
	pub const ExistentialDeposit: Balance = EXISTENTIAL_DEPOSIT;
}

impl pallet_balances::Config for Runtime {
	type MaxLocks = ConstU32<50>;
	type Balance = Balance;
	type RuntimeEvent = RuntimeEvent;
	type DustRemoval = ();
	type ExistentialDeposit = ExistentialDeposit;
	type AccountStore = System;
	type WeightInfo = pallet_balances::weights::SubstrateWeight<Runtime>;
	type MaxReserves = ConstU32<50>;
	type ReserveIdentifier = [u8; 8];
	type RuntimeHoldReason = RuntimeHoldReason;
	type RuntimeFreezeReason = RuntimeFreezeReason;
	type FreezeIdentifier = RuntimeFreezeReason;
	type MaxFreezes = VariantCountOf<RuntimeFreezeReason>;
	type DoneSlashHandler = ();
}

parameter_types! {
	pub const TransactionByteFee: Balance = 10 * MICRO_UNIT;
}

impl pallet_transaction_payment::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type OnChargeTransaction = pallet_transaction_payment::FungibleAdapter<Balances, ()>;
	type WeightToFee = pallet_revive::evm::fees::BlockRatioFee<
		{ super::MILLI_UNIT / 10 },
		{ (100 * ExtrinsicBaseWeight::get().ref_time()) as u128 },
		Runtime,
		Balance,
	>;
	type LengthToFee = ConstantMultiplier<Balance, TransactionByteFee>;
	type FeeMultiplierUpdate = SlowAdjustingFeeUpdate<Self>;
	type OperationalFeeMultiplier = ConstU8<5>;
	type WeightInfo = ();
}

impl pallet_sudo::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type WeightInfo = ();
}

// ── pallet-skip-feeless-payment ───────────────────────────────────────
//
// Wraps `pallet-transaction-payment` so that calls annotated with
// `#[pallet::feeless_if(...)]` pay no fee when the predicate returns true.
// Used by `pallet-estate-executor` to make heartbeat-by-owner free.

impl pallet_skip_feeless_payment::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
}

// ── pallet-scheduler ──────────────────────────────────────────────────
//
// Used by pallet-estate-executor to auto-execute wills at expiry.
// `ScheduleOrigin` is `EnsureRoot` so user accounts cannot directly spam
// the public `schedule` extrinsic — they can only queue tasks through
// pallets (like estate-executor) that wrap the `ScheduleNamed` trait.

parameter_types! {
	pub MaximumSchedulerWeight: Weight =
		Perbill::from_percent(80) * RuntimeBlockWeights::get().max_block;
	pub const MaxScheduledPerBlock: u32 = 50;
}

impl pallet_scheduler::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeOrigin = RuntimeOrigin;
	type PalletsOrigin = OriginCaller;
	type RuntimeCall = RuntimeCall;
	type MaximumWeight = MaximumSchedulerWeight;
	type ScheduleOrigin = EnsureRoot<AccountId>;
	type MaxScheduledPerBlock = MaxScheduledPerBlock;
	type WeightInfo = pallet_scheduler::weights::SubstrateWeight<Runtime>;
	type OriginPrivilegeCmp = frame_support::traits::EqualPrivilegeOnly;
	type Preimages = ();
	type BlockNumberProvider = System;
}

parameter_types! {
	pub const ReservedXcmpWeight: Weight = MAXIMUM_BLOCK_WEIGHT.saturating_div(4);
	pub const ReservedDmpWeight: Weight = MAXIMUM_BLOCK_WEIGHT.saturating_div(4);
	pub const RelayOrigin: AggregateMessageOrigin = AggregateMessageOrigin::Parent;
}

impl cumulus_pallet_parachain_system::Config for Runtime {
	type WeightInfo = ();
	type RuntimeEvent = RuntimeEvent;
	type OnSystemEvent = ();
	type SelfParaId = staging_parachain_info::Pallet<Runtime>;
	type OutboundXcmpMessageSource = XcmpQueue;
	type DmpQueue = frame_support::traits::EnqueueWithOrigin<MessageQueue, RelayOrigin>;
	type ReservedDmpWeight = ReservedDmpWeight;
	type XcmpMessageHandler = XcmpQueue;
	type ReservedXcmpWeight = ReservedXcmpWeight;
	type CheckAssociatedRelayNumber = RelayNumberMonotonicallyIncreases;
	type ConsensusHook = ConsensusHook;
	type RelayParentOffset = ConstU32<0>;
}

impl staging_parachain_info::Config for Runtime {}

parameter_types! {
	pub MessageQueueServiceWeight: Weight = Perbill::from_percent(35) * RuntimeBlockWeights::get().max_block;
}

impl pallet_message_queue::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type WeightInfo = ();
	#[cfg(feature = "runtime-benchmarks")]
	type MessageProcessor = pallet_message_queue::mock_helpers::NoopMessageProcessor<
		cumulus_primitives_core::AggregateMessageOrigin,
	>;
	#[cfg(not(feature = "runtime-benchmarks"))]
	type MessageProcessor = staging_xcm_builder::ProcessXcmMessage<
		AggregateMessageOrigin,
		staging_xcm_executor::XcmExecutor<xcm_config::XcmConfig>,
		RuntimeCall,
	>;
	type Size = u32;
	type QueueChangeHandler = NarrowOriginToSibling<XcmpQueue>;
	type QueuePausedQuery = NarrowOriginToSibling<XcmpQueue>;
	type HeapSize = sp_core::ConstU32<{ 103 * 1024 }>;
	type MaxStale = sp_core::ConstU32<8>;
	type ServiceWeight = MessageQueueServiceWeight;
	type IdleMaxServiceWeight = ();
}

impl cumulus_pallet_aura_ext::Config for Runtime {}

impl cumulus_pallet_xcmp_queue::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type ChannelInfo = ParachainSystem;
	type VersionWrapper = ();
	type XcmpQueue = TransformOrigin<MessageQueue, AggregateMessageOrigin, ParaId, ParaIdToSibling>;
	type MaxInboundSuspended = sp_core::ConstU32<1_000>;
	type MaxActiveOutboundChannels = ConstU32<128>;
	type MaxPageSize = ConstU32<{ 1 << 16 }>;
	type ControllerOrigin = EnsureRoot<AccountId>;
	type ControllerOriginConverter = XcmOriginToTransactDispatchOrigin;
	type WeightInfo = ();
	type PriceForSiblingDelivery = NoPriceForMessageDelivery<ParaId>;
}

parameter_types! {
	/// Session rotation period — sessions last 6 hours worth of blocks.
	pub const Period: u32 = 6 * HOURS;
	pub const Offset: u32 = 0;
}

impl pallet_session::Config for Runtime {
	type Currency = Balances;
	type KeyDeposit = ();
	type RuntimeEvent = RuntimeEvent;
	type ValidatorId = <Self as frame_system::Config>::AccountId;
	type ValidatorIdOf = pallet_collator_selection::IdentityCollator;
	type ShouldEndSession = pallet_session::PeriodicSessions<Period, Offset>;
	type NextSessionRotation = pallet_session::PeriodicSessions<Period, Offset>;
	type SessionManager = CollatorSelection;
	type SessionHandler = <SessionKeys as sp_runtime::traits::OpaqueKeys>::KeyTypeIdProviders;
	type Keys = SessionKeys;
	type DisablingStrategy = ();
	type WeightInfo = ();
}

impl pallet_aura::Config for Runtime {
	type AuthorityId = AuraId;
	type DisabledValidators = ();
	type MaxAuthorities = ConstU32<100_000>;
	type AllowMultipleBlocksPerSlot = ConstBool<true>;
	type SlotDuration = ConstU64<SLOT_DURATION>;
}

parameter_types! {
	pub const PotId: PalletId = PalletId(*b"PotStake");
	/// Session length for collator-selection kick threshold evaluation.
	pub const SessionLength: BlockNumber = 6 * HOURS;
	pub const StakingAdminBodyId: BodyId = BodyId::Defense;
}

pub type CollatorSelectionUpdateOrigin = EitherOfDiverse<
	EnsureRoot<AccountId>,
	EnsureXcm<IsVoiceOfBody<RelayLocation, StakingAdminBodyId>>,
>;

impl pallet_collator_selection::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Currency = Balances;
	type UpdateOrigin = CollatorSelectionUpdateOrigin;
	type PotId = PotId;
	type MaxCandidates = ConstU32<100>;
	type MinEligibleCollators = ConstU32<4>;
	type MaxInvulnerables = ConstU32<20>;
	type KickThreshold = Period;
	type ValidatorId = <Self as frame_system::Config>::AccountId;
	type ValidatorIdOf = pallet_collator_selection::IdentityCollator;
	type ValidatorRegistration = Session;
	type WeightInfo = ();
}

// Statement Store cost parameters.
// StatementCost: flat fee per statement (10x existential deposit).
// StatementByteCost: per-byte fee (existential deposit / 1024).
// Min/MaxAllowedStatements: per-account statement count limits.
// Min/MaxAllowedBytes: per-account total byte limits (1 MiB to 16 MiB).
parameter_types! {
	pub const StatementCost: Balance = 10 * EXISTENTIAL_DEPOSIT;
	pub const StatementByteCost: Balance = EXISTENTIAL_DEPOSIT / 1024;
	pub const MinAllowedStatements: u32 = 1;
	pub const MaxAllowedStatements: u32 = 16;
	pub const MinAllowedBytes: u32 = 1024 * 1024;
	pub const MaxAllowedBytes: u32 = 16 * 1024 * 1024;
}

impl pallet_statement::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Currency = Balances;
	type StatementCost = StatementCost;
	type ByteCost = StatementByteCost;
	type MinAllowedStatements = MinAllowedStatements;
	type MaxAllowedStatements = MaxAllowedStatements;
	type MinAllowedBytes = MinAllowedBytes;
	type MaxAllowedBytes = MaxAllowedBytes;
}

// ── Estate Executor ───────────────────────────────────────────────────
//
// The pallet stores a typed `Vec<Bequest>` per will. At execution
// time, this translator turns each variant into a concrete `RuntimeCall`
// so the pallet stays agnostic of Balances, Proxy, etc.

pub struct RuntimeBequestBuilder;

// Pallet call indices on Asset Hub (asset-hub-rococo runtime).
// Verified against
// `polkadot-sdk/cumulus/parachains/runtimes/assets/asset-hub-rococo/src/lib.rs`
// construct_runtime! — update these constants when the upstream runtime
// shuffles pallet_index values.
const AH_BALANCES_PALLET: u8 = 10;
const AH_PROXY_PALLET: u8 = 42;
const AH_BALANCES_TRANSFER_KEEP_ALIVE: u8 = 3;
const AH_BALANCES_TRANSFER_ALL: u8 = 4;
const AH_PROXY_PROXY: u8 = 0;
const AH_PROXY_ADD_PROXY: u8 = 1;
const MULTIADDR_ID: u8 = 0;
const OPT_NONE: u8 = 0;
// Asset Hub's `pallet-proxy` `ProxyType::Any` discriminant = 0. Kept
// as a u8 constant because our runtime does not link asset-hub-rococo
// and so cannot import its `ProxyType` enum directly.
const AH_PROXY_TYPE_ANY: u8 = 0;

fn ah_balances_transfer_keep_alive(
	dest: &AccountId,
	amount: Balance,
) -> alloc::vec::Vec<u8> {
	use codec::{Compact, Encode};
	let mut out = alloc::vec![
		AH_BALANCES_PALLET,
		AH_BALANCES_TRANSFER_KEEP_ALIVE,
		MULTIADDR_ID,
	];
	out.extend_from_slice(&dest.encode());
	Compact::<u128>(amount).encode_to(&mut out);
	out
}

fn ah_balances_transfer_all(dest: &AccountId) -> alloc::vec::Vec<u8> {
	use codec::Encode;
	let mut out = alloc::vec![AH_BALANCES_PALLET, AH_BALANCES_TRANSFER_ALL, MULTIADDR_ID];
	out.extend_from_slice(&dest.encode());
	// keep_alive: bool = false (reap the source account)
	out.push(0);
	out
}

fn ah_proxy_add_proxy(delegate: &AccountId) -> alloc::vec::Vec<u8> {
	use codec::Encode;
	let mut out = alloc::vec![AH_PROXY_PALLET, AH_PROXY_ADD_PROXY, MULTIADDR_ID];
	out.extend_from_slice(&delegate.encode());
	out.push(AH_PROXY_TYPE_ANY);
	// delay: BlockNumber = 0 (u32 little-endian)
	out.extend_from_slice(&0u32.encode());
	out
}

/// Wrap an inner Asset Hub call in `Proxy.proxy(real, None, call)` so
/// it executes as `real` when the XCM origin is a proxy of `real`.
fn ah_wrap_proxy(real: &AccountId, inner: alloc::vec::Vec<u8>) -> alloc::vec::Vec<u8> {
	use codec::Encode;
	let mut out = alloc::vec![AH_PROXY_PALLET, AH_PROXY_PROXY, MULTIADDR_ID];
	out.extend_from_slice(&real.encode());
	out.push(OPT_NONE);
	out.extend_from_slice(&inner);
	out
}

/// Build the XCM message that dispatches an Asset Hub call as `owner`.
/// Wraps the call in `Proxy.proxy` so Asset Hub executes it as `owner`
/// (requires ESP sovereign to be a proxy of `owner` — the "Link to
/// Asset Hub" flow).
fn build_ah_proxy_xcm(owner: &AccountId, inner_call: alloc::vec::Vec<u8>) -> VersionedXcm<()> {
	// Fees paid on Asset Hub in its native token (relay-native, i.e.
	// Parent location). 100 ROC is conservative dev-mode slack;
	// unused balance ends up in the Asset Hub AssetTrap.
	let fee_amount: u128 = 100_000_000_000_000;
	let fees: Asset = (Location::parent(), fee_amount).into();
	let proxy_call = ah_wrap_proxy(owner, inner_call);
	let message: Xcm<()> = Xcm(alloc::vec![
		WithdrawAsset(fees.clone().into()),
		BuyExecution { fees, weight_limit: WeightLimit::Unlimited },
		Transact {
			origin_kind: OriginKind::SovereignAccount,
			call: proxy_call.into(),
			fallback_max_weight: None,
		},
	]);
	VersionedXcm::from(message)
}

// Our parachain's para_id on the relay chain. Kept in sync with
// `blockchain/runtime/src/genesis_config_presets.rs::PARACHAIN_ID`.
pub const ESTATE_EXECUTOR_PALLET_ID_PARA_ID: u32 = 2000;

impl pallet_estate_executor::BequestBuilder<Runtime> for RuntimeBequestBuilder {
	fn dispatch(
		dist: &pallet_estate_executor::Bequest<Runtime>,
		owner: &AccountId,
	) -> sp_runtime::DispatchResult {
		use pallet_estate_executor::Bequest;
		// Every bequest variant now dispatches against Asset Hub. Build
		// the inner AH call per variant, then wrap in Proxy.proxy(owner,
		// _) and ship via `pallet_xcm::send_xcm(Here, ...)` so the
		// outbound origin is our parachain sovereign — the delegate
		// that actually holds proxy rights over `owner` on Asset Hub.
		let inner_call = match dist {
			Bequest::Transfer { dest, amount } =>
				ah_balances_transfer_keep_alive(dest, *amount),
			Bequest::TransferAll { dest } => ah_balances_transfer_all(dest),
			Bequest::Proxy { delegate } => ah_proxy_add_proxy(delegate),
			Bequest::MultisigProxy { delegates, threshold } => {
				let multisig = pallet_multisig::Pallet::<Runtime>::multi_account_id(
					delegates.as_ref(),
					*threshold,
				);
				ah_proxy_add_proxy(&multisig)
			},
		};

		let target: Location = Location::new(1, [Parachain(1000)]);
		let message_inner: Xcm<()> = match build_ah_proxy_xcm(owner, inner_call) {
			VersionedXcm::V5(m) => m,
			_ => return Err(sp_runtime::DispatchError::Other(
				"unsupported xcm version",
			)),
		};
		pallet_xcm::Pallet::<Runtime>::send_xcm(Here, target, message_inner)
			.map(|_| ())
			.map_err(|_| sp_runtime::DispatchError::Other("xcm send failed"))
	}
}

/// Identity check stub. Real verification is performed client-side
/// against **People Chain** (a sibling parachain with `pallet-identity`),
/// which is the canonical identity registry in the Polkadot ecosystem.
///
/// The stub accepts any account because on-chain cross-parachain state
/// reads are not supported by XCM out of the box (no "read storage of
/// another chain" instruction). Production deployments targeting the
/// Polkadot ecosystem need one of: a light client bridge verifying
/// People Chain state proofs, or an attestation-based protocol where
/// users submit signed claims. Both are significant work and out of
/// scope for this iteration.
///
/// The honest security posture today: the Estate Protocol trusts the
/// frontend to enforce identity by querying People Chain directly. A
/// malicious user bypassing the frontend could create wills naming
/// unverified beneficiaries, but that only degrades product UX (no
/// security-critical invariant is protected by this check).
pub struct IdentityCheckStub;
impl pallet_estate_executor::IdentityCheck<Runtime> for IdentityCheckStub {
	fn is_verified(_account: &AccountId) -> bool {
		true
	}
}

// ── Estate Executor certificate minter ────────────────────────────────
//
// Translates the pallet's `mint_inheritance_certificate` call into
// concrete `pallet-nfts` operations. Keeps the pallet agnostic of which
// NFT pallet is in the runtime.

pub const ESTATE_EXECUTOR_PALLET_ID: frame_support::PalletId =
	frame_support::PalletId(*b"estateex");

pub struct RuntimeCertificateMinter;

impl pallet_estate_executor::CertificateMinter<Runtime> for RuntimeCertificateMinter {
	fn mint_inheritance_certificate(
		will_id: pallet_estate_executor::WillId,
		beneficiary: AccountId,
		_executed_block: BlockNumber,
		_owner: AccountId,
	) -> frame_support::dispatch::DispatchResult {
		use codec::Encode;
		use sp_runtime::traits::AccountIdConversion;

		let sovereign: AccountId = ESTATE_EXECUTOR_PALLET_ID.into_account_truncating();

		// Lazily create the "Estate Inheritance Certificates" collection
		// on first mint. The collection id allocated by pallet-nfts is
		// remembered in the estate-executor pallet for future mints and
		// for the frontend to query.
		let collection_id = match pallet_estate_executor::Pallet::<Runtime>::certificate_collection_id() {
			Some(id) => id,
			None => {
				let id = pallet_nfts::NextCollectionId::<Runtime>::get().unwrap_or(0);
				let config = pallet_nfts::CollectionConfig {
					settings: pallet_nfts::CollectionSettings::all_enabled(),
					max_supply: None,
					mint_settings: pallet_nfts::MintSettings::default(),
				};
				pallet_nfts::Pallet::<Runtime>::create(
					frame_system::RawOrigin::Signed(sovereign.clone()).into(),
					sovereign.clone().into(),
					config,
				)?;
				pallet_estate_executor::Pallet::<Runtime>::set_certificate_collection_id(id);
				id
			},
		};

		// Derive a deterministic u32 item id from (will_id, beneficiary).
		let digest = sp_io::hashing::blake2_256(&(will_id, &beneficiary).encode());
		let mut id_bytes = [0u8; 4];
		id_bytes.copy_from_slice(&digest[..4]);
		let item_id = u32::from_le_bytes(id_bytes);

		// Mint to the beneficiary, then lock so the NFT is non-transferable
		// (soulbound).
		pallet_nfts::Pallet::<Runtime>::mint(
			frame_system::RawOrigin::Signed(sovereign.clone()).into(),
			collection_id,
			item_id,
			beneficiary.into(),
			None,
		)?;
		pallet_nfts::Pallet::<Runtime>::lock_item_transfer(
			frame_system::RawOrigin::Signed(sovereign).into(),
			collection_id,
			item_id,
		)?;

		Ok(())
	}
}

impl pallet_estate_executor::Config for Runtime {
	type WeightInfo = pallet_estate_executor::weights::SubstrateWeight<Runtime>;
	type Balance = Balance;
	type RuntimeCall = RuntimeCall;
	type PalletsOrigin = OriginCaller;
	type Scheduler = Scheduler;
	type BequestBuilder = RuntimeBequestBuilder;
	type IdentityCheck = IdentityCheckStub;
	type CertificateMinter = RuntimeCertificateMinter;
	type MaxBequests = ConstU32<5>;
}

// ── pallet-proxy ──────────────────────────────────────────────────────

/// Proxy types available in the runtime.
#[derive(
	Default,
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
	/// Unrestricted — can execute any call.
	#[default]
	Any,
	/// Can only execute balance transfers.
	Transfers,
}

impl frame_support::traits::InstanceFilter<RuntimeCall> for ProxyType {
	fn filter(&self, _c: &RuntimeCall) -> bool {
		match self {
			ProxyType::Any => true,
			ProxyType::Transfers => {
				matches!(
					_c,
					RuntimeCall::Balances(..)
				)
			},
		}
	}
}

parameter_types! {
	pub const ProxyDepositBase: Balance = EXISTENTIAL_DEPOSIT;
	pub const ProxyDepositFactor: Balance = EXISTENTIAL_DEPOSIT;
	pub const AnnouncementDepositBase: Balance = EXISTENTIAL_DEPOSIT;
	pub const AnnouncementDepositFactor: Balance = EXISTENTIAL_DEPOSIT;
}

impl pallet_proxy::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type Currency = Balances;
	type ProxyType = ProxyType;
	type ProxyDepositBase = ProxyDepositBase;
	type ProxyDepositFactor = ProxyDepositFactor;
	type MaxProxies = ConstU32<16>;
	type WeightInfo = ();
	type MaxPending = ConstU32<16>;
	type CallHasher = BlakeTwo256;
	type AnnouncementDepositBase = AnnouncementDepositBase;
	type AnnouncementDepositFactor = AnnouncementDepositFactor;
	type BlockNumberProvider = System;
}

// ── pallet-multisig ───────────────────────────────────────────────────

parameter_types! {
	pub const MultisigDepositBase: Balance = EXISTENTIAL_DEPOSIT;
	pub const MultisigDepositFactor: Balance = EXISTENTIAL_DEPOSIT;
}

impl pallet_multisig::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type Currency = Balances;
	type DepositBase = MultisigDepositBase;
	type DepositFactor = MultisigDepositFactor;
	type MaxSignatories = ConstU32<10>;
	type WeightInfo = ();
	type BlockNumberProvider = System;
}

// ── pallet-nfts ────────────────────────────────────────────────────────
//
// Hosts the "Estate Inheritance Certificates" collection. The Estate
// Executor pallet mints one soulbound certificate per (will, beneficiary)
// pair when a will executes.

parameter_types! {
	pub NftsPalletFeatures: pallet_nfts::PalletFeatures = pallet_nfts::PalletFeatures::all_enabled();
	pub const NftsMaxDeadlineDuration: BlockNumber = 12 * HOURS;
	// Deposits disabled in this dev configuration: the Estate Executor
	// sovereign account is the only entity that creates/mints in the
	// certificate collection and it has no balance. Production would set
	// non-zero deposits and fund the sovereign or gate collection
	// creation to Root.
	pub const NftsCollectionDeposit: Balance = 0;
	pub const NftsItemDeposit: Balance = 0;
	pub const NftsMetadataDepositBase: Balance = 0;
	pub const NftsAttributeDepositBase: Balance = 0;
	pub const NftsDepositPerByte: Balance = 0;
}

impl pallet_nfts::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type CollectionId = u32;
	type ItemId = u32;
	type Currency = Balances;
	type CreateOrigin =
		frame_support::traits::AsEnsureOriginWithArg<EnsureSigned<AccountId>>;
	type ForceOrigin = EnsureRoot<AccountId>;
	type Locker = ();
	type CollectionDeposit = NftsCollectionDeposit;
	type ItemDeposit = NftsItemDeposit;
	type MetadataDepositBase = NftsMetadataDepositBase;
	type AttributeDepositBase = NftsAttributeDepositBase;
	type DepositPerByte = NftsDepositPerByte;
	type StringLimit = ConstU32<256>;
	type KeyLimit = ConstU32<64>;
	type ValueLimit = ConstU32<256>;
	type ApprovalsLimit = ConstU32<20>;
	type ItemAttributesApprovalsLimit = ConstU32<30>;
	type MaxTips = ConstU32<10>;
	type MaxDeadlineDuration = NftsMaxDeadlineDuration;
	type MaxAttributesPerCall = ConstU32<10>;
	type Features = NftsPalletFeatures;
	type OffchainSignature = Signature;
	type OffchainPublic = <Signature as sp_runtime::traits::Verify>::Signer;
	type WeightInfo = pallet_nfts::weights::SubstrateWeight<Runtime>;
	#[cfg(feature = "runtime-benchmarks")]
	type Helper = ();
	type BlockNumberProvider = System;
}

// pallet-identity lives on People Chain, not here. Identity verification
// for will beneficiaries is enforced client-side against People Chain's
// state — see `IdentityCheckStub` below.

// ── pallet-revive (EVM + PVM smart contracts) ──────────────────────────

parameter_types! {
	pub const DepositPerItem: Balance = EXISTENTIAL_DEPOSIT;
	pub const DepositPerChildTrieItem: Balance = EXISTENTIAL_DEPOSIT / 10;
	pub const DepositPerByte: Balance = EXISTENTIAL_DEPOSIT / 100;
	pub CodeHashLockupDepositPercent: Perbill = Perbill::from_percent(30);
	pub const MaxEthExtrinsicWeight: sp_runtime::FixedU128 = sp_runtime::FixedU128::from_rational(5, 10);
}

impl pallet_revive::Config for Runtime {
	type Time = Timestamp;
	type Balance = Balance;
	type Currency = Balances;
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type RuntimeOrigin = RuntimeOrigin;
	type DepositPerItem = DepositPerItem;
	type DepositPerChildTrieItem = DepositPerChildTrieItem;
	type DepositPerByte = DepositPerByte;
	type WeightInfo = pallet_revive::weights::SubstrateWeight<Self>;
	type Precompiles = ();
	type AddressMapper = pallet_revive::AccountId32Mapper<Self>;
	type RuntimeMemory = ConstU32<{ 128 * 1024 * 1024 }>;
	type PVFMemory = ConstU32<{ 512 * 1024 * 1024 }>;
	type UnsafeUnstableInterface = ConstBool<false>;
	type UploadOrigin = EnsureSigned<Self::AccountId>;
	type InstantiateOrigin = EnsureSigned<Self::AccountId>;
	type RuntimeHoldReason = RuntimeHoldReason;
	type CodeHashLockupDepositPercent = CodeHashLockupDepositPercent;
	/// EVM chain ID for local dev. The Polkadot Hub TestNet uses 420420417; this local
	/// value avoids collisions. Must match the chain ID expected by eth-rpc and wallets.
	type ChainId = ConstU64<420_420_421>;
	type NativeToEthRatio = ConstU32<1_000_000>;
	type FindAuthor = <Runtime as pallet_authorship::Config>::FindAuthor;
	type AllowEVMBytecode = ConstBool<true>;
	type FeeInfo =
		pallet_revive::evm::fees::Info<super::Address, super::Signature, super::EthExtraImpl>;
	type MaxEthExtrinsicWeight = MaxEthExtrinsicWeight;
	type DebugEnabled = ConstBool<true>;
	type GasScale = ConstU32<50_000>;
}
