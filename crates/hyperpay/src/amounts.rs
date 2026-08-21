use crate::error::{HyperPayError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenInfo {
    pub mint: String,
    pub symbol: String,
    pub decimals: u8,
}

impl TokenInfo {
    pub fn new(symbol: &str, mint: &str, decimals: u8) -> Self {
        Self {
            mint: mint.to_string(),
            symbol: symbol.to_string(),
            decimals,
        }
    }
}

/// Tokens resolvable from a symbol alone. Anything else needs a mint address.
pub fn known_tokens(cluster: &str) -> Vec<TokenInfo> {
    if cluster.contains("devnet") {
        vec![
            TokenInfo::new("USDC", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", 6),
            TokenInfo::new("SOL", "So11111111111111111111111111111111111111112", 9),
        ]
    } else {
        vec![
            TokenInfo::new("USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6),
            TokenInfo::new("USDT", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6),
            TokenInfo::new("SOL", "So11111111111111111111111111111111111111112", 9),
        ]
    }
}

pub fn lookup_known_token(symbol: &str, cluster: &str) -> Option<TokenInfo> {
    let want = symbol.trim().to_uppercase();
    known_tokens(cluster).into_iter().find(|t| t.symbol == want)
}

/// Decimal string to base units, using exact integer math.
///
/// Never goes through `f64`: rounding error is unacceptable when the result is
/// how much money moves.
pub fn to_base_units(value: &str, decimals: u8) -> Result<u64> {
    let raw = value.trim().replace(',', "");
    if raw.is_empty() {
        return Err(HyperPayError::Resolution(format!(
            "\"{value}\" is not a valid amount"
        )));
    }

    let (whole, frac) = match raw.split_once('.') {
        Some((w, f)) => (w, f),
        None => (raw.as_str(), ""),
    };

    let valid = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !valid(whole) || (!frac.is_empty() && !valid(frac)) || raw.matches('.').count() > 1 {
        return Err(HyperPayError::Resolution(format!(
            "\"{value}\" is not a valid amount"
        )));
    }
    if frac.len() > decimals as usize {
        return Err(HyperPayError::Resolution(format!(
            "\"{value}\" has {} decimal places but this mint supports {decimals} — precision would be silently lost",
            frac.len()
        )));
    }

    let mut digits = String::with_capacity(whole.len() + decimals as usize);
    digits.push_str(whole);
    digits.push_str(frac);
    for _ in 0..(decimals as usize - frac.len()) {
        digits.push('0');
    }

    digits
        .parse::<u64>()
        .map_err(|_| HyperPayError::Resolution(format!("\"{value}\" is too large to represent")))
}

/// Base units to decimal string, trailing zeros trimmed.
pub fn from_base_units(units: u64, decimals: u8) -> String {
    if decimals == 0 {
        return units.to_string();
    }
    let padded = format!("{:0>width$}", units, width = decimals as usize + 1);
    let split = padded.len() - decimals as usize;
    let whole = &padded[..split];
    let frac = padded[split..].trim_end_matches('0');
    if frac.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{frac}")
    }
}

/// Splits `"10 USDC"` into its value and optional symbol.
pub fn parse_money(input: &str) -> Result<(String, Option<String>)> {
    let trimmed = input.trim();
    let split = trimmed
        .find(|c: char| c.is_ascii_alphabetic())
        .unwrap_or(trimmed.len());
    let (value, symbol) = trimmed.split_at(split);
    let value = value.trim();

    if value.is_empty() {
        return Err(HyperPayError::Resolution(format!(
            "\"{input}\" is not a valid amount — expected e.g. \"10 USDC\""
        )));
    }
    let symbol = symbol.trim();
    Ok((
        value.to_string(),
        (!symbol.is_empty()).then(|| symbol.to_uppercase()),
    ))
}

pub fn format_amount(units: u64, token: &TokenInfo) -> String {
    format!(
        "{} {}",
        from_base_units(units, token.decimals),
        token.symbol
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_without_float_error() {
        assert_eq!(to_base_units("10", 6).unwrap(), 10_000_000);
        assert_eq!(to_base_units("0.1", 6).unwrap(), 100_000);
        assert_eq!(to_base_units("1.5", 6).unwrap(), 1_500_000);
        assert_eq!(to_base_units("0.000001", 6).unwrap(), 1);
        assert_eq!(to_base_units("0.3", 9).unwrap(), 300_000_000);
        assert_eq!(to_base_units(" 1,000.5 ", 6).unwrap(), 1_000_500_000);
    }

    #[test]
    fn rejects_excess_precision_and_garbage() {
        assert!(to_base_units("0.0000001", 6).is_err());
        assert!(to_base_units("-1", 6).is_err());
        assert!(to_base_units("", 6).is_err());
        assert!(to_base_units("abc", 6).is_err());
        assert!(to_base_units("1.2.3", 6).is_err());
    }

    #[test]
    fn round_trips() {
        assert_eq!(from_base_units(10_000_000, 6), "10");
        assert_eq!(from_base_units(1_500_000, 6), "1.5");
        assert_eq!(from_base_units(1, 6), "0.000001");
        assert_eq!(from_base_units(0, 6), "0");
        assert_eq!(from_base_units(123, 9), "0.000000123");
    }

    #[test]
    fn splits_money_strings() {
        assert_eq!(
            parse_money("10 USDC").unwrap(),
            ("10".into(), Some("USDC".into()))
        );
        assert_eq!(
            parse_money("10USDC").unwrap(),
            ("10".into(), Some("USDC".into()))
        );
        assert_eq!(
            parse_money("0.25 usdc").unwrap(),
            ("0.25".into(), Some("USDC".into()))
        );
        assert_eq!(parse_money("10").unwrap(), ("10".into(), None));
        assert!(parse_money("USDC").is_err());
    }

    #[test]
    fn resolves_cluster_specific_mints() {
        assert_eq!(
            lookup_known_token("usdc", "mainnet").unwrap().mint,
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        );
        assert_eq!(
            lookup_known_token("USDC", "devnet").unwrap().mint,
            "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        );
        assert!(lookup_known_token("NOPE", "mainnet").is_none());
    }
}
