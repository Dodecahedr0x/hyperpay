//! Hit a live mb-stack. Driven by `test/e2e/mb-stack.e2e.test.ts`.

use std::env;

use hyperpay::{load_keypair, HyperPay, TokenInfo};

fn hp(key_env: &str) -> HyperPay {
    let key = env::var(key_env).expect(key_env);
    let rpc = env::var("HYPERPAY_RPC").expect("HYPERPAY_RPC");
    let er = env::var("HYPERPAY_EPHEMERAL_RPC").expect("HYPERPAY_EPHEMERAL_RPC");
    let mint = env::var("E2E_MINT").expect("E2E_MINT");
    HyperPay::new(load_keypair(&key).expect("keypair"), "devnet")
        .with_rpc(&rpc)
        .with_ephemeral_rpc(&er)
        .with_tokens(vec![TokenInfo::new("TEST", &mint, 6)])
        .with_default_token("TEST")
}

#[tokio::test]
#[ignore = "needs mb-stack from test/e2e/mb-stack.e2e.test.ts"]
async fn rust_sdk_charges_an_open_session() {
    let user = env::var("E2E_USER").expect("E2E_USER");
    let hp = hp("HYPERPAY_KEY");
    let payment = hp.charge(&user, "1").await.expect("rust charge");
    assert!(!payment.signature.is_empty());
    assert_eq!(payment.settled_on, "ephemeral");
    let remaining = hp.session_balance(&user).await.expect("session balance");
    assert_eq!(remaining.base_units, 2_000_000);
}

#[tokio::test]
#[ignore = "needs mb-stack from test/e2e/mb-stack.e2e.test.ts"]
async fn rust_sdk_inits_and_delegates_user() {
    let hp = hp("HYPERPAY_USER_KEY");
    hp.init_user(10_000_000).await.expect("init_user");
    hp.delegate_user(None).await.expect("delegate_user");
}
