use std::collections::HashMap;

use crate::amounts::{format_amount, parse_money, to_base_units, TokenInfo};
use crate::error::{HyperPayError, Result};

/// Client-side spend rules for agent wallets.
///
/// A blast-radius limiter, not a security boundary: any process holding the key
/// can sign without consulting this. The real containment is that a session key
/// only ever holds what you deposited into it.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    max_per_tx: Option<HashMap<String, String>>,
    allow: Vec<String>,
    deny: Vec<String>,
}

impl Policy {
    pub fn new() -> Self {
        Self::default()
    }

    /// `"25 USDC"` or `"25 USDC, 10 USDT"`.
    pub fn max_per_tx(mut self, spec: &str) -> Result<Self> {
        self.max_per_tx = Some(parse_caps(spec)?);
        Ok(self)
    }

    pub fn allow(mut self, patterns: &[&str]) -> Self {
        self.allow = patterns.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn deny(mut self, patterns: &[&str]) -> Self {
        self.deny = patterns.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn from_env() -> Result<Self> {
        let mut policy = Self::new();
        if let Ok(spec) = std::env::var("HYPERPAY_MAX_PER_TX") {
            policy = policy.max_per_tx(&spec)?;
        }
        let list = |key: &str| {
            std::env::var(key)
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        };
        policy.allow = list("HYPERPAY_ALLOW");
        policy.deny = list("HYPERPAY_DENY");
        Ok(policy)
    }

    /// Returns an error if this payment breaks a rule. Call before signing.
    pub fn check(&self, to: &str, token: &TokenInfo, units: u64) -> Result<()> {
        if let Some(pattern) = self.deny.iter().find(|p| matches_pattern(to, p)) {
            return Err(HyperPayError::Policy(format!(
                "recipient \"{to}\" is on the deny list (matched \"{pattern}\")"
            )));
        }

        if !self.allow.is_empty() && !self.allow.iter().any(|p| matches_pattern(to, p)) {
            return Err(HyperPayError::Policy(format!(
                "recipient \"{to}\" is not on the allow list ({})",
                self.allow.join(", ")
            )));
        }

        if let Some(caps) = &self.max_per_tx {
            // Fails closed: an agent that could dodge a USDC cap by paying in
            // another mint would make the cap decorative.
            let cap = caps.get(&token.symbol).ok_or_else(|| {
                HyperPayError::Policy(format!(
                    "no per-transaction cap configured for {} — refusing to pay in an uncapped token",
                    token.symbol
                ))
            })?;
            let limit = to_base_units(cap, token.decimals)?;
            if units > limit {
                return Err(HyperPayError::Policy(format!(
                    "payment of {} exceeds the per-transaction cap of {}",
                    format_amount(units, token),
                    format_amount(limit, token)
                )));
            }
        }
        Ok(())
    }
}

fn parse_caps(spec: &str) -> Result<HashMap<String, String>> {
    let mut caps = HashMap::new();
    for part in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (value, symbol) = parse_money(part)?;
        let symbol = symbol.ok_or_else(|| {
            HyperPayError::Policy(format!(
                "spend cap \"{part}\" must name a token, e.g. \"25 USDC\""
            ))
        })?;
        caps.insert(symbol, value);
    }
    Ok(caps)
}

/// Base58 is case-significant, so a pattern that looks like a pubkey is matched
/// exactly. Everything else is a case-insensitive `*` glob.
pub fn matches_pattern(value: &str, pattern: &str) -> bool {
    let looks_like_pubkey = !pattern.contains('*')
        && (32..=44).contains(&pattern.len())
        && pattern
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() && !b"0OIl".contains(&b));

    if looks_like_pubkey {
        return value == pattern;
    }

    let value = value.to_lowercase();
    let pattern = pattern.to_lowercase();
    let mut rest = value.as_str();

    for (i, segment) in pattern.split('*').enumerate() {
        let last = i == pattern.split('*').count() - 1;
        if segment.is_empty() {
            if last {
                return true;
            }
            continue;
        }
        match (i, rest.find(segment)) {
            (0, Some(0)) => rest = &rest[segment.len()..],
            (0, _) => return false,
            (_, Some(at)) => rest = &rest[at + segment.len()..],
            (_, None) => return false,
        }
        if last && !rest.is_empty() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usdc() -> TokenInfo {
        TokenInfo::new("USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6)
    }
    fn usdt() -> TokenInfo {
        TokenInfo::new("USDT", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6)
    }

    #[test]
    fn matches_handles_and_globs() {
        assert!(matches_pattern(
            "alice@magicblock.id",
            "alice@magicblock.id"
        ));
        assert!(!matches_pattern("bob@magicblock.id", "alice@magicblock.id"));
        assert!(matches_pattern("bob.vendor.id", "*.vendor.id"));
        assert!(!matches_pattern("bob@evil.id", "*.vendor.id"));
        assert!(matches_pattern("anything", "*"));
        assert!(matches_pattern(
            "ALICE@magicblock.id",
            "alice@magicblock.id"
        ));
    }

    #[test]
    fn pubkey_patterns_are_case_sensitive() {
        let pk = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        assert!(matches_pattern(pk, pk));
        assert!(!matches_pattern(&pk.to_lowercase(), pk));
    }

    #[test]
    fn enforces_per_tx_cap() {
        let policy = Policy::new().max_per_tx("25 USDC").unwrap();
        assert!(policy
            .check("alice@magicblock.id", &usdc(), 25_000_000)
            .is_ok());
        assert!(policy
            .check("alice@magicblock.id", &usdc(), 25_000_001)
            .is_err());
    }

    #[test]
    fn fails_closed_for_uncapped_tokens() {
        let policy = Policy::new().max_per_tx("25 USDC").unwrap();
        assert!(policy.check("alice@magicblock.id", &usdt(), 1).is_err());
    }

    #[test]
    fn enforces_allow_and_deny() {
        let policy = Policy::new().allow(&["alice@magicblock.id", "*.vendor.id"]);
        assert!(policy.check("acme.vendor.id", &usdc(), 1).is_ok());
        assert!(policy.check("mallory@evil.id", &usdc(), 1).is_err());

        let policy = Policy::new().allow(&["*"]).deny(&["mallory@evil.id"]);
        assert!(policy.check("anyone@x.id", &usdc(), 1).is_ok());
        assert!(policy.check("mallory@evil.id", &usdc(), 1).is_err());
    }
}
