//! # HyperPay
//!
//! Client for the HyperPay payment-session program on Solana. The SDK builds,
//! signs, and submits program instructions — it does not call a hosted payments
//! API.
//!
//! ```no_run
//! use hyperpay::HyperPay;
//!
//! # async fn demo() -> hyperpay::Result<()> {
//! let hp = HyperPay::from_env()?;
//! let payment = hp.charge("User11111111111111111111111111111111", "10 USDC").await?;
//! println!("paid: {}", payment.signature);
//! # Ok(()) }
//! ```
//!
//! ## Merchant charge
//!
//! A merchant reads remaining session units with [`HyperPay::session_balance`],
//! then debits the session with [`HyperPay::charge`]. The merchant key signs
//! the debit. The user opens the session with [`HyperPay::open_session`].

mod amounts;
mod client;
mod engine;
mod error;
mod policy;
mod program;

pub use amounts::{format_amount, from_base_units, to_base_units, TokenInfo};
pub use client::{load_keypair, Balance, HyperPay, Payment};
pub use error::{HyperPayError, Result};
pub use policy::Policy;
pub use program::{
    associated_token_address, charge_ix, close_session_ix, delegate_ephemeral_ata_ix,
    delegate_user_ix, deposit_ix, deposit_spl_ix, eata_pda, ensure_user_mint_ix,
    init_ephemeral_ata_ix, init_global_vault_ix, init_user_ix, open_session_ix, session_pda,
    user_mint_pda, user_pda, vault_pda, withdraw_ix, SessionAccounts, WithdrawAccounts,
    DELEGATION_PROGRAM_ID, LOCAL_ER_VALIDATOR, PROGRAM_ID, SESSION_REMAINING_OFFSET,
};
