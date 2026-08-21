//! # HyperPay
//!
//! The easiest way to pay on Solana — private by default, agent-ready.
//!
//! Payments settle inside a [MagicBlock](https://magicblock.xyz) ephemeral
//! rollup using ephemeral SPL (eSPL) tokens, so amounts and counterparties are
//! not broadcast on the base layer.
//!
//! ```no_run
//! use hyperpay::{HyperPay, PayOptions};
//!
//! # async fn demo() -> hyperpay::Result<()> {
//! let hp = HyperPay::from_env()?;
//! let payment = hp.pay("alice@magicblock.id", "10 USDC", PayOptions::default()).await?;
//! println!("paid: {}", payment.signature);
//! # Ok(()) }
//! ```
//!
//! ## Privacy
//!
//! Privacy here reduces **linkability**, not total observability: amounts and
//! timing may still be inferable at the network level. Private transfers carry
//! a 0.1% fee in the token itself.

mod amounts;
mod api;
mod client;
mod engine;
mod error;
mod policy;

pub use amounts::{format_amount, from_base_units, to_base_units, TokenInfo};
pub use api::Fees;
pub use client::{load_keypair, Balance, HyperPay, PayOptions, Payment, Visibility};
pub use error::{HyperPayError, Result};
pub use policy::Policy;
