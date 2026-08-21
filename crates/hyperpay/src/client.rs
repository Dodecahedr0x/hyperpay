use solana_sdk::{signature::Keypair, signer::Signer};

use crate::amounts::{
    format_amount, from_base_units, lookup_known_token, parse_money, to_base_units, TokenInfo,
};
use crate::api::{new_ref_id, DepositRequest, Fees, PaymentsApi, TransferRequest, WithdrawRequest};
use crate::engine::{base_rpc_for, sign_and_submit};
use crate::error::{HyperPayError, Result};
use crate::policy::Policy;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Private,
    Public,
}

impl Visibility {
    fn as_str(self) -> &'static str {
        match self {
            Visibility::Private => "private",
            Visibility::Public => "public",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PayOptions {
    /// Symbol or mint address. Overrides the symbol in the amount string.
    pub token: Option<String>,
    pub visibility: Option<Visibility>,
    pub memo: Option<String>,
    /// Fan a private transfer across 1-15 queue entries.
    pub split: Option<u8>,
}

#[derive(Debug, Clone)]
pub struct Payment {
    pub signature: String,
    pub ref_id: Option<String>,
    pub to: String,
    /// Human form, e.g. `"10 USDC"`.
    pub amount: String,
    pub units: u64,
    pub token: TokenInfo,
    pub visibility: Visibility,
    pub settled_on: String,
    pub fees: Option<Fees>,
    /// Absent for ephemeral settlement — private transfers are not publicly indexed.
    pub explorer_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Balance {
    pub address: String,
    pub token: TokenInfo,
    pub base: String,
    pub base_units: u64,
}

/// The whole payment system, in one struct.
///
/// ```no_run
/// # use hyperpay::{HyperPay, PayOptions};
/// # async fn demo() -> hyperpay::Result<()> {
/// let hp = HyperPay::from_env()?;
/// let payment = hp.pay("alice@magicblock.id", "10 USDC", PayOptions::default()).await?;
/// println!("{}", payment.signature);
/// # Ok(()) }
/// ```
pub struct HyperPay {
    pub cluster: String,
    api: PaymentsApi,
    pub policy: Policy,
    keypair: Option<Keypair>,
    rpc_url: String,
    custom_tokens: Vec<TokenInfo>,
    default_token: String,
}

impl HyperPay {
    pub fn new(keypair: Keypair, cluster: &str) -> Self {
        Self {
            cluster: cluster.to_string(),
            api: PaymentsApi::default(),
            policy: Policy::new(),
            keypair: Some(keypair),
            rpc_url: base_rpc_for(cluster, None),
            custom_tokens: Vec::new(),
            default_token: "USDC".to_string(),
        }
    }

    /// Reads `HYPERPAY_KEY` (a JSON byte array or a path to a keypair file),
    /// `HYPERPAY_CLUSTER`, `HYPERPAY_RPC` and the policy variables.
    pub fn from_env() -> Result<Self> {
        let cluster = std::env::var("HYPERPAY_CLUSTER").unwrap_or_else(|_| "mainnet".into());
        let keypair = std::env::var("HYPERPAY_KEY")
            .ok()
            .map(|source| load_keypair(&source))
            .transpose()?;

        Ok(Self {
            rpc_url: base_rpc_for(&cluster, std::env::var("HYPERPAY_RPC").ok().as_deref()),
            api: match std::env::var("HYPERPAY_API") {
                Ok(url) => PaymentsApi::new(&url),
                Err(_) => PaymentsApi::default(),
            },
            policy: Policy::from_env()?,
            default_token: std::env::var("HYPERPAY_TOKEN").unwrap_or_else(|_| "USDC".into()),
            custom_tokens: Vec::new(),
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

    pub fn address(&self) -> Result<String> {
        Ok(self.signer()?.pubkey().to_string())
    }

    /// Pay someone. Private by default.
    pub async fn pay(&self, to: &str, amount: &str, opts: PayOptions) -> Result<Payment> {
        let (token, units) = self.resolve_amount(amount, opts.token.as_deref())?;
        let visibility = opts.visibility.unwrap_or(Visibility::Private);

        // Runs before anything is built or signed: a rejected payment must
        // leave no transaction in existence.
        self.policy.check(to, &token, units)?;

        let ref_id = matches!(visibility, Visibility::Private).then(new_ref_id);
        let request = TransferRequest {
            from: self.address()?,
            to: to.to_string(),
            mint: token.mint.clone(),
            amount: units,
            cluster: Some(self.cluster.clone()),
            visibility: Some(visibility.as_str().to_string()),
            memo: opts.memo,
            client_ref_id: ref_id.clone(),
            split: opts.split,
            init_if_missing: Some(true),
            init_atas_if_missing: Some(true),
        };

        let build = self.api.transfer(&request).await?;
        let result =
            sign_and_submit(&build, self.signer()?, &self.cluster, Some(&self.rpc_url)).await?;

        Ok(Payment {
            explorer_url: (result.settled_on == "base")
                .then(|| self.explorer_url(&result.signature)),
            signature: result.signature,
            ref_id,
            to: to.to_string(),
            amount: format_amount(units, &token),
            units,
            token,
            visibility,
            settled_on: result.settled_on,
            fees: build.fees,
        })
    }

    /// Moves tokens from the base layer into the ephemeral rollup.
    pub async fn deposit(&self, amount: &str, token: Option<&str>) -> Result<Payment> {
        let (token, units) = self.resolve_amount(amount, token)?;
        let build = self
            .api
            .deposit(&DepositRequest {
                owner: self.address()?,
                mint: token.mint.clone(),
                amount: units,
                cluster: Some(self.cluster.clone()),
                init_if_missing: true,
                init_vault_if_missing: true,
                init_atas_if_missing: true,
            })
            .await?;
        self.receipt(build, token, units, Visibility::Private).await
    }

    /// Moves tokens from the ephemeral rollup back to the base layer.
    pub async fn withdraw(&self, amount: &str, token: Option<&str>) -> Result<Payment> {
        let (token, units) = self.resolve_amount(amount, token)?;
        let build = self
            .api
            .withdraw(&WithdrawRequest {
                owner: self.address()?,
                mint: token.mint.clone(),
                amount: units,
                cluster: Some(self.cluster.clone()),
                init_if_missing: true,
                init_atas_if_missing: true,
            })
            .await?;
        self.receipt(build, token, units, Visibility::Public).await
    }

    /// Registers a mint with the ephemeral validator. Required once per mint.
    pub async fn initialize_mint(&self, token: Option<&str>) -> Result<Option<String>> {
        let token = self.resolve_token(token.unwrap_or(&self.default_token))?;
        if self
            .api
            .is_mint_initialized(&token.mint, &self.cluster)
            .await?
            .initialized
        {
            return Ok(None);
        }
        let build = self
            .api
            .initialize_mint(&token.mint, &self.cluster, &self.address()?)
            .await?;
        let result =
            sign_and_submit(&build, self.signer()?, &self.cluster, Some(&self.rpc_url)).await?;
        Ok(Some(result.signature))
    }

    pub async fn balance(&self, token: Option<&str>, address: Option<&str>) -> Result<Balance> {
        let token = self.resolve_token(token.unwrap_or(&self.default_token))?;
        let address = match address {
            Some(a) => a.to_string(),
            None => self.address()?,
        };
        let response = self
            .api
            .balance(&address, &token.mint, &self.cluster)
            .await?;
        let units: u64 = response.balance.parse().unwrap_or(0);

        Ok(Balance {
            base: from_base_units(units, token.decimals),
            base_units: units,
            address,
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
        let (value, symbol) = parse_money(amount)?;
        let spec = token
            .map(str::to_string)
            .or(symbol)
            .unwrap_or_else(|| self.default_token.clone());
        let token = self.resolve_token(&spec)?;
        let units = to_base_units(&value, token.decimals)?;
        if units == 0 {
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

    async fn receipt(
        &self,
        build: crate::api::BuildResponse,
        token: TokenInfo,
        units: u64,
        visibility: Visibility,
    ) -> Result<Payment> {
        let result =
            sign_and_submit(&build, self.signer()?, &self.cluster, Some(&self.rpc_url)).await?;
        Ok(Payment {
            explorer_url: (result.settled_on == "base")
                .then(|| self.explorer_url(&result.signature)),
            signature: result.signature,
            ref_id: None,
            to: self.address()?,
            amount: format_amount(units, &token),
            units,
            token,
            visibility,
            settled_on: result.settled_on,
            fees: build.fees,
        })
    }

    fn signer(&self) -> Result<&Keypair> {
        self.keypair.as_ref().ok_or(HyperPayError::NoSigner)
    }
}

/// Loads a keypair from a JSON byte array or a path to a Solana CLI keypair file.
pub fn load_keypair(source: &str) -> Result<Keypair> {
    let contents = if source.trim_start().starts_with('[') {
        source.to_string()
    } else {
        std::fs::read_to_string(source).map_err(|e| {
            HyperPayError::Resolution(format!("could not read keypair file \"{source}\": {e}"))
        })?
    };

    let bytes: Vec<u8> = serde_json::from_str(&contents)
        .map_err(|e| HyperPayError::Resolution(format!("keypair is not a JSON byte array: {e}")))?;

    Keypair::try_from(bytes.as_slice())
        .map_err(|e| HyperPayError::Resolution(format!("invalid keypair bytes: {e}")))
}
