use thiserror::Error;

#[derive(Debug, Error)]
pub enum HyperPayError {
    /// A spend rule rejected the payment. Nothing was built or signed.
    #[error("blocked by spend policy: {0}")]
    Policy(String),

    #[error("payments API error{}: {message}", .code.as_ref().map(|c| format!(" ({c})")).unwrap_or_default())]
    Api {
        message: String,
        code: Option<String>,
    },

    #[error("could not resolve {0}")]
    Resolution(String),

    #[error("transaction {signature} did not confirm: {reason}")]
    Confirmation { signature: String, reason: String },

    #[error("no signer configured: set HYPERPAY_KEY or pass a keypair")]
    NoSigner,

    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("malformed transaction from the API: {0}")]
    Encoding(String),
}

pub type Result<T> = std::result::Result<T, HyperPayError>;
