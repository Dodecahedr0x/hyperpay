#![allow(deprecated)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod accounting;

declare_id!("Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU");

#[program]
pub mod hyperpay {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
