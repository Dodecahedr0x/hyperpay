//! Sends a real private payment.
//!
//! ```sh
//! export HYPERPAY_KEY=/path/to/keypair.json
//! export HYPERPAY_CLUSTER=devnet
//! cargo run --example pay -- <recipient> "1 USDC"
//! ```

use hyperpay::{HyperPay, PayOptions, TokenInfo};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let to = args.next().ok_or("usage: pay <recipient> <amount>")?;
    let amount = args.next().unwrap_or_else(|| "1 USDC".into());

    let mut hp = HyperPay::from_env()?;

    // Optional: name a custom mint so "1 TEST" and spend caps in TEST work.
    if let Ok(spec) = std::env::var("HYPERPAY_TOKENS") {
        let parts: Vec<&str> = spec.split(':').collect();
        if let [symbol, mint, decimals] = parts[..] {
            hp = hp
                .with_tokens(vec![TokenInfo::new(symbol, mint, decimals.parse()?)])
                .with_default_token(symbol);
        }
    }

    println!("paying from {}", hp.address()?);
    println!("balance: {}", hp.balance(None, None).await?.base);

    let payment = hp.pay(&to, &amount, PayOptions::default()).await?;

    println!("\npaid {} to {}", payment.amount, payment.to);
    println!("  signature   {}", payment.signature);
    println!("  visibility  {:?}", payment.visibility);
    println!("  settled on  {}", payment.settled_on);
    if let Some(url) = payment.explorer_url {
        println!("  explorer    {url}");
    }
    if let Some(fees) = payment.fees {
        println!(
            "  fees        {} tokens + {} lamports",
            fees.tokens, fees.lamports
        );
    }
    Ok(())
}
