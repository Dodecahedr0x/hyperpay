use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::amounts::{format_amount, parse_money, to_base_units, TokenInfo};
use crate::error::{HyperPayError, Result};

/// `YYYY-MM-DD` → symbol → base units spent that UTC day.
pub type Journal = HashMap<String, HashMap<String, String>>;

#[derive(Debug, Clone)]
enum Store {
    Memory(Arc<Mutex<Journal>>),
    File(PathBuf),
}

impl Default for Store {
    fn default() -> Self {
        Store::Memory(Arc::new(Mutex::new(Journal::new())))
    }
}

/// Client-side spend rules for agent wallets.
///
/// A blast-radius limiter, not a security boundary: any process holding the key
/// can sign without consulting this. The real containment is that a session key
/// only ever holds what you deposited into it.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    max_per_tx: Option<HashMap<String, String>>,
    daily_cap: Option<HashMap<String, String>>,
    allow: Vec<String>,
    deny: Vec<String>,
    store: Store,
    today: Option<String>,
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

    /// Rolling UTC-day ceiling, same format as [`Self::max_per_tx`].
    pub fn daily_cap(mut self, spec: &str) -> Result<Self> {
        self.daily_cap = Some(parse_caps(spec)?);
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

    /// Persist daily spend to this JSON file (shared across processes).
    pub fn with_journal_path(mut self, path: impl AsRef<Path>) -> Self {
        self.store = Store::File(path.as_ref().to_path_buf());
        self
    }

    /// In-process journal. Two policies do not share spend unless they clone.
    pub fn memory_journal(mut self) -> Self {
        self.store = Store::Memory(Arc::new(Mutex::new(Journal::new())));
        self
    }

    /// Override the UTC day used for the daily-cap journal (`YYYY-MM-DD`).
    pub fn with_today(mut self, day: &str) -> Self {
        self.today = Some(day.to_string());
        self
    }

    pub fn from_env() -> Result<Self> {
        let mut policy = Self::new();
        if let Ok(spec) = std::env::var("HYPERPAY_MAX_PER_TX") {
            policy = policy.max_per_tx(&spec)?;
        }
        if let Ok(spec) = std::env::var("HYPERPAY_DAILY_CAP") {
            policy = policy.daily_cap(&spec)?;
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
        match std::env::var("HYPERPAY_JOURNAL") {
            Ok(path) if path == ":memory:" => policy = policy.memory_journal(),
            Ok(path) => policy = policy.with_journal_path(path),
            Err(_) if policy.daily_cap.is_some() => {
                policy = policy.with_journal_path(default_journal_path());
            }
            Err(_) => {}
        }
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
            let limit = self.cap_for(caps, token, "per-transaction")?;
            if units > limit {
                return Err(HyperPayError::Policy(format!(
                    "payment of {} exceeds the per-transaction cap of {}",
                    format_amount(units, token),
                    format_amount(limit, token)
                )));
            }
        }

        if let Some(caps) = &self.daily_cap {
            let limit = self.cap_for(caps, token, "daily")?;
            let spent = self.spent_today(&token.symbol);
            if spent.saturating_add(units) > limit {
                return Err(HyperPayError::Policy(format!(
                    "payment of {} would exceed the daily cap of {} ({} already spent today)",
                    format_amount(units, token),
                    format_amount(limit, token),
                    format_amount(spent, token)
                )));
            }
        }
        Ok(())
    }

    /// Records settled spend against the daily cap. Call only after a payment lands.
    pub fn record(&self, token: &TokenInfo, units: u64) {
        if self.daily_cap.is_none() {
            return;
        }
        let mut journal = self.read_journal();
        let day = self.today();
        let bucket = journal.entry(day).or_default();
        let spent: u64 = bucket
            .get(&token.symbol)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        bucket.insert(
            token.symbol.clone(),
            (spent.saturating_add(units)).to_string(),
        );
        self.write_journal(prune(journal));
    }

    pub fn spent_today(&self, symbol: &str) -> u64 {
        self.read_journal()
            .get(&self.today())
            .and_then(|bucket| bucket.get(symbol))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }

    fn cap_for(
        &self,
        caps: &HashMap<String, String>,
        token: &TokenInfo,
        kind: &str,
    ) -> Result<u64> {
        let cap = caps.get(&token.symbol).ok_or_else(|| {
            HyperPayError::Policy(format!(
                "no {kind} cap configured for {} — refusing to pay in an uncapped token",
                token.symbol
            ))
        })?;
        to_base_units(cap, token.decimals)
    }

    fn today(&self) -> String {
        self.today.clone().unwrap_or_else(today_utc)
    }

    fn read_journal(&self) -> Journal {
        match &self.store {
            Store::Memory(data) => data.lock().map(|g| g.clone()).unwrap_or_default(),
            Store::File(path) => std::fs::read_to_string(path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
        }
    }

    fn write_journal(&self, journal: Journal) {
        match &self.store {
            Store::Memory(data) => {
                if let Ok(mut guard) = data.lock() {
                    *guard = journal;
                }
            }
            Store::File(path) => {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Ok(body) = serde_json::to_string_pretty(&journal) {
                    let _ = std::fs::write(path, body);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ =
                            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                    }
                }
            }
        }
    }
}

/// `~/.hyperpay/spend.json` — same default the Node SDK uses.
pub fn default_journal_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".hyperpay").join("spend.json")
}

fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_unix_day(secs)
}

fn format_unix_day(unix_secs: u64) -> String {
    let (y, m, d) = civil_from_unix_days((unix_secs / 86_400) as i32);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's civil-from-days, Unix epoch = day 0.
fn civil_from_unix_days(unix_days: i32) -> (i32, u32, u32) {
    let z = unix_days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i32 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn prune(journal: Journal) -> Journal {
    let mut days: Vec<_> = journal.keys().cloned().collect();
    days.sort();
    days.into_iter()
        .rev()
        .take(30)
        .filter_map(|day| journal.get(&day).cloned().map(|bucket| (day, bucket)))
        .collect()
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

    #[test]
    fn daily_cap_accumulates_recorded_spend() {
        let dir = std::env::temp_dir().join(format!("hyperpay-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("spend.json");

        let policy = Policy::new()
            .daily_cap("100 USDC")
            .unwrap()
            .with_journal_path(&path);
        policy
            .check("alice@magicblock.id", &usdc(), 60_000_000)
            .unwrap();
        policy.record(&usdc(), 60_000_000);
        assert!(policy
            .check("alice@magicblock.id", &usdc(), 30_000_000)
            .is_ok());
        let err = policy
            .check("alice@magicblock.id", &usdc(), 41_000_000)
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("daily"), "{err}");
    }

    #[test]
    fn daily_cap_persists_across_instances() {
        let dir =
            std::env::temp_dir().join(format!("hyperpay-journal-persist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("spend.json");

        Policy::new()
            .daily_cap("100 USDC")
            .unwrap()
            .with_journal_path(&path)
            .record(&usdc(), 90_000_000);
        let fresh = Policy::new()
            .daily_cap("100 USDC")
            .unwrap()
            .with_journal_path(&path);
        assert!(fresh
            .check("alice@magicblock.id", &usdc(), 20_000_000)
            .is_err());
    }

    #[test]
    fn daily_cap_scopes_spend_to_a_utc_day() {
        let dir = std::env::temp_dir().join(format!("hyperpay-journal-day-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("spend.json");

        Policy::new()
            .daily_cap("100 USDC")
            .unwrap()
            .with_journal_path(&path)
            .with_today("2026-08-11")
            .record(&usdc(), 90_000_000);
        let next_day = Policy::new()
            .daily_cap("100 USDC")
            .unwrap()
            .with_journal_path(&path)
            .with_today("2026-08-12");
        assert!(next_day
            .check("alice@magicblock.id", &usdc(), 90_000_000)
            .is_ok());
    }

    #[test]
    fn unix_epoch_is_1970_01_01() {
        assert_eq!(format_unix_day(0), "1970-01-01");
        assert_eq!(format_unix_day(86_400), "1970-01-02");
    }

    #[test]
    fn daily_cap_tracks_tokens_independently() {
        let policy = Policy::new()
            .daily_cap("100 USDC, 100 USDT")
            .unwrap()
            .memory_journal();
        policy.record(&usdc(), 95_000_000);
        assert!(policy
            .check("alice@magicblock.id", &usdt(), 50_000_000)
            .is_ok());
        assert!(policy
            .check("alice@magicblock.id", &usdc(), 50_000_000)
            .is_err());
    }
}
