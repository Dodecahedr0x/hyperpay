# Payment Sessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship an Anchor program for user-sponsored merchant payment sessions, then point HyperPay (Rust + TypeScript) at that program and delete PaymentsAPI.

**Architecture:** Durable `User` PDA (lamport sponsor, token authority) plus ephemeral `UserMint` / `Session` accounts on the ER. Tokens stay in an eSPL eATA owned by `User`. `remaining` + `reserved` isolate merchants. `charge` is a PDA-signed SPL/eSPL transfer, authorized by merchant, user wallet, or MagicBlock session token. Client builds those instructions; it does not call `payments.magicblock.app`.

**Tech Stack:** Anchor 1.2.0 + `anchor-spl` 1.2.0 + `ephemeral-rollups-sdk` 0.16.2 (`anchor` feature) + `session-keys` 3.1.1 (`SessionTokenV2`). One Anchor version: 0.16.2 / 3.1.1 pull `anchor-lang` ^1 / `<2`, so the workspace pins 1.2.0 rather than 0.31. Tests: pure unit tests for reservation math, LiteSVM for `init_user` / `fund_user`, local ER for ephemeral create/charge. Clients: existing `crates/hyperpay` and `packages/*`, minus `PaymentsApi`.

**Design:** `docs/plans/2026-09-07-payment-sessions-design.md`

**Worktree:** `/Users/dode/Documents/solana/hyperpay/.worktrees/payment-sessions` on `feature/payment-sessions`

**Security (cite in review):** SOL-006 signer, SOL-008 PDA seeds, SOL-010 no reinit, SOL-014 checked math, SOL-015 constraints, SOL-033 mutate remaining only after CPI, SOL-036 pin eATA/ATA, SOL-037 pin eSPL/token program, SOL-039 never swallow CPI errors.

**@ superpowers:test-driven-development** — no production code without a failing test first.

**@ rs-check** — after each Rust task: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (or `cargo nextest run` if available).

---

### Task 1: Cargo workspace + empty Anchor program

**Files:**
- Create: `Cargo.toml` (workspace)
- Create: `Anchor.toml`
- Create: `programs/hyperpay/Cargo.toml`
- Create: `programs/hyperpay/src/lib.rs`
- Create: `programs/hyperpay/src/accounting.rs`
- Modify: `crates/hyperpay/Cargo.toml` (workspace member, drop independent `[workspace]` if any)
- Modify: `justfile` (add program recipes)
- Modify: `.gitignore` (already has `target/`)

**Step 1: Write the failing accounting test**

Create `programs/hyperpay/src/accounting.rs`:

```rust
//! Reservation math. `available = eata_balance.saturating_sub(reserved)`.

pub fn available(eata_balance: u64, reserved: u64) -> u64 {
    eata_balance.saturating_sub(reserved)
}

pub fn reserve(eata_balance: u64, reserved: u64, amount: u64) -> Result<u64, AccountingError> {
    if amount == 0 {
        return Err(AccountingError::AmountZero);
    }
    let avail = available(eata_balance, reserved);
    if amount > avail {
        return Err(AccountingError::InsufficientAvailable);
    }
    reserved
        .checked_add(amount)
        .ok_or(AccountingError::Overflow)
}

pub fn debit_remaining(remaining: u64, amount: u64) -> Result<u64, AccountingError> {
    if amount == 0 {
        return Err(AccountingError::AmountZero);
    }
    remaining
        .checked_sub(amount)
        .ok_or(AccountingError::InsufficientRemaining)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountingError {
    AmountZero,
    InsufficientAvailable,
    InsufficientRemaining,
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_rejects_zero() {
        assert_eq!(reserve(100, 0, 0), Err(AccountingError::AmountZero));
    }

    #[test]
    fn reserve_rejects_above_available() {
        assert_eq!(reserve(100, 40, 61), Err(AccountingError::InsufficientAvailable));
    }

    #[test]
    fn reserve_increases_reserved() {
        assert_eq!(reserve(100, 40, 60), Ok(100));
    }

    #[test]
    fn two_merchants_cannot_over_allocate() {
        let reserved = reserve(100, 0, 70).unwrap();
        assert_eq!(reserve(100, reserved, 40), Err(AccountingError::InsufficientAvailable));
        assert_eq!(reserve(100, reserved, 30), Ok(100));
    }

    #[test]
    fn debit_rejects_over_remaining() {
        assert_eq!(debit_remaining(50, 51), Err(AccountingError::InsufficientRemaining));
    }

    #[test]
    fn debit_decrements() {
        assert_eq!(debit_remaining(50, 20), Ok(30));
    }
}
```

Create `programs/hyperpay/src/lib.rs`:

```rust
use anchor_lang::prelude::*;

pub mod accounting;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod hyperpay {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
```

**Step 2: Wire workspace so the test can run**

Root `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["crates/hyperpay", "programs/hyperpay"]

[workspace.dependencies]
anchor-lang = "1.2.0"
anchor-spl = "1.2.0"
```

`programs/hyperpay/Cargo.toml`:

```toml
[package]
name = "hyperpay-program"
version = "0.1.2"
edition = "2021"
license = "MIT"

[lib]
crate-name = "hyperpay"
name = "hyperpay"
crate-type = ["cdylib", "lib"]

[features]
default = []
idl-build = ["anchor-lang/idl-build"]
anchor-debug = []

[dependencies]
anchor-lang = { workspace = true }
anchor-spl = { workspace = true }
ephemeral-rollups-sdk = { version = "0.16.2", features = ["anchor"] }
session-keys = { version = "3.1.1", features = ["no-entrypoint"] }
```

`Anchor.toml`:

```toml
[toolchain]
anchor_version = "1.2.0"

[features]
resolution = true
skip-lint = false

[programs.localnet]
hyperpay = "11111111111111111111111111111111"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "cargo test -p hyperpay-program"
```

If `crates/hyperpay/Cargo.toml` has no `[workspace]`, leave it. Workspace membership is enough.

**Step 3: Run test to verify it fails**

Run: `cargo test -p hyperpay-program --lib accounting::tests -- --nocapture`

Expected: FAIL compiling or linking until the crate is a workspace member, then PASS for accounting (the test file is the implementation). First run after adding `lib.rs` without `mod accounting;` should fail with `cannot find type`. Add `mod accounting;` then tests PASS.

Workspace pins Anchor 1.2.0 so it matches session-keys 3.1.1 and ephemeral-rollups-sdk 0.16.2. Do not reintroduce 0.31.

**Step 4: Generate a real program id**

```bash
solana-keygen new --no-bip39-passphrase -o programs/hyperpay/target/deploy/hyperpay-keypair.json
solana address -k programs/hyperpay/target/deploy/hyperpay-keypair.json
```

Replace `declare_id!` and `Anchor.toml` with that pubkey. Add `programs/hyperpay/target/deploy/*.json` is under `target/` (gitignored). Commit a copy at `programs/hyperpay/keypair.json` only if the repo already stores deploy keys; otherwise keep gitignored and put the pubkey in `declare_id!` only.

**Step 5: Commit**

```bash
git add Cargo.toml Anchor.toml programs/hyperpay crates/hyperpay/Cargo.toml justfile
git commit -m "$(cat <<'EOF'
Add hyperpay Anchor program workspace and reservation math.

EOF
)"
```

---

### Task 2: Errors, state, `init_user`

**Files:**
- Create: `programs/hyperpay/src/state.rs`
- Create: `programs/hyperpay/src/errors.rs`
- Modify: `programs/hyperpay/src/lib.rs`
- Create: `programs/hyperpay/tests/init_user.rs`

**Step 1: Write the failing LiteSVM test**

`programs/hyperpay/tests/init_user.rs` — add `litesvm` + `litesvm-loader` or use `solana-program-test`. Prefer LiteSVM if it compiles with Anchor 1.2.0; otherwise `solana-program-test`.

The test must:

1. Airdrop a wallet.
2. Call `init_user` with lamports `1_000_000`.
3. Fetch User PDA `[b"user", wallet]` and assert `authority == wallet`, `bump` matches, lamports >= 1_000_000 + rent.

Expected first run: FAIL `init_user` not found.

**Step 2: Implement state + errors + `init_user`**

`errors.rs`:

```rust
use anchor_lang::prelude::*;

#[error_code]
pub enum HyperpayError {
    #[msg("amount must be greater than zero")]
    AmountZero,
    #[msg("not enough unreserved eATA balance")]
    InsufficientAvailable,
    #[msg("session remaining is too small")]
    InsufficientRemaining,
    #[msg("a session already exists for this user, merchant, and mint")]
    SessionAlreadyOpen,
    #[msg("signer is not allowed")]
    Unauthorized,
    #[msg("user account is not delegated to an ephemeral rollup")]
    UserNotDelegated,
    #[msg("arithmetic overflow")]
    Overflow,
}
```

`state.rs`:

```rust
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
```

`init_user` in `lib.rs`:

```rust
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
```

Map `AccountingError` to `HyperpayError` in one `From` impl.

**Step 3: Run test**

`cargo test -p hyperpay-program --test init_user`

Expected: PASS. Second `init_user` must fail (Anchor `init` / SOL-010).

**Step 4: Commit**

```bash
git add programs/hyperpay
git commit -m "$(cat <<'EOF'
Add User PDA init_user instruction.

EOF
)"
```

---

### Task 3: `fund_user`

**Files:**
- Modify: `programs/hyperpay/src/lib.rs`
- Modify: `programs/hyperpay/tests/init_user.rs`

**Step 1: Failing test** — after `init_user`, `fund_user(500_000)` increases User lamports by 500_000. Wallet signer required. Zero amount fails.

**Step 2: Implement** — `system_instruction::transfer` into User. `has_one = authority` on User (SOL-015). Optional `session_token: Option<Account<SessionTokenV2>>` with `#[session]` / `session_auth_or` so a session key can fund later; for this task wallet-only is enough if adding session-keys to this ix now is a compile fight — then add the macros in Task 7.

**Step 3: Test PASS. Commit.**

```bash
git commit -m "$(cat <<'EOF'
Add fund_user to top up the User PDA.

EOF
)"
```

---

### Task 4: `open_session` + `deposit` (reservation only)

On local LiteSVM, ephemeral accounts cannot be created (no magic program). Implement the instruction with `#[ephemeral_accounts]`, and test reservation via **unit tests plus a LiteSVM fixture that writes pre-serialized Session/UserMint accounts owned by the program** only if create cannot run. Prefer:

- Unit tests already cover reserve math.
- A test helper `apply_deposit(user_mint, session, eata_balance, amount)` used by the instruction.
- LiteSVM test: construct User, UserMint, Session, a token account owned by User with amount 100, call `deposit(60)`, assert `reserved == 60`, `remaining == 60`. Skip `create_ephemeral_*` in LiteSVM; mark `open_session` ER tests `#[ignore = "needs local ER"]`.

**Files:**
- Modify: `programs/hyperpay/src/lib.rs`
- Create: `programs/hyperpay/tests/deposit.rs`

**Step 1: Failing LiteSVM deposit test** (accounts already exist, owned by program, correct discriminators).

**Step 2: Implement**

Read eATA as `Account<'info, TokenAccount>` with `token::authority = user`, `token::mint = mint` (SOL-036). If ER projection uses a different layout, switch to eSPL account and read `amount` via `e-token-api` — do not guess; check `e-token-api` once.

```rust
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let new_reserved = crate::accounting::reserve(
        ctx.accounts.user_eata.amount,
        ctx.accounts.user_mint.reserved,
        amount,
    )
    .map_err(HyperpayError::from)?;
    ctx.accounts.user_mint.reserved = new_reserved;
    ctx.accounts.session.remaining = ctx
        .accounts
        .session
        .remaining
        .checked_add(amount)
        .ok_or(HyperpayError::Overflow)?;
    Ok(())
}
```

Constraints: `session.user == user.key()`, `session.merchant` unchecked on deposit (user is signer), `session.mint == mint.key()`, `user_mint.user == user.key()`, `user_mint.mint == mint.key()`. Seeds on all three PDAs (SOL-008).

`open_session` on ER:

```rust
ctx.accounts.create_ephemeral_session((8 + Session::INIT_SPACE) as u32)?;
// serialize Session { user, merchant, mint, remaining: 0, bump }
if amount > 0 {
    deposit_inner(...)?;
}
```

`User` is `sponsor`. Session field is `AccountInfo` with `eph` (cannot combine `eph` + `init`). Fail if data_len != 0 (`SessionAlreadyOpen`).

**Step 3: Tests.** `deposit` above available fails. Two sessions: second deposit that would exceed eATA fails. `amount = 0` fails.

**Step 4: Commit.**

```bash
git commit -m "$(cat <<'EOF'
Reserve session remaining against the user eATA.

EOF
)"
```

---

### Task 5: `charge`

**Files:**
- Modify: `programs/hyperpay/src/lib.rs`
- Create: `programs/hyperpay/tests/charge.rs`

**Step 1: Failing test** — User eATA 100, reserved 70, remaining 70. Merchant signs `charge(20)`. After: user eATA 80, merchant eATA 20, remaining 50, reserved 50.

**Step 2: Implement**

Auth (wallet path first; session token in Task 7):

```rust
require!(
    ctx.accounts.signer.key() == ctx.accounts.session.merchant
        || ctx.accounts.signer.key() == ctx.accounts.user.authority,
    HyperpayError::Unauthorized
);
```

Order (SOL-033, SOL-039):

1. `debit_remaining(session.remaining, amount)?`
2. CPI `token::transfer` User eATA → merchant eATA, `CpiContext::new_with_signer` with `&[USER_SEED, user.authority.as_ref(), &[user.bump]]`. Pin `token_program` (SOL-037). `?` the CPI.
3. Only then write `session.remaining` and `user_mint.reserved -= amount` (checked_sub).

Merchant eATA: `token::authority = session.merchant`, `token::mint = session.mint`. Do not create it.

Wrong merchant signer fails. `amount > remaining` fails.

**Step 3: Test PASS. Commit.**

```bash
git commit -m "$(cat <<'EOF'
Charge transfers from the user eATA and drops remaining.

EOF
)"
```

---

### Task 6: `close_session` + `withdraw`

**Files:**
- Modify: `programs/hyperpay/src/lib.rs`
- Create: `programs/hyperpay/tests/close_withdraw.rs`

**Step 1: Failing tests**

- `close_session`: remaining 30, reserved 30 → reserved 0, session closed (or data zeroed + rent to User). Merchant signer fails (`Unauthorized`).
- `withdraw(40)` with eATA 100, reserved 30 succeeds (unreserved 70). `withdraw(80)` fails `InsufficientAvailable`. Does not change `remaining`.

**Step 2: Implement**

`close_session`: user-only (`session_auth_or` in Task 7). `reserved -= remaining`, `remaining = 0`. `close_ephemeral_session()`. If `reserved == 0`, `close_ephemeral_user_mint()`.

`withdraw`: user-only. `amount <= available`. PDA-signed token transfer User eATA → `destination` (same mint). No session accounts required.

**Step 3: Test PASS. Commit.**

```bash
git commit -m "$(cat <<'EOF'
Close sessions to unreserve and withdraw unreserved tokens.

EOF
)"
```

---

### Task 7: Session keys

**Files:**
- Modify: `programs/hyperpay/src/lib.rs`
- Create: `programs/hyperpay/tests/session_keys.rs`

Use `SessionTokenV2` (session-keys 3.1). Derive `Session` on `Deposit`, `OpenSession`, `FundUser`, `CloseSession`, `Withdraw`, `Charge`.

```rust
#[session(signer = signer, authority = user.authority.key())]
pub session_token: Option<Account<'info, SessionTokenV2>>,
```

```rust
#[session_auth_or(
    ctx.accounts.signer.key() == ctx.accounts.user.authority
        || ctx.accounts.signer.key() == ctx.accounts.session.merchant, // charge only
    HyperpayError::Unauthorized
)]
```

On user-only ix, the `|| merchant` clause **must not** be present.

**Step 1: Failing tests** (clone session-keys `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` in LiteSVM if dump exists; otherwise `#[ignore]` with comment to dump from devnet).

- User session key can `deposit` and `charge`.
- Session token for a different authority cannot `charge`.
- Merchant cannot `withdraw` / `close_session` even with a token.

**Step 2: Implement macros. Test PASS. Commit.**

```bash
git commit -m "$(cat <<'EOF'
Accept MagicBlock session tokens on user and charge instructions.

EOF
)"
```

---

### Task 8: Rust client — delete PaymentsAPI

**Files:**
- Delete: `crates/hyperpay/src/api.rs`
- Modify: `crates/hyperpay/src/lib.rs`, `client.rs`, `engine.rs`, `error.rs`, `Cargo.toml`
- Create: `crates/hyperpay/src/program.rs` (PDA helpers + instruction builders)
- Delete tests that mock `/v1/spl/charge` and `/v1/spl/session-balance`

**Step 1: Failing unit test** for `user_pda(wallet)` / `session_pda(user, merchant, mint)` matching program seeds.

**Step 2: Remove `PaymentsApi`, `HYPERPAY_API`, `pay()`, `Visibility`, `new_ref_id`. Add:

- `init_user`, `fund_user`, `open_session`, `deposit`, `charge`, `close_session`, `withdraw`
- `session_balance` via `getAccountInfo` on Session PDA (JSON-RPC already in `engine.rs`)
- Keep `Policy` before sign
- `sign_and_submit` takes a client-built `VersionedTransaction`, not `BuildResponse`

Drop `reqwest` wiremock API tests. Keep engine confirm tests if they still apply.

**Step 3: `cargo test --manifest-path crates/hyperpay/Cargo.toml` PASS. Clippy. Commit.**

```bash
git commit -m "$(cat <<'EOF'
Point the Rust client at the hyperpay program and drop PaymentsAPI.

EOF
)"
```

---

### Task 9: TypeScript client — delete PaymentsAPI

**Files:**
- Delete or gut: `packages/core/src/api.ts`
- Modify: `packages/core/src/client.ts`, `exports.ts`, `packages/types/src/api.ts`, `packages/types/src/index.ts`
- Modify: `packages/solana/src/engine.ts` as needed
- Replace: `test/unit/charge.test.ts`
- Modify: `packages/hyperpay/src/cli.ts`, `mcp.ts`, `core.ts`
- Modify: `packages/x402/src/index.ts`, `packages/react/src/*` (`pay` → `charge` / `openSession` where those UIs still make sense; PayButton that P2P-pays is out of scope — retarget to `openSession`/`charge` or remove P2P copy)
- Modify: `README.md`, package READMEs, `examples/*`, `.env.example`

**Step 1: Failing test** — `sessionPda` / `userPda` match Rust; `HyperPay` has no `PaymentsApi` and no `pay`.

**Step 2: Implement instruction builders (Anchor IDL once `anchor build` exists). `sessionBalance` reads account data. Remove `HYPERPAY_API`, stealth, visibility, login/challenge.

x402: merchant `charge` against a session the user already opened. If that is too large for this task, make x402 call `charge` and document that the user must `openSession` first — do not keep a transfer API fallback.

**Step 3:** `npm test && npm run typecheck` PASS.

**Step 4: Commit.**

```bash
git commit -m "$(cat <<'EOF'
Point the TypeScript SDK at the hyperpay program and drop PaymentsAPI.

EOF
)"
```

---

### Task 10: Docs, justfile, program scan

**Files:**
- Modify: `README.md`, `docs/plans/2026-08-11-hyperpay-design.md` (note superseded)
- Modify: `justfile` (`test-program`, `build-program`)
- Scan `programs/hyperpay/src/lib.rs` with Solana Security Standard `scan_solana_code`

**Step 1:** README shows `initUser` / `openSession` / `charge`, not `pay('alice@magicblock.id')`.

**Step 2:** `@ rs-check` on the program + crate.

**Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
Document payment sessions and drop PaymentsAPI from the README.

EOF
)"
```

---

## ER integration (not blocking Tasks 1–9)

When a local ER is available (`mb-test-validator` + `ephemeral-validator`):

- Un-ignore `open_session` create/close tests
- End-to-end: shuttle deposit into User eATA → `open_session` → merchant `charge` → `close_session`

Do not block the client cutover on live ER.

## Out of scope

- Private transfers, stealth handles, hosted builder
- Creating merchant eATA inside `charge`
- Multiple sessions per `(user, merchant, mint)`
