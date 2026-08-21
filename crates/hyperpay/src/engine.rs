use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;
use solana_sdk::{signature::Keypair, signer::Signer, transaction::VersionedTransaction};
use std::time::{Duration, Instant};

use crate::api::BuildResponse;
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

/// Picks the network a built transaction must be submitted to.
///
/// Private transfers settle on the ephemeral rollup, not the base cluster.
/// Getting this wrong is the most common integration bug.
pub fn rpc_for_build(build: &BuildResponse, cluster: &str, base_override: Option<&str>) -> String {
    if build.send_to == "ephemeral" {
        build
            .send_rpc_endpoint
            .clone()
            .unwrap_or_else(|| default_ephemeral_rpc(cluster).to_string())
    } else {
        base_rpc_for(cluster, base_override)
    }
}

/// Deserialises the API's transaction.
///
/// `VersionedTransaction` handles both `legacy` and `v0` payloads: the message
/// prefix bit tells them apart, so one type covers both `version` values.
pub fn deserialize(build: &BuildResponse) -> Result<VersionedTransaction> {
    let bytes = STANDARD
        .decode(&build.transaction_base64)
        .map_err(|e| HyperPayError::Encoding(format!("transaction is not valid base64: {e}")))?;
    bincode::deserialize(&bytes)
        .map_err(|e| HyperPayError::Encoding(format!("could not decode transaction: {e}")))
}

pub struct SubmitResult {
    pub signature: String,
    pub rpc_url: String,
    pub settled_on: String,
}

/// Signs a built transaction, submits it to the correct RPC, and confirms it.
pub async fn sign_and_submit(
    build: &BuildResponse,
    keypair: &Keypair,
    cluster: &str,
    base_rpc: Option<&str>,
) -> Result<SubmitResult> {
    let me = keypair.pubkey().to_string();
    let missing: Vec<_> = build
        .required_signers
        .iter()
        .filter(|s| **s != me)
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(HyperPayError::Resolution(format!(
            "transaction needs signatures HyperPay cannot provide: {} (signer is {me})",
            missing.join(", ")
        )));
    }

    let mut tx = deserialize(build)?;
    let message_bytes = tx.message.serialize();
    let index = tx
        .message
        .static_account_keys()
        .iter()
        .position(|k| *k == keypair.pubkey())
        .ok_or_else(|| {
            HyperPayError::Resolution(format!("{me} is not an account in the built transaction"))
        })?;

    if index >= tx.signatures.len() {
        return Err(HyperPayError::Encoding(
            "built transaction has fewer signature slots than signers".into(),
        ));
    }
    tx.signatures[index] = keypair.sign_message(&message_bytes);

    let rpc_url = rpc_for_build(build, cluster, base_rpc);
    let http = reqwest::Client::new();
    let encoded =
        STANDARD.encode(bincode::serialize(&tx).map_err(|e| {
            HyperPayError::Encoding(format!("could not re-encode transaction: {e}"))
        })?);

    let signature = rpc_call(
        &http,
        &rpc_url,
        "sendTransaction",
        json!([encoded, { "encoding": "base64", "preflightCommitment": "confirmed" }]),
    )
    .await?
    .as_str()
    .ok_or_else(|| HyperPayError::Api {
        message: "sendTransaction did not return a signature".into(),
        code: None,
    })?
    .to_string();

    confirm(&http, &rpc_url, &signature, Duration::from_secs(60)).await?;

    Ok(SubmitResult {
        signature,
        rpc_url,
        settled_on: build.send_to.clone(),
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

async fn rpc_call(
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
