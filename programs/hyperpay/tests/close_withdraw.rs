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
const TOKEN_ACCOUNT_LEN: usize = 165;
const EATA_BALANCE: u64 = 100;
const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MAGIC_PROGRAM_ID: &str = "Magic11111111111111111111111111111111111111";
const EPHEMERAL_VAULT_ID: &str = "MagicVau1t999999999999999999999999999999999";

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

struct SessionFixture {
    wallet: Keypair,
    merchant_kp: Keypair,
    user: Address,
    user_mint: Address,
    session: Address,
    merchant: Address,
    mint: Address,
    user_eata: Address,
    destination: Address,
}

fn fixture_session(
    svm: &mut LiteSVM,
    wallet: Keypair,
    reserved: u64,
    remaining: u64,
) -> SessionFixture {
    let (user, user_bump) = user_pda(wallet.pubkey());
    let mint = Keypair::new().pubkey();
    let merchant_kp = Keypair::new();
    let merchant = merchant_kp.pubkey();
    svm.airdrop(&merchant, 10_000_000_000)
        .expect("airdrop merchant");
    let (user_mint, user_mint_bump) = user_mint_pda(user, mint);
    let (session, session_bump) = session_pda(user, merchant, mint);
    let user_eata = Keypair::new().pubkey();
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
        destination,
        token_program_id(),
        pack_token_account(mint, wallet.pubkey(), 0),
    );

    SessionFixture {
        wallet,
        merchant_kp,
        user,
        user_mint,
        session,
        merchant,
        mint,
        user_eata,
        destination,
    }
}

fn close_session_ix(fx: &SessionFixture, signer: Address) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(fx.user, false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new(fx.session, false),
            AccountMeta::new(fx.user_mint, false),
            AccountMeta::new_readonly(fx.merchant, false),
            AccountMeta::new_readonly(fx.mint, false),
            AccountMeta::new(ephemeral_vault_id(), false),
            AccountMeta::new_readonly(magic_program_id(), false),
        ],
        data: sighash("close_session").to_vec(),
    }
}

fn withdraw_ix(fx: &SessionFixture, signer: Address, amount: u64) -> Instruction {
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

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

fn token_amount(svm: &LiteSVM, address: &Address) -> u64 {
    let account = svm.get_account(address).expect("token account");
    read_u64(&account.data, 64)
}

fn session_is_closed(svm: &LiteSVM, session: &Address) -> bool {
    match svm.get_account(session) {
        None => true,
        Some(account) => {
            account.lamports == 0
                || account.data.is_empty()
                || account.data.iter().all(|byte| *byte == 0)
        }
    }
}

#[test]
#[ignore = "needs local ER"]
fn close_session_unreserves_and_closes() {
    let (mut svm, wallet) = setup();
    install_magic_stubs(&mut svm);
    let fx = fixture_session(&mut svm, wallet, 30, 30);

    send_ix(
        &mut svm,
        &fx.wallet,
        close_session_ix(&fx, fx.wallet.pubkey()),
    )
    .expect("close_session");

    let user_mint = svm.get_account(&fx.user_mint);
    match user_mint {
        None => {}
        Some(account) if account.lamports == 0 || account.data.iter().all(|byte| *byte == 0) => {}
        Some(account) => {
            assert_eq!(read_u64(&account.data, 72), 0, "reserved");
        }
    }
    assert!(
        session_is_closed(&svm, &fx.session),
        "session should be closed or zeroed"
    );
}

#[test]
fn close_session_rejects_merchant_signer() {
    let (mut svm, wallet) = setup();
    install_magic_stubs(&mut svm);
    let fx = fixture_session(&mut svm, wallet, 30, 30);

    let logs = send_ix(
        &mut svm,
        &fx.merchant_kp,
        close_session_ix(&fx, fx.merchant),
    )
    .expect_err("merchant close_session must fail");
    assert!(
        logs.contains("Unauthorized")
            || logs.contains("signer is not allowed")
            || logs.contains("custom program error: 0x1774"),
        "unexpected merchant close error: {logs}"
    );
}

#[test]
fn withdraw_transfers_unreserved() {
    let (mut svm, wallet) = setup();
    let fx = fixture_session(&mut svm, wallet, 30, 30);

    send_ix(
        &mut svm,
        &fx.wallet,
        withdraw_ix(&fx, fx.wallet.pubkey(), 40),
    )
    .expect("withdraw(40)");

    assert_eq!(token_amount(&svm, &fx.user_eata), 60, "user eATA");
    assert_eq!(token_amount(&svm, &fx.destination), 40, "destination");
    let user_mint = svm.get_account(&fx.user_mint).expect("UserMint");
    assert_eq!(read_u64(&user_mint.data, 72), 30, "reserved unchanged");
}

#[test]
fn withdraw_rejects_above_available() {
    let (mut svm, wallet) = setup();
    let fx = fixture_session(&mut svm, wallet, 30, 30);

    let logs = send_ix(
        &mut svm,
        &fx.wallet,
        withdraw_ix(&fx, fx.wallet.pubkey(), 80),
    )
    .expect_err("withdraw above available must fail");
    assert!(
        logs.contains("InsufficientAvailable")
            || logs.contains("not enough unreserved")
            || logs.contains("custom program error: 0x1771"),
        "unexpected over-available error: {logs}"
    );
}

#[test]
fn withdraw_does_not_change_remaining() {
    let (mut svm, wallet) = setup();
    let fx = fixture_session(&mut svm, wallet, 30, 30);

    send_ix(
        &mut svm,
        &fx.wallet,
        withdraw_ix(&fx, fx.wallet.pubkey(), 40),
    )
    .expect("withdraw(40)");

    let session = svm.get_account(&fx.session).expect("Session");
    assert_eq!(read_u64(&session.data, 104), 30, "remaining unchanged");
}

#[test]
fn withdraw_rejects_merchant_signer() {
    let (mut svm, wallet) = setup();
    let fx = fixture_session(&mut svm, wallet, 30, 30);

    let logs = send_ix(&mut svm, &fx.merchant_kp, withdraw_ix(&fx, fx.merchant, 40))
        .expect_err("merchant withdraw must fail");
    assert!(
        logs.contains("Unauthorized")
            || logs.contains("signer is not allowed")
            || logs.contains("custom program error: 0x1774"),
        "unexpected merchant withdraw error: {logs}"
    );
}
