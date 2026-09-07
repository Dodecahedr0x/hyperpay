//! Script-shaped client for the hyperpay program. Same crate a service would use.
//!
//! ```sh
//! export HYPERPAY_KEY=/path/to/keypair.json
//! export HYPERPAY_CLUSTER=devnet
//! cargo run -p hyperpay --example pay -- init
//! cargo run -p hyperpay --example pay -- delegate
//! cargo run -p hyperpay --example pay -- topup "10 USDC"
//! cargo run -p hyperpay --example pay -- open <merchant> "10 USDC"
//! cargo run -p hyperpay --example pay -- charge <user> "1 USDC"
//! cargo run -p hyperpay --example pay -- quote <merchant> "1 USDC"
//! cargo run -p hyperpay --example pay -- balance
//! cargo run -p hyperpay --example pay -- session-balance <user>
//! cargo run -p hyperpay --example pay -- close <merchant>
//! cargo run -p hyperpay --example pay -- withdraw "5 USDC"
//! ```

use std::sync::OnceLock;

use hyperpay::{HyperPay, SessionOpts};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let action = args.next().unwrap_or_else(|| "help".into());
    let hp = HyperPay::from_env()?;

    if action != "help" {
        println!("from {}", hp.address()?);
    }

    match action.as_str() {
        "init" => {
            let lamports = args.next().unwrap_or_else(|| "1000000".into()).parse()?;
            print_payment("init", hp.init_user(lamports).await?);
        }
        "delegate" => {
            print_payment("delegate", hp.delegate_user(args.next().as_deref()).await?);
        }
        "topup" => {
            let amount = args.next().ok_or("usage: pay topup <amount>")?;
            print_payment("topup", hp.top_up(&amount, session_opts()).await?);
        }
        "open" => {
            let merchant = args.next().ok_or("usage: pay open <merchant> <amount>")?;
            let amount = args.next().unwrap_or_else(|| "0".into());
            print_payment(
                "open",
                hp.open_session(&merchant, &amount, session_opts()).await?,
            );
        }
        "deposit" => {
            let merchant = args
                .next()
                .ok_or("usage: pay deposit <merchant> <amount>")?;
            let amount = args
                .next()
                .ok_or("usage: pay deposit <merchant> <amount>")?;
            print_payment(
                "deposit",
                hp.deposit(&merchant, &amount, session_opts()).await?,
            );
        }
        "charge" => {
            let user = args.next().ok_or("usage: pay charge <user> <amount>")?;
            let amount = args.next().ok_or("usage: pay charge <user> <amount>")?;
            print_payment("charge", hp.charge(&user, &amount).await?);
        }
        "close" => {
            let merchant = args.next().ok_or("usage: pay close <merchant>")?;
            print_payment("close", hp.close_session(&merchant, session_opts()).await?);
        }
        "withdraw" => {
            let amount = args.next().ok_or("usage: pay withdraw <amount>")?;
            print_payment("withdraw", hp.withdraw(&amount, session_opts()).await?);
        }
        "quote" => {
            let merchant = args.next().ok_or("usage: pay quote <merchant> <amount>")?;
            let amount = args.next().ok_or("usage: pay quote <merchant> <amount>")?;
            let q = hp.quote(&merchant, &amount, None)?;
            println!(
                "\nquote {} to {} ({} units, settles on {})",
                q.amount, q.to, q.units, q.settles_on
            );
        }
        "balance" => {
            let b = hp.balance(None, args.next().as_deref()).await?;
            println!("\n{} {} ({})", b.base, b.token.symbol, b.address);
        }
        "session-balance" => {
            let user = args.next().ok_or("usage: pay session-balance <user>")?;
            let b = hp.session_balance(&user).await?;
            println!(
                "\nsession remaining {} {} ({})",
                b.base, b.token.symbol, b.address
            );
        }
        _ => {
            eprintln!(
                "usage: pay <init|delegate|topup|open|deposit|charge|close|withdraw|quote|balance|session-balance> ..."
            );
            std::process::exit(2);
        }
    }
    Ok(())
}

fn session_opts() -> SessionOpts<'static> {
    static AUTHORITY: OnceLock<Option<String>> = OnceLock::new();
    let stored = AUTHORITY.get_or_init(|| std::env::var("HYPERPAY_AUTHORITY").ok());
    SessionOpts {
        authority: stored.as_deref(),
        ..SessionOpts::default()
    }
}

fn print_payment(action: &str, payment: hyperpay::Payment) {
    println!("\n{action} {} to {}", payment.amount, payment.to);
    println!("  signature   {}", payment.signature);
    println!("  settled on  {}", payment.settled_on);
    if let Some(url) = payment.explorer_url {
        println!("  explorer    {url}");
    }
}
