use anchor_lang::prelude::*;

declare_id!("9dCXhUi1p48KBJo6kPeLExkkXrK6fNswa7Y73F29hXkM");

#[program]
pub mod voting {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
