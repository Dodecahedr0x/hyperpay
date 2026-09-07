#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::ephemeral_accounts;
use session_keys::{session_auth_or, SessionError, SessionTokenV2};

pub mod accounting;
pub mod errors;
pub mod state;

use errors::*;
use state::*;

declare_id!("Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU");

pub(crate) fn apply_deposit(
    user_mint: &mut UserMint,
    session: &mut Session,
    eata_balance: u64,
    amount: u64,
) -> Result<()> {
    user_mint.reserved = crate::accounting::reserve(eata_balance, user_mint.reserved, amount)
        .map_err(HyperpayError::from)?;
    session.remaining = session
        .remaining
        .checked_add(amount)
        .ok_or(HyperpayError::Overflow)?;
    Ok(())
}

pub(crate) fn apply_close_session(user_mint: &mut UserMint, session: &mut Session) -> Result<()> {
    user_mint.reserved = user_mint
        .reserved
        .checked_sub(session.remaining)
        .ok_or(HyperpayError::Overflow)?;
    session.remaining = 0;
    Ok(())
}

pub(crate) fn apply_close_missing_user_mint(session: &Session) -> Result<()> {
    require!(session.remaining == 0, HyperpayError::Overflow);
    Ok(())
}

fn store_program_account<T: AccountSerialize>(info: &AccountInfo, value: &T) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    value.try_serialize(&mut &mut data[..])
}

fn load_program_account<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    let data = info.try_borrow_data()?;
    T::try_deserialize(&mut &data[..])
}

fn is_uninitialized(info: &AccountInfo) -> Result<bool> {
    let data = info.try_borrow_data()?;
    Ok(data.iter().take(8).all(|byte| *byte == 0))
}

#[program]
pub mod hyperpay {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }

    pub fn init_user(ctx: Context<InitUser>, lamports: u64) -> Result<()> {
        require!(lamports > 0, HyperpayError::AmountZero);
        let user = &mut ctx.accounts.user;
        user.authority = ctx.accounts.authority.key();
        user.bump = ctx.bumps.user;
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.authority.key(),
            &user.key(),
            lamports,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    #[session_auth_or(
        ctx.accounts.signer.key() == ctx.accounts.user.authority,
        HyperpayError::Unauthorized
    )]
    pub fn fund_user(ctx: Context<FundUser>, lamports: u64) -> Result<()> {
        require!(lamports > 0, HyperpayError::AmountZero);
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.signer.key(),
            &ctx.accounts.user.key(),
            lamports,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.signer.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    #[session_auth_or(
        ctx.accounts.signer.key() == ctx.accounts.user.authority,
        HyperpayError::Unauthorized
    )]
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        apply_deposit(
            &mut ctx.accounts.user_mint,
            &mut ctx.accounts.session,
            ctx.accounts.user_eata.amount,
            amount,
        )
    }

    #[session_auth_or(
        ctx.accounts.signer.key() == ctx.accounts.user.authority,
        HyperpayError::Unauthorized
    )]
    pub fn open_session(ctx: Context<OpenSession>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.session.data_len() == 0,
            HyperpayError::SessionAlreadyOpen
        );
        ctx.accounts
            .create_ephemeral_session((8 + Session::INIT_SPACE) as u32)?;
        store_program_account(
            &ctx.accounts.session.to_account_info(),
            &Session {
                user: ctx.accounts.user.key(),
                merchant: ctx.accounts.merchant.key(),
                mint: ctx.accounts.mint.key(),
                remaining: 0,
                bump: ctx.bumps.session,
            },
        )?;

        if amount > 0 {
            ctx.accounts
                .init_if_needed_ephemeral_user_mint((8 + UserMint::INIT_SPACE) as u32)?;
            if is_uninitialized(&ctx.accounts.user_mint.to_account_info())? {
                store_program_account(
                    &ctx.accounts.user_mint.to_account_info(),
                    &UserMint {
                        user: ctx.accounts.user.key(),
                        mint: ctx.accounts.mint.key(),
                        reserved: 0,
                        bump: ctx.bumps.user_mint,
                    },
                )?;
            }
            let mut user_mint =
                load_program_account::<UserMint>(&ctx.accounts.user_mint.to_account_info())?;
            let mut session =
                load_program_account::<Session>(&ctx.accounts.session.to_account_info())?;
            apply_deposit(
                &mut user_mint,
                &mut session,
                ctx.accounts.user_eata.amount,
                amount,
            )?;
            store_program_account(&ctx.accounts.user_mint.to_account_info(), &user_mint)?;
            store_program_account(&ctx.accounts.session.to_account_info(), &session)?;
        }
        Ok(())
    }

    #[session_auth_or(
        ctx.accounts.signer.key() == ctx.accounts.user.authority
            || ctx.accounts.signer.key() == ctx.accounts.session.merchant,
        HyperpayError::Unauthorized
    )]
    pub fn charge(ctx: Context<Charge>, amount: u64) -> Result<()> {
        let new_remaining =
            crate::accounting::debit_remaining(ctx.accounts.session.remaining, amount)
                .map_err(HyperpayError::from)?;
        let new_reserved = ctx
            .accounts
            .user_mint
            .reserved
            .checked_sub(amount)
            .ok_or(HyperpayError::Overflow)?;

        let bump = [ctx.accounts.user.bump];
        let signer_seeds = [
            USER_SEED,
            ctx.accounts.user.authority.as_ref(),
            bump.as_ref(),
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_eata.to_account_info(),
                    to: ctx.accounts.merchant_eata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
                &[&signer_seeds],
            ),
            amount,
        )?;

        ctx.accounts.session.remaining = new_remaining;
        ctx.accounts.user_mint.reserved = new_reserved;
        Ok(())
    }

    #[session_auth_or(
        ctx.accounts.signer.key() == ctx.accounts.user.authority,
        HyperpayError::Unauthorized
    )]
    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> {
        let mut session = load_program_account::<Session>(&ctx.accounts.session.to_account_info())?;
        require_keys_eq!(session.user, ctx.accounts.user.key());
        require_keys_eq!(session.merchant, ctx.accounts.merchant.key());
        require_keys_eq!(session.mint, ctx.accounts.mint.key());

        if is_uninitialized(&ctx.accounts.user_mint.to_account_info())? {
            apply_close_missing_user_mint(&session)?;
            ctx.accounts.close_ephemeral_session()?;
            return Ok(());
        }

        let mut user_mint =
            load_program_account::<UserMint>(&ctx.accounts.user_mint.to_account_info())?;
        require_keys_eq!(user_mint.user, ctx.accounts.user.key());
        require_keys_eq!(user_mint.mint, ctx.accounts.mint.key());

        apply_close_session(&mut user_mint, &mut session)?;
        store_program_account(&ctx.accounts.user_mint.to_account_info(), &user_mint)?;

        ctx.accounts.close_ephemeral_session()?;
        if user_mint.reserved == 0 {
            ctx.accounts.close_ephemeral_user_mint()?;
        }
        Ok(())
    }

    #[session_auth_or(
        ctx.accounts.signer.key() == ctx.accounts.user.authority,
        HyperpayError::Unauthorized
    )]
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, HyperpayError::AmountZero);
        let reserved = if is_uninitialized(&ctx.accounts.user_mint.to_account_info())? {
            0
        } else {
            let user_mint =
                load_program_account::<UserMint>(&ctx.accounts.user_mint.to_account_info())?;
            require_keys_eq!(user_mint.user, ctx.accounts.user.key());
            require_keys_eq!(user_mint.mint, ctx.accounts.mint.key());
            user_mint.reserved
        };
        let available = crate::accounting::available(ctx.accounts.user_eata.amount, reserved);
        require!(amount <= available, HyperpayError::InsufficientAvailable);

        let bump = [ctx.accounts.user.bump];
        let signer_seeds = [
            USER_SEED,
            ctx.accounts.user.authority.as_ref(),
            bump.as_ref(),
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_eata.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
                &[&signer_seeds],
            ),
            amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

#[derive(Accounts)]
pub struct InitUser<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + User::INIT_SPACE,
        seeds = [USER_SEED, authority.key().as_ref()],
        bump
    )]
    pub user: Account<'info, User>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts, session_keys::Session)]
pub struct FundUser<'info> {
    #[account(
        mut,
        seeds = [USER_SEED, user.authority.as_ref()],
        bump = user.bump
    )]
    pub user: Account<'info, User>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
    #[session(signer = signer, authority = user.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[derive(Accounts, session_keys::Session)]
pub struct Deposit<'info> {
    #[account(
        seeds = [USER_SEED, user.authority.as_ref()],
        bump = user.bump
    )]
    pub user: Account<'info, User>,
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [USER_MINT_SEED, user.key().as_ref(), mint.key().as_ref()],
        bump = user_mint.bump,
        constraint = user_mint.user == user.key(),
        constraint = user_mint.mint == mint.key()
    )]
    pub user_mint: Account<'info, UserMint>,
    #[account(
        mut,
        seeds = [SESSION_SEED, user.key().as_ref(), merchant.key().as_ref(), mint.key().as_ref()],
        bump = session.bump,
        constraint = session.user == user.key(),
        constraint = session.mint == mint.key()
    )]
    pub session: Account<'info, Session>,
    /// CHECK: merchant is a session seed only; deposit is authorized by the user.
    pub merchant: UncheckedAccount<'info>,
    /// CHECK: mint is pinned by PDA seeds and the eATA token::mint constraint.
    pub mint: UncheckedAccount<'info>,
    #[account(
        token::authority = user,
        token::mint = mint
    )]
    pub user_eata: Account<'info, TokenAccount>,
    #[session(signer = signer, authority = user.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[ephemeral_accounts]
#[derive(Accounts, session_keys::Session)]
pub struct OpenSession<'info> {
    #[account(
        mut,
        sponsor,
        seeds = [USER_SEED, user.authority.as_ref()],
        bump = user.bump
    )]
    pub user: Account<'info, User>,
    pub signer: Signer<'info>,
    /// CHECK: ephemeral session PDA created via create_ephemeral_session.
    #[account(
        mut,
        eph,
        seeds = [SESSION_SEED, user.key().as_ref(), merchant.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub session: UncheckedAccount<'info>,
    /// CHECK: ephemeral UserMint PDA; created on first deposit for this mint.
    #[account(
        mut,
        eph,
        seeds = [USER_MINT_SEED, user.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub user_mint: UncheckedAccount<'info>,
    /// CHECK: merchant is a session seed only; the user is the signer.
    pub merchant: UncheckedAccount<'info>,
    /// CHECK: mint is pinned by PDA seeds and the eATA token::mint constraint.
    pub mint: UncheckedAccount<'info>,
    #[account(
        token::authority = user,
        token::mint = mint
    )]
    pub user_eata: Account<'info, TokenAccount>,
    #[session(signer = signer, authority = user.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[derive(Accounts, session_keys::Session)]
pub struct Charge<'info> {
    #[account(
        seeds = [USER_SEED, user.authority.as_ref()],
        bump = user.bump
    )]
    pub user: Account<'info, User>,
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [USER_MINT_SEED, user.key().as_ref(), mint.key().as_ref()],
        bump = user_mint.bump,
        constraint = user_mint.user == user.key(),
        constraint = user_mint.mint == mint.key()
    )]
    pub user_mint: Account<'info, UserMint>,
    #[account(
        mut,
        seeds = [SESSION_SEED, user.key().as_ref(), merchant.key().as_ref(), mint.key().as_ref()],
        bump = session.bump,
        constraint = session.user == user.key(),
        constraint = session.merchant == merchant.key(),
        constraint = session.mint == mint.key()
    )]
    pub session: Account<'info, Session>,
    /// CHECK: merchant is pinned by session seeds and merchant_eata token::authority.
    pub merchant: UncheckedAccount<'info>,
    /// CHECK: mint is pinned by PDA seeds and the eATA token::mint constraints.
    pub mint: UncheckedAccount<'info>,
    #[account(
        mut,
        token::authority = user,
        token::mint = mint
    )]
    pub user_eata: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::authority = session.merchant,
        token::mint = session.mint
    )]
    pub merchant_eata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    #[session(signer = signer, authority = user.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[ephemeral_accounts]
#[derive(Accounts, session_keys::Session)]
pub struct CloseSession<'info> {
    #[account(
        mut,
        sponsor,
        seeds = [USER_SEED, user.authority.as_ref()],
        bump = user.bump
    )]
    pub user: Account<'info, User>,
    pub signer: Signer<'info>,
    /// CHECK: ephemeral session PDA closed via close_ephemeral_session.
    #[account(
        mut,
        eph,
        seeds = [SESSION_SEED, user.key().as_ref(), merchant.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub session: UncheckedAccount<'info>,
    /// CHECK: ephemeral UserMint PDA; closed when reserved hits zero.
    #[account(
        mut,
        eph,
        seeds = [USER_MINT_SEED, user.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub user_mint: UncheckedAccount<'info>,
    /// CHECK: merchant is a session seed only; close is authorized by the user.
    pub merchant: UncheckedAccount<'info>,
    /// CHECK: mint is pinned by PDA seeds.
    pub mint: UncheckedAccount<'info>,
    #[session(signer = signer, authority = user.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[derive(Accounts, session_keys::Session)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [USER_SEED, user.authority.as_ref()],
        bump = user.bump
    )]
    pub user: Account<'info, User>,
    pub signer: Signer<'info>,
    /// CHECK: optional; missing or uninitialized UserMint means reserved = 0.
    #[account(
        seeds = [USER_MINT_SEED, user.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub user_mint: UncheckedAccount<'info>,
    /// CHECK: mint is pinned by PDA seeds and the eATA token::mint constraints.
    pub mint: UncheckedAccount<'info>,
    #[account(
        mut,
        token::authority = user,
        token::mint = mint
    )]
    pub user_eata: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint
    )]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    #[session(signer = signer, authority = user.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

#[cfg(test)]
mod apply_deposit_tests {
    use super::*;

    fn user_mint(reserved: u64) -> UserMint {
        UserMint {
            user: Pubkey::default(),
            mint: Pubkey::default(),
            reserved,
            bump: 255,
        }
    }

    fn session(remaining: u64) -> Session {
        Session {
            user: Pubkey::default(),
            merchant: Pubkey::default(),
            mint: Pubkey::default(),
            remaining,
            bump: 255,
        }
    }

    #[test]
    fn apply_deposit_sets_reserved_and_remaining() {
        let mut user_mint = user_mint(0);
        let mut session = session(0);
        apply_deposit(&mut user_mint, &mut session, 100, 60).unwrap();
        assert_eq!(user_mint.reserved, 60);
        assert_eq!(session.remaining, 60);
    }

    #[test]
    fn apply_deposit_rejects_zero() {
        let mut user_mint = user_mint(0);
        let mut session = session(0);
        assert!(apply_deposit(&mut user_mint, &mut session, 100, 0).is_err());
    }

    #[test]
    fn apply_deposit_rejects_above_available() {
        let mut user_mint = user_mint(0);
        let mut session = session(0);
        assert!(apply_deposit(&mut user_mint, &mut session, 100, 101).is_err());
    }

    #[test]
    fn apply_close_session_unreserves_remaining() {
        let mut user_mint = user_mint(30);
        let mut session = session(30);
        apply_close_session(&mut user_mint, &mut session).unwrap();
        assert_eq!(user_mint.reserved, 0);
        assert_eq!(session.remaining, 0);
    }

    #[test]
    fn apply_close_session_leaves_other_reservations() {
        let mut user_mint = user_mint(50);
        let mut session = session(30);
        apply_close_session(&mut user_mint, &mut session).unwrap();
        assert_eq!(user_mint.reserved, 20);
        assert_eq!(session.remaining, 0);
    }

    #[test]
    fn apply_close_session_rejects_remaining_above_reserved() {
        let mut user_mint = user_mint(20);
        let mut session = session(30);
        assert!(apply_close_session(&mut user_mint, &mut session).is_err());
    }

    #[test]
    fn apply_close_missing_user_mint_allows_zero_remaining() {
        let session = session(0);
        apply_close_missing_user_mint(&session).unwrap();
    }

    #[test]
    fn apply_close_missing_user_mint_rejects_remaining() {
        let session = session(30);
        assert!(apply_close_missing_user_mint(&session).is_err());
    }
}
