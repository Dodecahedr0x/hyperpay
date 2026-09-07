//! # HyperPay
//!
//! Client for the HyperPay payment-session program on Solana. The SDK builds,
//! signs, and submits program instructions — it does not call a hosted payments
//! API.
//!
//! ```no_run
//! use hyperpay::{HyperPay, SessionOpts};
//!
//! # async fn demo() -> hyperpay::Result<()> {
//! let user = HyperPay::from_env()?;
//! user.init_user(1_000_000).await?;
//! user.delegate_user(None).await?;
//! user.top_up("10 USDC", SessionOpts::default()).await?;
//! user.open_session(
//!     "Merchant1111111111111111111111111111111",
//!     "10 USDC",
//!     SessionOpts::default(),
//! )
//! .await?;
//!
//! let merchant = HyperPay::from_env()?;
//! let payment = merchant
//!     .charge("User11111111111111111111111111111111", "1 USDC")
//!     .await?;
//! println!("paid: {}", payment.signature);
//! # Ok(()) }
//! ```
//!
//! Typical flow: [`HyperPay::init_user`] → [`HyperPay::delegate_user`] →
//! [`HyperPay::top_up`] → [`HyperPay::open_session`] → merchant
//! [`HyperPay::charge`] → [`HyperPay::close_session`] → [`HyperPay::withdraw`].
//!
//! When the signer is a session key, pass [`SessionOpts::authority`] (the wallet
//! that owns the User PDA).

mod amounts;
mod client;
mod engine;
mod error;
mod policy;
mod program;

pub use amounts::{format_amount, from_base_units, to_base_units, TokenInfo};
pub use client::{load_keypair, parse_tokens_env, Balance, HyperPay, Payment, Quote, SessionOpts};
pub use error::{HyperPayError, Result};
pub use policy::{default_journal_path, matches_pattern, Policy};
pub use program::{
    associated_token_address, charge_ix, close_session_ix, delegate_ephemeral_ata_ix,
    delegate_user_ix, deposit_ix, deposit_spl_ix, eata_pda, ensure_user_mint_ix,
    init_ephemeral_ata_ix, init_global_vault_ix, init_user_ix, open_session_ix, session_pda,
    user_mint_pda, user_pda, vault_pda, withdraw_ix, SessionAccounts, WithdrawAccounts,
    DELEGATION_PROGRAM_ID, LOCAL_ER_VALIDATOR, PROGRAM_ID, SESSION_REMAINING_OFFSET,
};
