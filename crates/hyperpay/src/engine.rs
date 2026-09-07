use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;
use solana_sdk::{
    hash::Hash, pubkey::Pubkey, signature::Keypair, signer::Signer,
    transaction::VersionedTransaction,
};
use std::time::{Duration, Instant};

use crate::error::{HyperPayError, Result};

pub fn default_rpc(cluster: &str) -> &'static str {
    if cluster.contains("devnet") {
        "https://api.devnet.solana.com"
    } else {
        "https://api.mainnet-beta.solana.com"
    }
}

pub fn default_ephemeral_rpc(cluster: &str) -> &'static str {
    if cluster.contains("devnet") {
        "https://devnet.magicblock.app"
    } else {
        "https://mainnet.magicblock.app"
    }
}

pub fn base_rpc_for(cluster: &str, override_url: Option<&str>) -> String {
    match override_url {
        Some(url) => url.to_string(),
        None if cluster.starts_with("http") => cluster.to_string(),
        None => default_rpc(cluster).to_string(),
    }
}

pub fn ephemeral_rpc_for(cluster: &str, override_url: Option<&str>) -> String {
    match override_url {
        Some(url) => url.to_string(),
        None => default_ephemeral_rpc(cluster).to_string(),
    }
}

pub struct SubmitResult {
    pub signature: String,
    pub rpc_url: String,
    pub settled_on: String,
}

/// Signs a client-built transaction, submits it, and confirms it.
pub async fn sign_and_submit(
    mut tx: VersionedTransaction,
    keypair: &Keypair,
    rpc_url: &str,
    settled_on: &str,
    skip_preflight: bool,
) -> Result<SubmitResult> {
    let me = keypair.pubkey();
    let message_bytes = tx.message.serialize();
    let index = tx
        .message
        .static_account_keys()
        .iter()
        .position(|k| *k == me)
        .ok_or_else(|| {
            HyperPayError::Resolution(format!("{me} is not an account in the built transaction"))
        })?;

    if index >= tx.signatures.len() {
        return Err(HyperPayError::Encoding(
            "transaction has fewer signature slots than signers".into(),
        ));
    }
    tx.signatures[index] = keypair.sign_message(&message_bytes);

    let http = reqwest::Client::new();
    let encoded =
        STANDARD.encode(bincode::serialize(&tx).map_err(|e| {
            HyperPayError::Encoding(format!("could not re-encode transaction: {e}"))
        })?);

    let signature = rpc_call(
        &http,
        rpc_url,
        "sendTransaction",
        json!([
            encoded,
            {
                "encoding": "base64",
                "skipPreflight": skip_preflight,
                "preflightCommitment": "confirmed"
            }
        ]),
    )
    .await?
    .as_str()
    .ok_or_else(|| HyperPayError::Api {
        message: "sendTransaction did not return a signature".into(),
        code: None,
    })?
    .to_string();

    confirm(&http, rpc_url, &signature, Duration::from_secs(60)).await?;

    Ok(SubmitResult {
        signature,
        rpc_url: rpc_url.to_string(),
        settled_on: settled_on.to_string(),
    })
}

/// Polls signature status rather than subscribing.
///
/// The ephemeral rollup RPC is not guaranteed to serve websockets, and a hung
/// subscription is indistinguishable from a dropped payment. Polling behaves
/// identically on both networks.
pub async fn confirm(
    http: &reqwest::Client,
    rpc_url: &str,
    signature: &str,
    timeout: Duration,
) -> Result<()> {
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        let response = rpc_call(
            http,
            rpc_url,
            "getSignatureStatuses",
            json!([[signature], { "searchTransactionHistory": true }]),
        )
        .await?;

        if let Some(status) = response.get("value").and_then(|v| v.get(0)) {
            if !status.is_null() {
                if let Some(err) = status.get("err").filter(|e| !e.is_null()) {
                    return Err(HyperPayError::Confirmation {
                        signature: signature.to_string(),
                        reason: format!("failed on chain: {err}"),
                    });
                }
                let confirmation = status
                    .get("confirmationStatus")
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                if confirmation == "confirmed" || confirmation == "finalized" {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    Err(HyperPayError::Confirmation {
        signature: signature.to_string(),
        reason: format!(
            "timed out after {timeout:?}; it may still settle, so check before retrying"
        ),
    })
}

pub async fn get_latest_blockhash(http: &reqwest::Client, rpc_url: &str) -> Result<Hash> {
    let result = rpc_call(
        http,
        rpc_url,
        "getLatestBlockhash",
        json!([{ "commitment": "confirmed" }]),
    )
    .await?;
    let hash = result
        .get("value")
        .and_then(|v| v.get("blockhash"))
        .and_then(|h| h.as_str())
        .ok_or_else(|| HyperPayError::Api {
            message: "getLatestBlockhash did not return a blockhash".into(),
            code: None,
        })?;
    hash.parse().map_err(|e| {
        HyperPayError::Encoding(format!("getLatestBlockhash returned an invalid hash: {e}"))
    })
}

pub async fn get_account_data(
    http: &reqwest::Client,
    rpc_url: &str,
    pubkey: &Pubkey,
) -> Result<Option<Vec<u8>>> {
    let result = rpc_call(
        http,
        rpc_url,
        "getAccountInfo",
        json!([pubkey.to_string(), { "encoding": "base64" }]),
    )
    .await?;
    let value = match result.get("value") {
        Some(v) if !v.is_null() => v,
        _ => return Ok(None),
    };
    let encoded = value
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|s| s.as_str())
        .ok_or_else(|| HyperPayError::Api {
            message: "getAccountInfo did not return base64 account data".into(),
            code: None,
        })?;
    STANDARD
        .decode(encoded)
        .map(Some)
        .map_err(|e| HyperPayError::Encoding(format!("account data is not valid base64: {e}")))
}

pub(crate) async fn rpc_call(
    http: &reqwest::Client,
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let value: serde_json::Value = http.post(url).json(&body).send().await?.json().await?;

    if let Some(error) = value.get("error") {
        return Err(HyperPayError::Api {
            message: format!(
                "{method}: {}",
                error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown RPC error")
            ),
            code: None,
        });
    }
    Ok(value
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn confirm_rejects_on_chain_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_partial_json(json!({ "method": "getSignatureStatuses" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "value": [{ "err": { "InstructionError": [0, "Custom"] }, "confirmationStatus": "confirmed" }]
                }
            })))
            .mount(&server)
            .await;

        let http = reqwest::Client::new();
        let err = confirm(&http, &server.uri(), "sig", Duration::from_secs(1))
            .await
            .unwrap_err();
        match err {
            HyperPayError::Confirmation { signature, reason } => {
                assert_eq!(signature, "sig");
                assert!(reason.contains("failed on chain"), "{reason}");
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[tokio::test]
    async fn get_account_data_decodes_base64() {
        let server = MockServer::start().await;
        let pubkey = Pubkey::new_unique();
        Mock::given(method("POST"))
            .and(body_partial_json(json!({ "method": "getAccountInfo" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": { "value": { "data": ["AQID", "base64"] } }
            })))
            .mount(&server)
            .await;

        let http = reqwest::Client::new();
        let data = get_account_data(&http, &server.uri(), &pubkey)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(data, vec![1, 2, 3]);
    }
}
