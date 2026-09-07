use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::{Address, Keypair};
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const USER_SEED: &[u8] = b"user";
const INIT_LAMPORTS: u64 = 1_000_000;
/// discriminator + authority + bump
const USER_ACCOUNT_SPACE: usize = 8 + 32 + 1;

fn program_so_path() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = Vec::new();
    if let Ok(dir) = std::env::var("CARGO_TARGET_DIR") {
        candidates.push(PathBuf::from(dir).join("deploy/hyperpay.so"));
    }
    candidates.push(manifest.join("../../target/deploy/hyperpay.so"));
    candidates.push(manifest.join("target/deploy/hyperpay.so"));
    for path in &candidates {
        if path.exists() {
            return path.clone();
        }
    }
    panic!(
        "hyperpay.so not found in {:?}; run `cargo-build-sbf --manifest-path programs/hyperpay/Cargo.toml`",
        candidates
    );
}

fn sighash(ix_name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{ix_name}"));
    hasher.finalize()[..8].try_into().unwrap()
}

fn to_address(pk: Pubkey) -> Address {
    Address::from(pk.to_bytes())
}

fn program_id() -> Address {
    to_address(hyperpay::ID)
}

fn init_user_ix(user: Address, authority: Address, lamports: u64) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&sighash("init_user"));
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(user, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(Address::default(), false),
        ],
        data,
    }
}

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), program_so_path())
        .expect("load hyperpay.so");

    let wallet = Keypair::new();
    svm.airdrop(&wallet.pubkey(), 10_000_000_000)
        .expect("airdrop wallet");
    (svm, wallet)
}

fn user_pda(wallet: Address) -> (Address, u8) {
    let (pda, bump) = Pubkey::find_program_address(&[USER_SEED, wallet.as_ref()], &hyperpay::ID);
    (to_address(pda), bump)
}

fn fund_user_ix(user: Address, authority: Address, lamports: u64) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&sighash("fund_user"));
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(user, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(Address::default(), false),
        ],
        data,
    }
}

fn send_ix(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Result<(), String> {
    let tx = Transaction::new(
        &[payer],
        Message::new(&[ix], Some(&payer.pubkey())),
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|err| format!("{err:?}"))
}

fn send_init_user(svm: &mut LiteSVM, wallet: &Keypair, lamports: u64) -> Result<(), String> {
    let (user, _) = user_pda(wallet.pubkey());
    send_ix(svm, wallet, init_user_ix(user, wallet.pubkey(), lamports))
}

fn send_fund_user(svm: &mut LiteSVM, wallet: &Keypair, lamports: u64) -> Result<(), String> {
    let (user, _) = user_pda(wallet.pubkey());
    send_ix(svm, wallet, fund_user_ix(user, wallet.pubkey(), lamports))
}

#[test]
fn init_user_creates_user_pda_and_funds_it() {
    let (mut svm, wallet) = setup();
    let (user, bump) = user_pda(wallet.pubkey());

    send_init_user(&mut svm, &wallet, INIT_LAMPORTS).expect("init_user");

    let account = svm.get_account(&user).expect("User PDA exists");
    assert_eq!(account.owner, program_id());
    assert!(
        account.data.len() >= USER_ACCOUNT_SPACE,
        "user account too small: {}",
        account.data.len()
    );
    assert_eq!(&account.data[8..40], wallet.pubkey().as_ref());
    assert_eq!(account.data[40], bump);

    let rent = svm.minimum_balance_for_rent_exemption(account.data.len());
    assert!(
        account.lamports >= INIT_LAMPORTS + rent,
        "lamports {} < {} + rent {}",
        account.lamports,
        INIT_LAMPORTS,
        rent
    );
}

#[test]
fn init_user_cannot_reinitialize() {
    let (mut svm, wallet) = setup();

    send_init_user(&mut svm, &wallet, INIT_LAMPORTS).expect("first init_user");
    svm.expire_blockhash();
    let logs = send_init_user(&mut svm, &wallet, INIT_LAMPORTS)
        .expect_err("second init_user must fail (SOL-010)");
    assert!(
        logs.contains("already in use")
            || logs.contains("AlreadyInUse")
            || logs.contains("custom program error: 0x0"),
        "unexpected reinit error: {logs}"
    );
}

#[test]
fn fund_user_increases_user_lamports() {
    let (mut svm, wallet) = setup();
    let (user, _) = user_pda(wallet.pubkey());

    send_init_user(&mut svm, &wallet, INIT_LAMPORTS).expect("init_user");
    let before = svm.get_account(&user).expect("User PDA exists").lamports;

    svm.expire_blockhash();
    send_fund_user(&mut svm, &wallet, 500_000).expect("fund_user");

    let after = svm.get_account(&user).expect("User PDA exists").lamports;
    assert_eq!(after, before + 500_000);
}

#[test]
fn fund_user_rejects_zero_amount() {
    let (mut svm, wallet) = setup();

    send_init_user(&mut svm, &wallet, INIT_LAMPORTS).expect("init_user");
    svm.expire_blockhash();
    let logs = send_fund_user(&mut svm, &wallet, 0).expect_err("zero fund_user must fail");
    assert!(
        logs.contains("AmountZero")
            || logs.contains("amount must be greater than zero")
            || logs.contains("custom program error: 0x1770"),
        "unexpected zero-amount error: {logs}"
    );
}

#[test]
fn fund_user_rejects_wrong_authority() {
    let (mut svm, wallet) = setup();
    let (user, _) = user_pda(wallet.pubkey());

    send_init_user(&mut svm, &wallet, INIT_LAMPORTS).expect("init_user");

    let impostor = Keypair::new();
    svm.airdrop(&impostor.pubkey(), 10_000_000_000)
        .expect("airdrop impostor");
    svm.expire_blockhash();

    let ix = fund_user_ix(user, impostor.pubkey(), 500_000);
    let logs = send_ix(&mut svm, &impostor, ix).expect_err("wrong authority must fail (SOL-015)");
    assert!(
        logs.contains("has_one")
            || logs.contains("ConstraintHasOne")
            || logs.contains("ConstraintSeeds")
            || logs.contains("A has_one constraint was violated"),
        "unexpected wrong-authority error: {logs}"
    );
}
