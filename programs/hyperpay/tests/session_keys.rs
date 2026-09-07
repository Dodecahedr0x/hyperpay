use std::path::PathBuf;
use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::{Address, Keypair};
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const USER_SEED: &[u8] = b"user";
const USER_MINT_SEED: &[u8] = b"user_mint";
const SESSION_SEED: &[u8] = b"session";
const SESSION_TOKEN_V2_SEED: &[u8] = b"session_token_v2";
const TOKEN_ACCOUNT_LEN: usize = 165;
const EATA_BALANCE: u64 = 100;
const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SESSION_KEYS_ID: &str = "KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5";
const MAGIC_PROGRAM_ID: &str = "Magic11111111111111111111111111111111111111";
const EPHEMERAL_VAULT_ID: &str = "MagicVau1t999999999999999999999999999999999";
/// Far enough in the future that LiteSVM's clock cannot expire the token.
const TOKEN_VALID_UNTIL: i64 = 2_000_000_000;

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

/// Dump from devnet into the LiteSVM deploy dir:
/// `solana program dump -u d KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5 target/deploy/session_keys.so`
fn session_keys_so_path() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = Vec::new();
    if let Ok(dir) = std::env::var("CARGO_TARGET_DIR") {
        candidates.push(PathBuf::from(dir).join("deploy/session_keys.so"));
    }
    candidates.push(manifest.join("../../target/deploy/session_keys.so"));
    candidates.push(manifest.join("target/deploy/session_keys.so"));
    for path in &candidates {
        if path.exists() {
            return path.clone();
        }
    }
    panic!(
        "session_keys.so not found in {:?}; dump from devnet: solana program dump -u d {} target/deploy/session_keys.so",
        candidates, SESSION_KEYS_ID
    );
}

fn sighash(ix_name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{ix_name}"));
    hasher.finalize()[..8].try_into().unwrap()
}

fn account_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("account:{name}"));
    hasher.finalize()[..8].try_into().unwrap()
}

fn to_address(pk: Pubkey) -> Address {
    Address::from(pk.to_bytes())
}

fn program_id() -> Address {
    to_address(hyperpay::ID)
}

fn session_keys_id() -> Address {
    Address::from_str(SESSION_KEYS_ID).expect("session-keys program id")
}

fn token_program_id() -> Address {
    Address::from_str(TOKEN_PROGRAM_ID).expect("token program id")
}

fn magic_program_id() -> Address {
    Address::from_str(MAGIC_PROGRAM_ID).expect("magic program id")
}

fn ephemeral_vault_id() -> Address {
    Address::from_str(EPHEMERAL_VAULT_ID).expect("ephemeral vault id")
}

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), program_so_path())
        .expect("load hyperpay.so");
    svm.add_program_from_file(session_keys_id(), session_keys_so_path())
        .expect("load session_keys.so");

    let wallet = Keypair::new();
    svm.airdrop(&wallet.pubkey(), 10_000_000_000)
        .expect("airdrop wallet");
    (svm, wallet)
}

fn user_pda(wallet: Address) -> (Address, u8) {
    let (pda, bump) = Pubkey::find_program_address(&[USER_SEED, wallet.as_ref()], &hyperpay::ID);
    (to_address(pda), bump)
}

fn user_mint_pda(user: Address, mint: Address) -> (Address, u8) {
    let (pda, bump) = Pubkey::find_program_address(
        &[USER_MINT_SEED, user.as_ref(), mint.as_ref()],
        &hyperpay::ID,
    );
    (to_address(pda), bump)
}

fn session_pda(user: Address, merchant: Address, mint: Address) -> (Address, u8) {
    let (pda, bump) = Pubkey::find_program_address(
        &[
            SESSION_SEED,
            user.as_ref(),
            merchant.as_ref(),
            mint.as_ref(),
        ],
        &hyperpay::ID,
    );
    (to_address(pda), bump)
}

fn session_token_pda(session_signer: Address, authority: Address) -> (Address, u8) {
    let (pda, bump) = Pubkey::find_program_address(
        &[
            SESSION_TOKEN_V2_SEED,
            hyperpay::ID.as_ref(),
            session_signer.as_ref(),
            authority.as_ref(),
        ],
        &session_keys::ID,
    );
    (to_address(pda), bump)
}

fn serialize_user(authority: Address, bump: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(41);
    data.extend_from_slice(&account_discriminator("User"));
    data.extend_from_slice(authority.as_ref());
    data.push(bump);
    data
}

fn serialize_user_mint(user: Address, mint: Address, reserved: u64, bump: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(81);
    data.extend_from_slice(&account_discriminator("UserMint"));
    data.extend_from_slice(user.as_ref());
    data.extend_from_slice(mint.as_ref());
    data.extend_from_slice(&reserved.to_le_bytes());
    data.push(bump);
    data
}

fn serialize_session(
    user: Address,
    merchant: Address,
    mint: Address,
    remaining: u64,
    bump: u8,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(113);
    data.extend_from_slice(&account_discriminator("Session"));
    data.extend_from_slice(user.as_ref());
    data.extend_from_slice(merchant.as_ref());
    data.extend_from_slice(mint.as_ref());
    data.extend_from_slice(&remaining.to_le_bytes());
    data.push(bump);
    data
}

fn serialize_session_token_v2(
    authority: Address,
    session_signer: Address,
    fee_payer: Address,
    valid_until: i64,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(144);
    data.extend_from_slice(&account_discriminator("SessionTokenV2"));
    data.extend_from_slice(authority.as_ref());
    data.extend_from_slice(program_id().as_ref());
    data.extend_from_slice(session_signer.as_ref());
    data.extend_from_slice(fee_payer.as_ref());
    data.extend_from_slice(&valid_until.to_le_bytes());
    data
}

fn pack_token_account(mint: Address, owner: Address, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; TOKEN_ACCOUNT_LEN];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // AccountState::Initialized
    data
}

fn write_account(svm: &mut LiteSVM, address: Address, owner: Address, data: Vec<u8>) {
    svm.set_account(
        address,
        Account {
            lamports: 1_000_000,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("set_account");
}

fn install_magic_stubs(svm: &mut LiteSVM) {
    svm.add_program_from_file(magic_program_id(), program_so_path())
        .expect("stub magic program for Program<> checks");
    write_account(svm, ephemeral_vault_id(), Address::default(), Vec::new());
}

fn write_user_session_token(
    svm: &mut LiteSVM,
    session_signer: Address,
    authority: Address,
) -> Address {
    let (pda, _) = session_token_pda(session_signer, authority);
    write_account(
        svm,
        pda,
        session_keys_id(),
        serialize_session_token_v2(authority, session_signer, authority, TOKEN_VALID_UNTIL),
    );
    pda
}

struct Fixture {
    wallet: Keypair,
    session_kp: Keypair,
    _merchant_kp: Keypair,
    user: Address,
    user_mint: Address,
    session: Address,
    merchant: Address,
    mint: Address,
    user_eata: Address,
    merchant_eata: Address,
    destination: Address,
}

fn fixture(svm: &mut LiteSVM, wallet: Keypair, reserved: u64, remaining: u64) -> Fixture {
    let (user, user_bump) = user_pda(wallet.pubkey());
    let mint = Keypair::new().pubkey();
    let merchant_kp = Keypair::new();
    let merchant = merchant_kp.pubkey();
    svm.airdrop(&merchant, 10_000_000_000)
        .expect("airdrop merchant");
    let session_kp = Keypair::new();
    svm.airdrop(&session_kp.pubkey(), 10_000_000_000)
        .expect("airdrop session key");
    let (user_mint, user_mint_bump) = user_mint_pda(user, mint);
    let (session, session_bump) = session_pda(user, merchant, mint);
    let user_eata = Keypair::new().pubkey();
    let merchant_eata = Keypair::new().pubkey();
    let destination = Keypair::new().pubkey();

    write_account(
        svm,
        user,
        program_id(),
        serialize_user(wallet.pubkey(), user_bump),
    );
    write_account(
        svm,
        user_mint,
        program_id(),
        serialize_user_mint(user, mint, reserved, user_mint_bump),
    );
    write_account(
        svm,
        session,
        program_id(),
        serialize_session(user, merchant, mint, remaining, session_bump),
    );
    write_account(svm, mint, Address::default(), vec![0u8; 82]);
    write_account(
        svm,
        user_eata,
        token_program_id(),
        pack_token_account(mint, user, EATA_BALANCE),
    );
    write_account(
        svm,
        merchant_eata,
        token_program_id(),
        pack_token_account(mint, merchant, 0),
    );
    write_account(
        svm,
        destination,
        token_program_id(),
        pack_token_account(mint, wallet.pubkey(), 0),
    );

    Fixture {
        wallet,
        session_kp,
        _merchant_kp: merchant_kp,
        user,
        user_mint,
        session,
        merchant,
        mint,
        user_eata,
        merchant_eata,
        destination,
    }
}

fn deposit_ix(fx: &Fixture, signer: Address, session_token: Address, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&sighash("deposit"));
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.user, false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(fx.user_mint, false),
            AccountMeta::new(fx.session, false),
            AccountMeta::new_readonly(fx.merchant, false),
            AccountMeta::new_readonly(fx.mint, false),
            AccountMeta::new_readonly(fx.user_eata, false),
            AccountMeta::new_readonly(session_token, false),
        ],
        data,
    }
}

fn charge_ix(fx: &Fixture, signer: Address, session_token: Address, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&sighash("charge"));
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.user, false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(fx.user_mint, false),
            AccountMeta::new(fx.session, false),
            AccountMeta::new_readonly(fx.merchant, false),
            AccountMeta::new_readonly(fx.mint, false),
            AccountMeta::new(fx.user_eata, false),
            AccountMeta::new(fx.merchant_eata, false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(session_token, false),
        ],
        data,
    }
}

fn withdraw_ix(fx: &Fixture, signer: Address, session_token: Address, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&sighash("withdraw"));
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.user, false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new_readonly(fx.user_mint, false),
            AccountMeta::new_readonly(fx.mint, false),
            AccountMeta::new(fx.user_eata, false),
            AccountMeta::new(fx.destination, false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(session_token, false),
        ],
        data,
    }
}

fn close_session_ix(fx: &Fixture, signer: Address, session_token: Address) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(fx.user, false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(fx.session, false),
            AccountMeta::new(fx.user_mint, false),
            AccountMeta::new_readonly(fx.merchant, false),
            AccountMeta::new_readonly(fx.mint, false),
            AccountMeta::new_readonly(session_token, false),
            AccountMeta::new(ephemeral_vault_id(), false),
            AccountMeta::new_readonly(magic_program_id(), false),
        ],
        data: sighash("close_session").to_vec(),
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

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

fn token_amount(svm: &LiteSVM, address: &Address) -> u64 {
    let account = svm.get_account(address).expect("token account");
    read_u64(&account.data, 64)
}

fn assert_auth_rejected(logs: &str) {
    assert!(
        logs.contains("Unauthorized")
            || logs.contains("signer is not allowed")
            || logs.contains("InvalidToken")
            || logs.contains("Invalid session token")
            || logs.contains("custom program error: 0x1774"),
        "unexpected auth error: {logs}"
    );
}

#[test]
fn user_session_key_can_deposit_and_charge() {
    let (mut svm, wallet) = setup();
    let fx = fixture(&mut svm, wallet, 0, 0);
    let token = write_user_session_token(&mut svm, fx.session_kp.pubkey(), fx.wallet.pubkey());

    send_ix(
        &mut svm,
        &fx.session_kp,
        deposit_ix(&fx, fx.session_kp.pubkey(), token, 60),
    )
    .expect("session key deposit(60)");

    let user_mint = svm.get_account(&fx.user_mint).expect("UserMint");
    let session = svm.get_account(&fx.session).expect("Session");
    assert_eq!(read_u64(&user_mint.data, 72), 60, "reserved");
    assert_eq!(read_u64(&session.data, 104), 60, "remaining");

    svm.expire_blockhash();
    send_ix(
        &mut svm,
        &fx.session_kp,
        charge_ix(&fx, fx.session_kp.pubkey(), token, 20),
    )
    .expect("session key charge(20)");

    assert_eq!(token_amount(&svm, &fx.user_eata), 80, "user eATA");
    assert_eq!(token_amount(&svm, &fx.merchant_eata), 20, "merchant eATA");
    let session = svm.get_account(&fx.session).expect("Session");
    let user_mint = svm.get_account(&fx.user_mint).expect("UserMint");
    assert_eq!(read_u64(&session.data, 104), 40, "remaining");
    assert_eq!(read_u64(&user_mint.data, 72), 40, "reserved");
}

#[test]
fn session_token_for_different_authority_cannot_charge() {
    let (mut svm, wallet) = setup();
    let fx = fixture(&mut svm, wallet, 70, 70);

    let other = Keypair::new();
    let other_session = Keypair::new();
    svm.airdrop(&other_session.pubkey(), 10_000_000_000)
        .expect("airdrop foreign session key");
    let token = write_user_session_token(&mut svm, other_session.pubkey(), other.pubkey());

    let logs = send_ix(
        &mut svm,
        &other_session,
        charge_ix(&fx, other_session.pubkey(), token, 20),
    )
    .expect_err("foreign session token must not charge");
    assert_auth_rejected(&logs);
}

#[test]
fn merchant_cannot_withdraw_even_with_token() {
    let (mut svm, wallet) = setup();
    let fx = fixture(&mut svm, wallet, 30, 30);
    let token = write_user_session_token(&mut svm, fx.session_kp.pubkey(), fx.merchant);

    let logs = send_ix(
        &mut svm,
        &fx.session_kp,
        withdraw_ix(&fx, fx.session_kp.pubkey(), token, 40),
    )
    .expect_err("merchant session token must not withdraw");
    assert_auth_rejected(&logs);
}

#[test]
fn merchant_cannot_close_session_even_with_token() {
    let (mut svm, wallet) = setup();
    install_magic_stubs(&mut svm);
    let fx = fixture(&mut svm, wallet, 30, 30);
    let token = write_user_session_token(&mut svm, fx.session_kp.pubkey(), fx.merchant);

    let logs = send_ix(
        &mut svm,
        &fx.session_kp,
        close_session_ix(&fx, fx.session_kp.pubkey(), token),
    )
    .expect_err("merchant session token must not close_session");
    assert_auth_rejected(&logs);
}
