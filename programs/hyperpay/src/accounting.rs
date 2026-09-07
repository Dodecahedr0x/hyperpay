//! Reservation math. `available = eata_balance.saturating_sub(reserved)`.

pub fn available(eata_balance: u64, reserved: u64) -> u64 {
    eata_balance.saturating_sub(reserved)
}

pub fn reserve(eata_balance: u64, reserved: u64, amount: u64) -> Result<u64, AccountingError> {
    if amount == 0 {
        return Err(AccountingError::AmountZero);
    }
    let avail = available(eata_balance, reserved);
    if amount > avail {
        return Err(AccountingError::InsufficientAvailable);
    }
    reserved
        .checked_add(amount)
        .ok_or(AccountingError::Overflow)
}

pub fn debit_remaining(remaining: u64, amount: u64) -> Result<u64, AccountingError> {
    if amount == 0 {
        return Err(AccountingError::AmountZero);
    }
    remaining
        .checked_sub(amount)
        .ok_or(AccountingError::InsufficientRemaining)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountingError {
    AmountZero,
    InsufficientAvailable,
    InsufficientRemaining,
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_rejects_zero() {
        assert_eq!(reserve(100, 0, 0), Err(AccountingError::AmountZero));
    }

    #[test]
    fn reserve_rejects_above_available() {
        assert_eq!(
            reserve(100, 40, 61),
            Err(AccountingError::InsufficientAvailable)
        );
    }

    #[test]
    fn reserve_increases_reserved() {
        assert_eq!(reserve(100, 40, 60), Ok(100));
    }

    #[test]
    fn two_merchants_cannot_over_allocate() {
        let reserved = reserve(100, 0, 70).unwrap();
        assert_eq!(
            reserve(100, reserved, 40),
            Err(AccountingError::InsufficientAvailable)
        );
        assert_eq!(reserve(100, reserved, 30), Ok(100));
    }

    #[test]
    fn debit_rejects_over_remaining() {
        assert_eq!(
            debit_remaining(50, 51),
            Err(AccountingError::InsufficientRemaining)
        );
    }

    #[test]
    fn debit_decrements() {
        assert_eq!(debit_remaining(50, 20), Ok(30));
    }

    #[test]
    fn available_saturates_when_reserved_exceeds_balance() {
        assert_eq!(available(100, 150), 0);
    }

    #[test]
    fn debit_rejects_zero() {
        assert_eq!(debit_remaining(50, 0), Err(AccountingError::AmountZero));
    }
}
