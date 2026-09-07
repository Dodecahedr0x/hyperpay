use anchor_lang::prelude::*;

use crate::accounting::AccountingError;

#[error_code]
pub enum HyperpayError {
    #[msg("amount must be greater than zero")]
    AmountZero,
    #[msg("not enough unreserved eATA balance")]
    InsufficientAvailable,
    #[msg("session remaining is too small")]
    InsufficientRemaining,
    #[msg("a session already exists for this user, merchant, and mint")]
    SessionAlreadyOpen,
    #[msg("signer is not allowed")]
    Unauthorized,
    #[msg("user account is not delegated to an ephemeral rollup")]
    UserNotDelegated,
    #[msg("arithmetic overflow")]
    Overflow,
}

impl From<AccountingError> for HyperpayError {
    fn from(err: AccountingError) -> Self {
        match err {
            AccountingError::AmountZero => Self::AmountZero,
            AccountingError::InsufficientAvailable => Self::InsufficientAvailable,
            AccountingError::InsufficientRemaining => Self::InsufficientRemaining,
            AccountingError::Overflow => Self::Overflow,
        }
    }
}
