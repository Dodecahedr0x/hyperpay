use sha2::{Digest, Sha256};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

pub const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU");
pub const TOKEN_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const ESPL_TOKEN_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
pub const MAGIC_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("Magic11111111111111111111111111111111111111");
pub const EPHEMERAL_VAULT_ID: Pubkey =
    solana_sdk::pubkey!("MagicVau1t999999999999999999999999999999999");

pub const USER_SEED: &[u8] = b"user";
pub const USER_MINT_SEED: &[u8] = b"user_mint";
pub const SESSION_SEED: &[u8] = b"session";

/// `Session.remaining` is a little-endian `u64` after the 8-byte discriminator
/// and three pubkeys (`user`, `merchant`, `mint`).
pub const SESSION_REMAINING_OFFSET: usize = 8 + 32 + 32 + 32;

pub fn user_pda(wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[USER_SEED, wallet.as_ref()], &PROGRAM_ID)
}

pub fn user_mint_pda(user: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[USER_MINT_SEED, user.as_ref(), mint.as_ref()], &PROGRAM_ID)
}

pub fn session_pda(user: &Pubkey, merchant: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            SESSION_SEED,
            user.as_ref(),
            merchant.as_ref(),
            mint.as_ref(),
        ],
        &PROGRAM_ID,
    )
}

/// eSPL eATA: `[owner, mint]` on the eSPL token program.
pub fn eata_pda(owner: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[owner.as_ref(), mint.as_ref()], &ESPL_TOKEN_PROGRAM_ID)
}

pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

fn discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}"));
    hasher.finalize()[..8]
        .try_into()
        .expect("sha256 is 32 bytes")
}

fn ix_data(name: &str, amount: Option<u64>) -> Vec<u8> {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&discriminator(name));
    if let Some(amount) = amount {
        data.extend_from_slice(&amount.to_le_bytes());
    }
    data
}

/// Anchor `Option<Account<_>>`: omit the account by passing the program id.
fn session_token_meta(session_token: Option<Pubkey>) -> AccountMeta {
    AccountMeta::new_readonly(session_token.unwrap_or(PROGRAM_ID), false)
}

pub fn init_user_ix(user: Pubkey, authority: Pubkey, lamports: u64) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(user, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(Pubkey::default(), false),
        ],
        data: ix_data("init_user", Some(lamports)),
    }
}

pub fn fund_user_ix(
    user: Pubkey,
    signer: Pubkey,
    lamports: u64,
    session_token: Option<Pubkey>,
) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(user, false),
            AccountMeta::new(signer, true),
            AccountMeta::new_readonly(Pubkey::default(), false),
            session_token_meta(session_token),
        ],
        data: ix_data("fund_user", Some(lamports)),
    }
}

/// Accounts shared by session instructions (`deposit`, `open_session`, `charge`, `close_session`).
#[derive(Debug, Clone, Copy)]
pub struct SessionAccounts {
    pub user: Pubkey,
    pub signer: Pubkey,
    pub user_mint: Pubkey,
    pub session: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub user_eata: Pubkey,
}

pub fn deposit_ix(
    accounts: &SessionAccounts,
    amount: u64,
    session_token: Option<Pubkey>,
) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.user, false),
            AccountMeta::new_readonly(accounts.signer, true),
            AccountMeta::new(accounts.user_mint, false),
            AccountMeta::new(accounts.session, false),
            AccountMeta::new_readonly(accounts.merchant, false),
            AccountMeta::new_readonly(accounts.mint, false),
            AccountMeta::new_readonly(accounts.user_eata, false),
            session_token_meta(session_token),
        ],
        data: ix_data("deposit", Some(amount)),
    }
}

pub fn open_session_ix(
    accounts: &SessionAccounts,
    amount: u64,
    session_token: Option<Pubkey>,
) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.user, false),
            AccountMeta::new_readonly(accounts.signer, true),
            AccountMeta::new(accounts.session, false),
            AccountMeta::new(accounts.user_mint, false),
            AccountMeta::new_readonly(accounts.merchant, false),
            AccountMeta::new_readonly(accounts.mint, false),
            AccountMeta::new_readonly(accounts.user_eata, false),
            session_token_meta(session_token),
            AccountMeta::new(EPHEMERAL_VAULT_ID, false),
            AccountMeta::new_readonly(MAGIC_PROGRAM_ID, false),
        ],
        data: ix_data("open_session", Some(amount)),
    }
}

pub fn charge_ix(
    accounts: &SessionAccounts,
    merchant_eata: Pubkey,
    amount: u64,
    session_token: Option<Pubkey>,
) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.user, false),
            AccountMeta::new_readonly(accounts.signer, true),
            AccountMeta::new(accounts.user_mint, false),
            AccountMeta::new(accounts.session, false),
            AccountMeta::new_readonly(accounts.merchant, false),
            AccountMeta::new_readonly(accounts.mint, false),
            AccountMeta::new(accounts.user_eata, false),
            AccountMeta::new(merchant_eata, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            session_token_meta(session_token),
        ],
        data: ix_data("charge", Some(amount)),
    }
}

pub fn close_session_ix(accounts: &SessionAccounts, session_token: Option<Pubkey>) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.user, false),
            AccountMeta::new_readonly(accounts.signer, true),
            AccountMeta::new(accounts.session, false),
            AccountMeta::new(accounts.user_mint, false),
            AccountMeta::new_readonly(accounts.merchant, false),
            AccountMeta::new_readonly(accounts.mint, false),
            session_token_meta(session_token),
            AccountMeta::new(EPHEMERAL_VAULT_ID, false),
            AccountMeta::new_readonly(MAGIC_PROGRAM_ID, false),
        ],
        data: ix_data("close_session", None),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WithdrawAccounts {
    pub user: Pubkey,
    pub signer: Pubkey,
    pub user_mint: Pubkey,
    pub mint: Pubkey,
    pub user_eata: Pubkey,
    pub destination: Pubkey,
}

pub fn withdraw_ix(
    accounts: &WithdrawAccounts,
    amount: u64,
    session_token: Option<Pubkey>,
) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.user, false),
            AccountMeta::new_readonly(accounts.signer, true),
            AccountMeta::new_readonly(accounts.user_mint, false),
            AccountMeta::new_readonly(accounts.mint, false),
            AccountMeta::new(accounts.user_eata, false),
            AccountMeta::new(accounts.destination, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            session_token_meta(session_token),
        ],
        data: ix_data("withdraw", Some(amount)),
    }
}

pub fn remaining_from_session_data(data: &[u8]) -> Option<u64> {
    let end = SESSION_REMAINING_OFFSET + 8;
    if data.len() < end {
        return None;
    }
    data[SESSION_REMAINING_OFFSET..end]
        .try_into()
        .ok()
        .map(u64::from_le_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sighash(name: &str) -> [u8; 8] {
        let mut hasher = Sha256::new();
        hasher.update(format!("global:{name}"));
        hasher.finalize()[..8].try_into().unwrap()
    }

    #[test]
    fn user_pda_matches_program_seeds() {
        let wallet = Pubkey::new_unique();
        let (pda, bump) = user_pda(&wallet);
        let (expected, expected_bump) =
            Pubkey::find_program_address(&[b"user", wallet.as_ref()], &PROGRAM_ID);
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn session_pda_matches_program_seeds() {
        let user = Pubkey::new_unique();
        let merchant = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let (pda, bump) = session_pda(&user, &merchant, &mint);
        let (expected, expected_bump) = Pubkey::find_program_address(
            &[b"session", user.as_ref(), merchant.as_ref(), mint.as_ref()],
            &PROGRAM_ID,
        );
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn user_mint_pda_matches_program_seeds() {
        let user = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let (pda, bump) = user_mint_pda(&user, &mint);
        let (expected, expected_bump) = Pubkey::find_program_address(
            &[b"user_mint", user.as_ref(), mint.as_ref()],
            &PROGRAM_ID,
        );
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn eata_pda_matches_espl_seeds() {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let (pda, bump) = eata_pda(&owner, &mint);
        let (expected, expected_bump) =
            Pubkey::find_program_address(&[owner.as_ref(), mint.as_ref()], &ESPL_TOKEN_PROGRAM_ID);
        assert_eq!(pda, expected);
        assert_eq!(bump, expected_bump);
    }

    #[test]
    fn init_user_ix_uses_anchor_discriminator_and_accounts() {
        let authority = Pubkey::new_unique();
        let (user, _) = user_pda(&authority);
        let ix = init_user_ix(user, authority, 1_000_000);
        assert_eq!(ix.program_id, PROGRAM_ID);
        assert_eq!(&ix.data[..8], &sighash("init_user"));
        assert_eq!(&ix.data[8..], &1_000_000u64.to_le_bytes());
        assert_eq!(ix.accounts[0].pubkey, user);
        assert!(ix.accounts[0].is_writable);
        assert_eq!(ix.accounts[1].pubkey, authority);
        assert!(ix.accounts[1].is_signer);
        assert_eq!(ix.accounts[2].pubkey, Pubkey::default());
    }

    #[test]
    fn charge_ix_passes_program_id_when_session_token_is_none() {
        let accounts = SessionAccounts {
            user: Pubkey::new_unique(),
            signer: Pubkey::new_unique(),
            user_mint: Pubkey::new_unique(),
            session: Pubkey::new_unique(),
            merchant: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            user_eata: Pubkey::new_unique(),
        };
        let merchant_eata = Pubkey::new_unique();
        let ix = charge_ix(&accounts, merchant_eata, 20, None);
        assert_eq!(&ix.data[..8], &sighash("charge"));
        assert_eq!(&ix.data[8..], &20u64.to_le_bytes());
        assert_eq!(ix.accounts.last().unwrap().pubkey, PROGRAM_ID);
        assert!(!ix.accounts.last().unwrap().is_signer);
        assert_eq!(ix.accounts[8].pubkey, TOKEN_PROGRAM_ID);
    }

    #[test]
    fn fund_user_ix_uses_program_id_for_missing_session_token() {
        let signer = Pubkey::new_unique();
        let (user, _) = user_pda(&signer);
        let ix = fund_user_ix(user, signer, 500_000, None);
        assert_eq!(&ix.data[..8], &sighash("fund_user"));
        assert_eq!(ix.accounts[3].pubkey, PROGRAM_ID);
    }

    #[test]
    fn remaining_from_session_data_reads_offset_104() {
        let mut data = vec![0u8; 113];
        data[104..112].copy_from_slice(&42_000u64.to_le_bytes());
        assert_eq!(remaining_from_session_data(&data), Some(42_000));
        assert_eq!(remaining_from_session_data(&data[..10]), None);
    }
}
