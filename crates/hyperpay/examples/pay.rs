//! Opens a payment session (or charges one) against the hyperpay program.
//!
//! ```sh
//! export HYPERPAY_KEY=/path/to/keypair.json
//! export HYPERPAY_CLUSTER=devnet
//! cargo run --example pay -- open <merchant> "1 USDC"
//! cargo run --example pay -- charge <user> "1 USDC"
//! ```

use hyperpay::{HyperPay, TokenInfo};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let action = args.next().unwrap_or_else(|| "charge".into());
    let counterparty = args
        .next()
        .ok_or("usage: pay <open|charge> <pubkey> <amount>")?;
    let amount = args.next().unwrap_or_else(|| "1 USDC".into());

    let mut hp = HyperPay::from_env()?;

    if let Ok(spec) = std::env::var("HYPERPAY_TOKENS") {
        let parts: Vec<&str> = spec.split(':').collect();
        if let [symbol, mint, decimals] = parts[..] {
            hp = hp
                .with_tokens(vec![TokenInfo::new(symbol, mint, decimals.parse()?)])
                .with_default_token(symbol);
        }
    }

    println!("from {}", hp.address()?);

    let payment = match action.as_str() {
        "open" => hp.open_session(&counterparty, &amount, None, None).await?,
        "charge" => hp.charge(&counterparty, &amount).await?,
        other => return Err(format!("unknown action {other}").into()),
    };

    println!("\n{} {} to {}", action, payment.amount, payment.to);
    println!("  signature   {}", payment.signature);
    println!("  settled on  {}", payment.settled_on);
    if let Some(url) = payment.explorer_url {
        println!("  explorer    {url}");
    }
    Ok(())
}
