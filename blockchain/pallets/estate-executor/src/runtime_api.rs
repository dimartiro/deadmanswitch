//! Runtime API exposed to clients (frontend, RPC, off-chain workers).
//!
//! `decl_runtime_apis!` generates the trait that the runtime implements
//! via `impl_runtime_apis!` and that the client side can call through
//! `client.runtime_api().inheritances_of(at, account)`.
//!
//! The implementation in the runtime is just a thin wrapper over
//! [`crate::pallet::Pallet::inheritances_of`] — keeping the heavy lifting
//! in the pallet so it stays unit-testable.

use alloc::vec::Vec;
use crate::pallet::WillId;
use codec::Codec;
use frame::deps::sp_api::decl_runtime_apis;

decl_runtime_apis! {
	/// Estate Executor runtime API.
	pub trait EstateExecutorApi<AccountId>
	where
		AccountId: Codec,
	{
		/// Returns the IDs of all currently active wills that name
		/// `account` as a beneficiary. Active means the will exists and
		/// has not yet been executed or cancelled.
		fn inheritances_of(account: AccountId) -> Vec<WillId>;
	}
}
