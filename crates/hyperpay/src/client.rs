use solana_sdk::{
    instruction::Instruction,
    message::Message,
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::{Transaction, VersionedTransaction},
};
use std::str::FromStr;

use crate::amounts::{
    format_amount, from_base_units, lookup_known_token, parse_money, to_base_units, TokenInfo,
};
use crate::engine::{
    base_rpc_for, ephemeral_rpc_for, get_account_data, get_latest_blockhash,
    get_token_account_balance, sign_and_submit,
};
use crate::error::{HyperPayError, Result};
use crate::policy::Policy;
use crate::program::{
    associated_token_address, charge_ix, close_session_ix, delegate_ephemeral_ata_ix,
    delegate_user_ix, delegation_record_pda, deposit_ix, deposit_spl_ix, eata_pda,
    ensure_user_mint_ix, init_ephemeral_ata_ix, init_global_vault_ix, init_user_ix,
    open_session_ix, remaining_from_session_data, session_pda, user_mint_pda, user_pda,
    withdraw_ix, SessionAccounts, WithdrawAccounts, LOCAL_ER_VALIDATOR, TOKEN_PROGRAM_ID,
};

#[derive(Debug, Clone)]
pub struct Payment {
    pub signature: String,
    pub to: String,
    pub amount: String,
    pub units: u64,
    pub token: TokenInfo,
    pub settled_on: String,
    pub rpc_url: String,
    /// Absent for ephemeral settlement.
    pub explorer_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Balance {
    pub address: String,
    pub token: TokenInfo,
    pub base: String,
    pub base_units: u64,
}

/// Options for session-key signers and token overrides.
///
/// Pass `authority` when the signer is a session key — the User PDA is derived
/// from the wallet that owns it, not from the session key.
#[derive(Debug, Clone, Copy, Default)]
pub struct SessionOpts<'a> {
    pub token: Option<&'a str>,
    pub session_token: Option<&'a str>,
    pub authority: Option<&'a str>,
    pub destination: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct Quote {
    pub to: String,
    pub amount: String,
    pub units: u64,
    pub token: TokenInfo,
    pub settles_on: String,
}

/// The whole payment system, in one struct.
///
/// ```no_run
/// # use hyperpay::{HyperPay, SessionOpts};
/// # async fn demo() -> hyperpay::Result<()> {
/// let user = HyperPay::from_env()?;
/// user.init_user(1_000_000).await?;
/// user.delegate_user(None).await?;
/// user.top_up("10 USDC", SessionOpts::default()).await?;
/// user.open_session("Merchant1111111111111111111111111111111", "10 USDC", SessionOpts::default()).await?;
/// let merchant = HyperPay::from_env()?;
/// let payment = merchant.charge("User11111111111111111111111111111111", "1 USDC").await?;
/// println!("{}", payment.signature);
/// # Ok(()) }
/// ```
pub struct HyperPay {
    pub cluster: String,
    pub policy: Policy,
    keypair: Option<Keypair>,
    rpc_url: String,
    ephemeral_rpc: String,
    http: reqwest::Client,
    custom_tokens: Vec<TokenInfo>,
    default_token: String,
}

impl HyperPay {
    pub fn new(keypair: Keypair, cluster: &str) -> Self {
        Self {
            cluster: cluster.to_string(),
            policy: Policy::new(),
            keypair: Some(keypair),
            rpc_url: base_rpc_for(cluster, None),
            ephemeral_rpc: ephemeral_rpc_for(cluster, None),
            http: reqwest::Client::new(),
            custom_tokens: Vec::new(),
            default_token: "USDC".to_string(),
        }
    }

    /// Reads `HYPERPAY_KEY` (base58, a JSON byte array, or a path to a keypair
    /// file), `HYPERPAY_CLUSTER`, `HYPERPAY_RPC`, `HYPERPAY_EPHEMERAL_RPC`,
    /// `HYPERPAY_TOKEN`, `HYPERPAY_TOKENS`, and the policy variables.
    pub fn from_env() -> Result<Self> {
        let cluster = std::env::var("HYPERPAY_CLUSTER").unwrap_or_else(|_| "mainnet".into());
        let keypair = std::env::var("HYPERPAY_KEY")
            .ok()
            .map(|source| load_keypair(&source))
            .transpose()?;

        Ok(Self {
            rpc_url: base_rpc_for(&cluster, std::env::var("HYPERPAY_RPC").ok().as_deref()),
            ephemeral_rpc: ephemeral_rpc_for(
                &cluster,
                std::env::var("HYPERPAY_EPHEMERAL_RPC").ok().as_deref(),
            ),
            policy: Policy::from_env()?,
            default_token: std::env::var("HYPERPAY_TOKEN").unwrap_or_else(|_| "USDC".into()),
            custom_tokens: parse_tokens_env(&std::env::var("HYPERPAY_TOKENS").unwrap_or_default())?,
            http: reqwest::Client::new(),
            keypair,
            cluster,
        })
    }

    pub fn with_policy(mut self, policy: Policy) -> Self {
        self.policy = policy;
        self
    }

    /// Names custom mints so amounts and spend caps can refer to them by symbol.
    pub fn with_tokens(mut self, tokens: Vec<TokenInfo>) -> Self {
        self.custom_tokens = tokens;
        self
    }

    pub fn with_default_token(mut self, symbol: &str) -> Self {
        self.default_token = symbol.to_string();
        self
    }

    pub fn with_rpc(mut self, url: &str) -> Self {
        self.rpc_url = url.to_string();
        self
    }

    pub fn with_ephemeral_rpc(mut self, url: &str) -> Self {
        self.ephemeral_rpc = url.to_string();
        self
    }

    pub fn address(&self) -> Result<String> {
        Ok(self.signer()?.pubkey().to_string())
    }

    /// Creates the User PDA on the base cluster and funds it with lamports.
    pub async fn init_user(&self, lamports: u64) -> Result<Payment> {
        let authority = self.signer()?.pubkey();
        let (user, _) = user_pda(&authority);
        let ix = init_user_ix(user, authority, lamports);
        self.submit_base(ix, authority.to_string(), lamports, "lamports")
            .await
    }

    /// Delegates the User PDA to the ephemeral rollup (MagicBlock CPI on base).
    pub async fn delegate_user(&self, validator: Option<&str>) -> Result<Payment> {
        let authority = self.signer()?.pubkey();
        let (user, _) = user_pda(&authority);
        let validator = match validator {
            Some(s) => Some(parse_pubkey(s)?),
            None => Some(LOCAL_ER_VALIDATOR),
        };
        let ix = delegate_user_ix(user, authority, validator);
        self.submit_base(ix, user.to_string(), 0, "delegate").await
    }

    /// Deposits tokens from the signer's Tokenkeg ATA into the User eATA (base),
    /// then creates the ephemeral UserMint if it is missing. `reserved` stays 0
    /// until `open_session` / `deposit`. Requires `init_user` + `delegate_user`.
    pub async fn top_up(&self, amount: &str, opts: SessionOpts<'_>) -> Result<Payment> {
        let (token, units) = self.resolve_units(amount, opts.token, false)?;
        let authority = self.wallet_authority(&opts)?;
        self.policy.check(&authority.to_string(), &token, units)?;
        let signer = self.signer()?.pubkey();
        let mint = parse_pubkey(&token.mint)?;
        let (user, _) = user_pda(&authority);
        let (user_mint, _) = user_mint_pda(&user, &mint);
        let (eata, _) = eata_pda(&user, &mint);
        let inits = [
            init_global_vault_ix(signer, mint),
            init_ephemeral_ata_ix(signer, user, mint),
        ];
        self.submit(
            &inits,
            &self.rpc_url,
            "base",
            Receipt {
                to: authority.to_string(),
                units: 0,
                token: token.clone(),
                amount: format_amount(0, &token),
            },
            true,
        )
        .await?;
        let amount_label = format_amount(units, &token);
        let deposit = deposit_spl_ix(signer, user, mint, units);
        let payment = self
            .submit(
                std::slice::from_ref(&deposit),
                &self.rpc_url,
                "base",
                Receipt {
                    to: authority.to_string(),
                    units,
                    token: token.clone(),
                    amount: amount_label,
                },
                true,
            )
            .await?;
        if get_account_data(&self.http, &self.rpc_url, &delegation_record_pda(&eata))
            .await?
            .is_none()
        {
            let delegate = delegate_ephemeral_ata_ix(signer, user, mint, None);
            self.submit(
                std::slice::from_ref(&delegate),
                &self.rpc_url,
                "base",
                Receipt {
                    to: authority.to_string(),
                    units: 0,
                    token: token.clone(),
                    amount: format_amount(0, &token),
                },
                true,
            )
            .await?;
        }
        let ensure = ensure_user_mint_ix(
            user,
            signer,
            user_mint,
            mint,
            parse_optional_pubkey(opts.session_token)?,
        );
        self.submit_ephemeral(ensure, authority.to_string(), 0, token)
            .await?;
        Ok(payment)
    }

    /// Opens a session with `merchant`. Amount may be `"0"` / `"0 USDC"`.
    pub async fn open_session(
        &self,
        merchant: &str,
        amount: &str,
        opts: SessionOpts<'_>,
    ) -> Result<Payment> {
        let (token, units) = self.resolve_units(amount, opts.token, true)?;
        let merchant_pk = parse_pubkey(merchant)?;
        if units > 0 {
            self.policy.check(merchant, &token, units)?;
        }
        let accounts = self.session_accounts(self.wallet_authority(&opts)?, merchant_pk, &token)?;
        let ix = open_session_ix(&accounts, units, parse_optional_pubkey(opts.session_token)?);
        self.submit_ephemeral(ix, merchant.to_string(), units, token)
            .await
    }

    /// Reserves more of the user eATA into an existing session.
    pub async fn deposit(
        &self,
        merchant: &str,
        amount: &str,
        opts: SessionOpts<'_>,
    ) -> Result<Payment> {
        let (token, units) = self.resolve_units(amount, opts.token, false)?;
        self.policy.check(merchant, &token, units)?;
        let merchant_pk = parse_pubkey(merchant)?;
        let accounts = self.session_accounts(self.wallet_authority(&opts)?, merchant_pk, &token)?;
        let ix = deposit_ix(&accounts, units, parse_optional_pubkey(opts.session_token)?);
        self.submit_ephemeral(ix, merchant.to_string(), units, token)
            .await
    }

    /// Debit the user's ER session. Signs with the merchant key.
    ///
    /// The merchant must omit the session token — do not give a user's session
    /// key to a merchant.
    pub async fn charge(&self, user: &str, amount: &str) -> Result<Payment> {
        let (token, units) = self.resolve_units(amount, None, false)?;
        let merchant = self.signer()?.pubkey();
        self.policy.check(&merchant.to_string(), &token, units)?;
        let user_wallet = parse_pubkey(user)?;
        let accounts = self.session_accounts(user_wallet, merchant, &token)?;
        let merchant_eata = associated_token_address(&merchant, &accounts.mint, &TOKEN_PROGRAM_ID);
        let ix = charge_ix(&accounts, merchant_eata, units, None);
        self.submit_ephemeral(ix, merchant.to_string(), units, token)
            .await
    }

    /// Unreserves remaining and closes the session. User-only.
    pub async fn close_session(&self, merchant: &str, opts: SessionOpts<'_>) -> Result<Payment> {
        let token = self.resolve_token(opts.token.unwrap_or(&self.default_token))?;
        let merchant_pk = parse_pubkey(merchant)?;
        let accounts = self.session_accounts(self.wallet_authority(&opts)?, merchant_pk, &token)?;
        let ix = close_session_ix(&accounts, parse_optional_pubkey(opts.session_token)?);
        self.submit_ephemeral(ix, merchant.to_string(), 0, token)
            .await
    }

    /// Moves unreserved eATA tokens to `destination`'s eATA (defaults to the signer).
    pub async fn withdraw(&self, amount: &str, opts: SessionOpts<'_>) -> Result<Payment> {
        let (token, units) = self.resolve_units(amount, opts.token, false)?;
        let signer = self.signer()?.pubkey();
        let dest_owner = match opts.destination {
            Some(s) => parse_pubkey(s)?,
            None => signer,
        };
        self.policy.check(&dest_owner.to_string(), &token, units)?;
        let mint = parse_pubkey(&token.mint)?;
        let (user, _) = user_pda(&self.wallet_authority(&opts)?);
        let (user_mint, _) = user_mint_pda(&user, &mint);
        let user_eata = associated_token_address(&user, &mint, &TOKEN_PROGRAM_ID);
        let dest_eata = associated_token_address(&dest_owner, &mint, &TOKEN_PROGRAM_ID);
        let ix = withdraw_ix(
            &WithdrawAccounts {
                user,
                signer,
                user_mint,
                mint,
                user_eata,
                destination: dest_eata,
            },
            units,
            parse_optional_pubkey(opts.session_token)?,
        );
        self.submit_ephemeral(ix, dest_owner.to_string(), units, token)
            .await
    }

    /// Remaining units on the ER session between `user` (wallet) and this merchant.
    pub async fn session_balance(&self, user: &str) -> Result<Balance> {
        let token = self.resolve_token(&self.default_token)?;
        let merchant = self.signer()?.pubkey();
        let user_wallet = parse_pubkey(user)?;
        let mint = parse_pubkey(&token.mint)?;
        let (user_pda, _) = user_pda(&user_wallet);
        let (session, _) = session_pda(&user_pda, &merchant, &mint);
        let data = get_account_data(&self.http, &self.ephemeral_rpc, &session).await?;
        let units = data
            .as_deref()
            .and_then(remaining_from_session_data)
            .unwrap_or(0);
        Ok(Balance {
            base: from_base_units(units, token.decimals),
            base_units: units,
            address: user.to_string(),
            token,
        })
    }

    /// Policy-check and resolve an amount without submitting.
    pub fn quote(&self, merchant: &str, amount: &str, token: Option<&str>) -> Result<Quote> {
        let (token, units) = self.resolve_units(amount, token, false)?;
        self.policy.check(merchant, &token, units)?;
        Ok(Quote {
            amount: format_amount(units, &token),
            to: merchant.to_string(),
            units,
            token,
            settles_on: "ephemeral".into(),
        })
    }

    /// Base-layer ATA balance for `address` (defaults to the signer).
    pub async fn balance(&self, token: Option<&str>, address: Option<&str>) -> Result<Balance> {
        let owner = match address {
            Some(s) => parse_pubkey(s)?,
            None => self.signer()?.pubkey(),
        };
        let token = self.resolve_token(token.unwrap_or(&self.default_token))?;
        let mint = parse_pubkey(&token.mint)?;
        let ata = associated_token_address(&owner, &mint, &TOKEN_PROGRAM_ID);
        let units = get_token_account_balance(&self.http, &self.rpc_url, &ata).await?;
        Ok(Balance {
            address: owner.to_string(),
            base: from_base_units(units, token.decimals),
            base_units: units,
            token,
        })
    }

    pub fn explorer_url(&self, signature: &str) -> String {
        let suffix = if self.cluster.contains("devnet") {
            "?cluster=devnet"
        } else {
            ""
        };
        format!("https://explorer.solana.com/tx/{signature}{suffix}")
    }

    /// Resolves `"10 USDC"` (or `"10"` plus `token`) into a token and base units.
    pub fn resolve_amount(&self, amount: &str, token: Option<&str>) -> Result<(TokenInfo, u64)> {
        self.resolve_units(amount, token, false)
    }

    fn resolve_units(
        &self,
        amount: &str,
        token: Option<&str>,
        allow_zero: bool,
    ) -> Result<(TokenInfo, u64)> {
        let (value, symbol) = parse_money(amount)?;
        let spec = token
            .map(str::to_string)
            .or(symbol)
            .unwrap_or_else(|| self.default_token.clone());
        let token = self.resolve_token(&spec)?;
        let units = to_base_units(&value, token.decimals)?;
        if units == 0 && !allow_zero {
            return Err(HyperPayError::Resolution(
                "payment amount must be greater than zero".into(),
            ));
        }
        Ok((token, units))
    }

    fn resolve_token(&self, spec: &str) -> Result<TokenInfo> {
        if let Some(found) = self
            .custom_tokens
            .iter()
            .find(|t| t.symbol.eq_ignore_ascii_case(spec) || t.mint == spec)
        {
            return Ok(found.clone());
        }
        if let Some(known) = lookup_known_token(spec, &self.cluster) {
            return Ok(known);
        }
        Err(HyperPayError::Resolution(format!(
            "token \"{spec}\" — use a known symbol (USDC, USDT, SOL), or register the mint with with_tokens()"
        )))
    }

    /// User PDA accounts for a wallet authority — never derived from a session-key signer.
    pub fn session_accounts(
        &self,
        wallet: Pubkey,
        merchant: Pubkey,
        token: &TokenInfo,
    ) -> Result<SessionAccounts> {
        let mint = parse_pubkey(&token.mint)?;
        let (user, _) = user_pda(&wallet);
        let (user_mint, _) = user_mint_pda(&user, &mint);
        let (session, _) = session_pda(&user, &merchant, &mint);
        let user_eata = associated_token_address(&user, &mint, &TOKEN_PROGRAM_ID);
        Ok(SessionAccounts {
            signer: self.signer()?.pubkey(),
            user,
            user_mint,
            session,
            merchant,
            mint,
            user_eata,
        })
    }

    async fn submit_base(
        &self,
        ix: Instruction,
        to: String,
        units: u64,
        amount_label: &str,
    ) -> Result<Payment> {
        self.submit(
            std::slice::from_ref(&ix),
            &self.rpc_url,
            "base",
            Receipt {
                to,
                units,
                token: TokenInfo::new("SOL", "So11111111111111111111111111111111111111112", 9),
                amount: amount_label.to_string(),
            },
            false,
        )
        .await
    }

    async fn submit_ephemeral(
        &self,
        ix: Instruction,
        to: String,
        units: u64,
        token: TokenInfo,
    ) -> Result<Payment> {
        let amount = format_amount(units, &token);
        self.submit(
            std::slice::from_ref(&ix),
            &self.ephemeral_rpc,
            "ephemeral",
            Receipt {
                to,
                units,
                token,
                amount,
            },
            true,
        )
        .await
    }

    async fn submit(
        &self,
        ixs: &[Instruction],
        rpc_url: &str,
        settled_on: &str,
        receipt: Receipt,
        skip_preflight: bool,
    ) -> Result<Payment> {
        let payer = self.signer()?.pubkey();
        let blockhash = get_latest_blockhash(&self.http, rpc_url).await?;
        let message = Message::new_with_blockhash(ixs, Some(&payer), &blockhash);
        let tx = VersionedTransaction::from(Transaction::new_unsigned(message));
        let result =
            sign_and_submit(tx, self.signer()?, rpc_url, settled_on, skip_preflight).await?;
        if receipt.units > 0 {
            self.policy.record(&receipt.token, receipt.units);
        }
        Ok(Payment {
            explorer_url: (result.settled_on == "base")
                .then(|| self.explorer_url(&result.signature)),
            signature: result.signature,
            to: receipt.to,
            amount: receipt.amount,
            units: receipt.units,
            token: receipt.token,
            settled_on: result.settled_on,
            rpc_url: result.rpc_url,
        })
    }

    fn signer(&self) -> Result<&Keypair> {
        self.keypair.as_ref().ok_or(HyperPayError::NoSigner)
    }

    fn wallet_authority(&self, opts: &SessionOpts<'_>) -> Result<Pubkey> {
        match opts.authority {
            Some(value) => parse_pubkey(value),
            None => Ok(self.signer()?.pubkey()),
        }
    }
}

struct Receipt {
    to: String,
    units: u64,
    token: TokenInfo,
    amount: String,
}

/// Loads a keypair from a base58 secret key, a JSON byte array, or a path to a
/// Solana CLI keypair file.
pub fn load_keypair(source: &str) -> Result<Keypair> {
    let value = source.trim();
    if value.starts_with('[') {
        return keypair_from_json(value, "JSON array");
    }
    if value.contains('/') || value.ends_with(".json") {
        let contents = std::fs::read_to_string(value).map_err(|e| {
            HyperPayError::Resolution(format!("could not read keypair file \"{value}\": {e}"))
        })?;
        return keypair_from_json(&contents, &format!("file {value}"));
    }
    let bytes = solana_sdk::bs58::decode(value).into_vec().map_err(|_| {
        HyperPayError::Resolution(
            "could not parse HYPERPAY_KEY — expected a base58 secret key, a JSON byte array, or a path to a keypair file"
                .into(),
        )
    })?;
    Keypair::try_from(bytes.as_slice())
        .map_err(|e| HyperPayError::Resolution(format!("invalid keypair bytes: {e}")))
}

fn keypair_from_json(contents: &str, origin: &str) -> Result<Keypair> {
    let bytes: Vec<u8> = serde_json::from_str(contents).map_err(|e| {
        HyperPayError::Resolution(format!(
            "keypair from {origin} is not a JSON byte array: {e}"
        ))
    })?;
    Keypair::try_from(bytes.as_slice())
        .map_err(|e| HyperPayError::Resolution(format!("invalid keypair bytes from {origin}: {e}")))
}

/// Parses `HYPERPAY_TOKENS="TEST:<mint>:6,FOO:<mint>:9"`.
pub fn parse_tokens_env(spec: &str) -> Result<Vec<TokenInfo>> {
    if spec.trim().is_empty() {
        return Ok(Vec::new());
    }
    spec.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|entry| {
            let mut parts = entry.split(':');
            match (parts.next(), parts.next(), parts.next(), parts.next()) {
                (Some(symbol), Some(mint), Some(decimals), None) => {
                    let decimals = decimals.parse().map_err(|_| {
                        HyperPayError::Resolution(format!(
                            "bad HYPERPAY_TOKENS entry \"{entry}\" — expected SYMBOL:MINT:DECIMALS"
                        ))
                    })?;
                    Ok(TokenInfo::new(&symbol.to_uppercase(), mint, decimals))
                }
                _ => Err(HyperPayError::Resolution(format!(
                    "bad HYPERPAY_TOKENS entry \"{entry}\" — expected SYMBOL:MINT:DECIMALS"
                ))),
            }
        })
        .collect()
}

fn parse_pubkey(value: &str) -> Result<Pubkey> {
    Pubkey::from_str(value)
        .map_err(|_| HyperPayError::Resolution(format!("\"{value}\" is not a valid pubkey")))
}

fn parse_optional_pubkey(value: Option<&str>) -> Result<Option<Pubkey>> {
    value.map(parse_pubkey).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::program::SESSION_REMAINING_OFFSET;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn session_balance_reads_remaining_from_session_pda() {
        let keypair = Keypair::new();
        let user = Keypair::new().pubkey();
        let mint = Pubkey::from_str("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU").unwrap();
        let (user_account, _) = user_pda(&user);
        let (session, _) = session_pda(&user_account, &keypair.pubkey(), &mint);

        let mut data = vec![0u8; 113];
        data[SESSION_REMAINING_OFFSET..SESSION_REMAINING_OFFSET + 8]
            .copy_from_slice(&42_000u64.to_le_bytes());

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_partial_json(json!({
                "method": "getAccountInfo",
                "params": [session.to_string(), { "encoding": "base64" }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": { "value": { "data": [STANDARD.encode(data), "base64"] } }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let hp = HyperPay::new(keypair, "devnet").with_ephemeral_rpc(&server.uri());
        let b = hp.session_balance(&user.to_string()).await.unwrap();
        assert_eq!(b.base_units, 42_000);
        assert_eq!(b.address, user.to_string());
    }

    #[tokio::test]
    async fn top_up_is_blocked_by_policy_before_sign() {
        let keypair = Keypair::new();
        let addr = keypair.pubkey().to_string();
        let policy = Policy::new().deny(&[&addr]);
        let hp = HyperPay::new(keypair, "devnet").with_policy(policy);

        let err = hp
            .top_up("1 USDC", SessionOpts::default())
            .await
            .unwrap_err();
        match err {
            HyperPayError::Policy(_) => {}
            other => panic!("unexpected error: {other}"),
        }
    }

    #[tokio::test]
    async fn charge_is_blocked_by_policy_before_sign() {
        let keypair = Keypair::new();
        let user = Keypair::new().pubkey();
        let policy = Policy::new().max_per_tx("1 USDC").unwrap();
        let hp = HyperPay::new(keypair, "devnet").with_policy(policy);

        let err = hp.charge(&user.to_string(), "2 USDC").await.unwrap_err();
        match err {
            HyperPayError::Policy(message) => {
                assert!(
                    message.contains("exceeds the per-transaction cap"),
                    "{message}"
                );
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn charge_ix_never_forwards_a_session_token() {
        let merchant = Keypair::new().pubkey();
        let user_wallet = Keypair::new().pubkey();
        let mint = Pubkey::new_unique();
        let (user, _) = user_pda(&user_wallet);
        let (user_mint, _) = user_mint_pda(&user, &mint);
        let (session, _) = session_pda(&user, &merchant, &mint);
        let (user_eata, _) = (Pubkey::new_unique(), 0u8);
        let (merchant_eata, _) = (Pubkey::new_unique(), 0u8);
        let ix = charge_ix(
            &SessionAccounts {
                user,
                signer: merchant,
                user_mint,
                session,
                merchant,
                mint,
                user_eata,
            },
            merchant_eata,
            10,
            None,
        );
        assert_eq!(
            ix.accounts.last().unwrap().pubkey,
            crate::program::PROGRAM_ID
        );
    }

    #[test]
    fn load_keypair_accepts_json_and_base58() {
        let kp = Keypair::new();
        let json = serde_json::to_string(&kp.to_bytes().to_vec()).unwrap();
        assert_eq!(load_keypair(&json).unwrap().pubkey(), kp.pubkey());

        let b58 = solana_sdk::bs58::encode(kp.to_bytes()).into_string();
        assert_eq!(load_keypair(&b58).unwrap().pubkey(), kp.pubkey());
    }

    #[test]
    fn parse_tokens_env_reads_symbol_mint_decimals() {
        let mint = Pubkey::new_unique().to_string();
        let tokens = parse_tokens_env(&format!("TEST:{mint}:6,FOO:{mint}:9")).unwrap();
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].symbol, "TEST");
        assert_eq!(tokens[0].decimals, 6);
        assert_eq!(tokens[1].symbol, "FOO");
        assert_eq!(tokens[1].decimals, 9);
    }

    #[test]
    fn quote_checks_policy_without_submitting() {
        let hp = HyperPay::new(Keypair::new(), "devnet");
        let merchant = Keypair::new().pubkey().to_string();
        let q = hp.quote(&merchant, "10 USDC", None).unwrap();
        assert_eq!(q.units, 10_000_000);
        assert_eq!(q.to, merchant);
        assert_eq!(q.settles_on, "ephemeral");

        let hp = hp.with_policy(Policy::new().max_per_tx("1 USDC").unwrap());
        assert!(hp.quote(&merchant, "2 USDC", None).is_err());
    }

    #[test]
    fn session_accounts_derive_user_pda_from_authority_not_signer() {
        let session_key = Keypair::new();
        let signer = session_key.pubkey();
        let wallet = Keypair::new().pubkey();
        let hp = HyperPay::new(session_key, "devnet");
        let merchant = Keypair::new().pubkey();
        let token = lookup_known_token("USDC", "devnet").unwrap();
        let accounts = hp.session_accounts(wallet, merchant, &token).unwrap();
        assert_eq!(accounts.user, user_pda(&wallet).0);
        assert_ne!(accounts.user, user_pda(&signer).0);
        assert_eq!(accounts.signer, signer);
    }

    #[test]
    fn open_session_may_be_zero() {
        let hp = HyperPay::new(Keypair::new(), "devnet");
        let (token, units) = hp.resolve_units("0 USDC", None, true).unwrap();
        assert_eq!(units, 0);
        assert_eq!(token.symbol, "USDC");
        assert!(hp.resolve_units("0 USDC", None, false).is_err());
    }

    #[tokio::test]
    async fn balance_reads_base_layer_ata() {
        let keypair = Keypair::new();
        let mint = Pubkey::from_str("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU").unwrap();
        let ata = associated_token_address(&keypair.pubkey(), &mint, &TOKEN_PROGRAM_ID);

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_partial_json(json!({
                "method": "getTokenAccountBalance",
                "params": [ata.to_string(), { "commitment": "confirmed" }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": { "value": { "amount": "1500000", "decimals": 6 } }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let hp = HyperPay::new(keypair, "devnet").with_rpc(&server.uri());
        let b = hp.balance(None, None).await.unwrap();
        assert_eq!(b.base_units, 1_500_000);
        assert_eq!(b.base, "1.5");
    }
}
