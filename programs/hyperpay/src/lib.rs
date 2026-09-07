#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod accounting;
pub mod errors;
pub mod state;

use errors::*;
use state::*;

declare_id!("Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU");

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
