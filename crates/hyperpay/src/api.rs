use serde::{Deserialize, Serialize};

use crate::error::{HyperPayError, Result};

pub const DEFAULT_API_URL: &str = "https://payments.magicblock.app";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResponse {
    pub transaction_base64: String,
    /// `base` or `ephemeral`. Submitting to the wrong one fails with an
    /// unhelpful "blockhash not found".
    pub send_to: String,
    #[serde(default)]
    pub send_rpc_endpoint: Option<String>,
    #[serde(default)]
    pub required_signers: Vec<String>,
    #[serde(default)]
    pub fees: Option<Fees>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Fees {
    pub lamports: String,
    pub tokens: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BalanceResponse {
    pub address: String,
    pub mint: String,
    pub balance: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintStatus {
    pub mint: String,
    pub initialized: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub from: String,
    pub to: String,
    pub mint: String,
    pub amount: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
    /// Must be a non-negative integer **string**, not free text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_ref_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_if_missing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_atas_if_missing: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositRequest {
    pub owner: String,
    pub mint: String,
    pub amount: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<String>,
    pub init_if_missing: bool,
    pub init_vault_if_missing: bool,
    pub init_atas_if_missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawRequest {
    pub owner: String,
    pub mint: String,
    pub amount: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<String>,
    pub init_if_missing: bool,
    pub init_atas_if_missing: bool,
}

/// Thin typed client over the MagicBlock payments API. Does not sign or route.
#[derive(Debug, Clone)]
pub struct PaymentsApi {
    base_url: String,
    http: reqwest::Client,
}

impl Default for PaymentsApi {
    fn default() -> Self {
        Self::new(DEFAULT_API_URL)
    }
}

impl PaymentsApi {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub async fn transfer(&self, req: &TransferRequest) -> Result<BuildResponse> {
        self.post("/v1/spl/transfer", req).await
    }

    pub async fn deposit(&self, req: &DepositRequest) -> Result<BuildResponse> {
        self.post("/v1/spl/deposit", req).await
    }

    pub async fn withdraw(&self, req: &WithdrawRequest) -> Result<BuildResponse> {
        self.post("/v1/spl/withdraw", req).await
    }

    pub async fn initialize_mint(
        &self,
        mint: &str,
        cluster: &str,
        payer: &str,
    ) -> Result<BuildResponse> {
        self.post(
            "/v1/spl/initialize-mint",
            &serde_json::json!({ "mint": mint, "cluster": cluster, "payer": payer }),
        )
        .await
    }

    pub async fn balance(
        &self,
        address: &str,
        mint: &str,
        cluster: &str,
    ) -> Result<BalanceResponse> {
        self.get(
            "/v1/spl/balance",
            &[("address", address), ("mint", mint), ("cluster", cluster)],
        )
        .await
    }

    pub async fn is_mint_initialized(&self, mint: &str, cluster: &str) -> Result<MintStatus> {
        self.get(
            "/v1/spl/is-mint-initialized",
            &[("mint", mint), ("cluster", cluster)],
        )
        .await
    }

    async fn post<B: Serialize, T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let res = self
            .http
            .post(format!("{}{path}", self.base_url))
            .json(body)
            .send()
            .await?;
        Self::decode(path, res).await
    }

    async fn get<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T> {
        let res = self
            .http
            .get(format!("{}{path}", self.base_url))
            .query(query)
            .send()
            .await?;
        Self::decode(path, res).await
    }

    async fn decode<T: for<'de> Deserialize<'de>>(path: &str, res: reqwest::Response) -> Result<T> {
        let status = res.status();
        let text = res.text().await?;

        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| HyperPayError::Api {
                message: format!("{path} returned non-JSON ({status}): {}", truncate(&text)),
                code: None,
            })?;

        if let Some(error) = value.get("error") {
            return Err(HyperPayError::Api {
                message: format!(
                    "{path}: {}{}",
                    error
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown error"),
                    error
                        .get("issues")
                        .map(|i| format!(" {i}"))
                        .unwrap_or_default()
                ),
                code: error
                    .get("code")
                    .and_then(|c| c.as_str())
                    .map(str::to_string),
            });
        }
        if !status.is_success() {
            return Err(HyperPayError::Api {
                message: format!("{path} returned {status}: {}", truncate(&text)),
                code: None,
            });
        }

        serde_json::from_value(value).map_err(|e| HyperPayError::Api {
            message: format!("{path}: unexpected response shape ({e})"),
            code: None,
        })
    }
}

fn truncate(s: &str) -> String {
    s.chars().take(200).collect()
}

/// The API requires `clientRefId` to be a non-negative integer string.
///
/// `RandomState` is the standard library's randomly-seeded hasher, which gives
/// per-process entropy without taking on a random-number dependency.
pub fn new_ref_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or_default();

    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(nanos);
    hasher.finish().to_string()
}
