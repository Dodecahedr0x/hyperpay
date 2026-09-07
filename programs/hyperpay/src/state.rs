use anchor_lang::prelude::*;

pub const USER_SEED: &[u8] = b"user";
pub const USER_MINT_SEED: &[u8] = b"user_mint";
pub const SESSION_SEED: &[u8] = b"session";

#[account]
#[derive(InitSpace)]
pub struct User {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserMint {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub reserved: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub user: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub remaining: u64,
    pub bump: u8,
}
