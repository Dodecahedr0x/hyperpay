# hyperpay

Rust client for the HyperPay payment-session program. The same crate is for
one-off scripts (`cargo run --example pay`) and long-running services.

It builds, signs, and submits program instructions. It does not call a hosted
payments API.

```toml
[dependencies]
hyperpay = { git = "https://github.com/magicblock-labs/hyperpay" }
# or: hyperpay = { path = "crates/hyperpay" }
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

```rust
use hyperpay::{HyperPay, SessionOpts};

#[tokio::main]
async fn main() -> hyperpay::Result<()> {
    let user = HyperPay::from_env()?;
    user.init_user(1_000_000).await?;
    user.delegate_user(None).await?;
    user.top_up("10 USDC", SessionOpts::default()).await?;
    user.open_session(&merchant, "10 USDC", SessionOpts::default()).await?;

    let merchant_hp = HyperPay::from_env()?;
    let remaining = merchant_hp.session_balance(&user_wallet).await?;
    let payment = merchant_hp.charge(&user_wallet, "1 USDC").await?;
    println!("{} remaining {}", remaining.base, payment.signature);
    Ok(())
}
```

Typical flow: `init_user` → `delegate_user` → `top_up` → `open_session` →
merchant `charge` → `close_session` → `withdraw`.

When the signer is a session key, pass `SessionOpts { authority: Some(wallet), ..Default::default() }`
so the User PDA is derived from the wallet that owns it.

`quote` policy-checks without sending. `balance` reads the base-layer ATA.
Daily spend caps journal to `~/.hyperpay/spend.json` (override with `HYPERPAY_JOURNAL`).
