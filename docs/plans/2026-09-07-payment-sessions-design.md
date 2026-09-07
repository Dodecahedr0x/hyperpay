# HyperPay payment sessions — design

**Date:** 2026-09-07
**Goal:** Replace the Payments API client with a Solana program that holds user funds and merchant payment sessions on MagicBlock ephemeral rollups.

HyperPay is no longer a wrapper around `https://payments.magicblock.app`. It is a program plus a client that builds, signs, and submits that program’s instructions. P2P `pay()`, stealth handles, and `visibility` go away.

## Decisions

| Question | Choice |
|---|---|
| P2P `pay()` / stealth handles | Dropped |
| Who signs `charge` | Merchant, user wallet, or user’s [session key](https://docs.magicblock.gg/pages/tools/session-keys/introduction) |
| Where tokens live | eATA owned by the User PDA ([eSPL](https://docs.magicblock.gg/pages/ephemeral-spl-token/overview)) |
| Session uniqueness | At most one open session per `(user, merchant, mint)` |
| Isolation | Reservation: `session.remaining` plus per-mint `reserved`; tokens stay in the eATA |

## Accounts

Three HyperPay accounts. The eATA belongs to eSPL, not this program.

**User** — durable PDA `[b"user", wallet]`. Created on base, funded with lamports, delegated to the ER. Sponsor for ephemeral accounts. Authority of the user’s token accounts. Only this program can sign as that PDA, so tokens leave the eATA only through HyperPay.

**UserMint** — ephemeral PDA `[b"user_mint", user, mint]`, sponsored by User. Holds `reserved: u64`. One per mint. Created on first deposit, closed when `reserved == 0`.

**Session** — ephemeral PDA `[b"session", user, merchant, mint]`, sponsored by User. One open session per triple. Holds `user`, `merchant`, `mint`, `remaining`. Closed by `close_session`; rent returns to User.

**eATA** — eSPL `[owner, mint]` with `owner = User`. Top-up does not go through HyperPay: on base, eSPL shuttle / `DepositSplTokens` credits this eATA; on the ER, a transfer from a delegated ATA does the same.

`available = eATA.balance - reserved`. Deposit may not exceed `available`.

Session keys are MagicBlock `SessionToken`s, not HyperPay accounts. They are passed in on user-authorized instructions. Scope is this program.

## Instructions

Wallet-only, once: `init_user` creates the User PDA and funds it. Delegation to the ER is a client CPI to MagicBlock, not a HyperPay instruction. `open_session` fails if User is not delegated.

User wallet **or** a session token whose authority is that wallet (`session_auth_or`):

| Instruction | Effect |
|---|---|
| `fund_user` | Lamports onto User (ephemeral rent) |
| `open_session(merchant, mint, amount)` | Create the ephemeral Session; if `amount > 0`, same as deposit. Fails if a session already exists for the triple |
| `deposit(amount)` | Require `amount > 0` and `amount <= available`; `remaining += amount`, `reserved += amount`. Creates UserMint if needed |
| `withdraw(amount)` | Unreserved only (`amount <= available`); CPI eSPL transfer/withdraw from the user eATA. Does not touch any session |
| `close_session` | `reserved -= remaining`, `remaining = 0`, close Session (rent to User). Close UserMint if `reserved == 0` |

`charge(amount)` — signer is the merchant, the user wallet, **or** the user’s session token:

- `amount > 0`, `amount <= remaining`, and the eSPL transfer User eATA → merchant eATA must succeed
- Then `remaining -= amount`, `reserved -= amount`
- Merchant eATA must already exist; the client initializes it

Merchant cannot `withdraw` or `close_session`. A session token cannot debit another merchant’s session or move unreserved funds except via `withdraw` / `close_session`.

## Data flow

**Setup (base, wallet once).** `init_user` → transfer lamports onto User → delegate User to the ER. Initialize the user eATA (`owner = User`) and shuttle-deposit from the wallet ATA into the Global Vault (or, on the ER, transfer from an already-delegated ATA into that eATA).

**Open (ER, wallet or session key).** `open_session` creates the Session (User pays rent) and optionally reserves. Tokens stay in the eATA; only `reserved` / `remaining` move.

**Charge (ER).** Merchant server or the user’s session key submits `charge`. Program PDA-signs the eSPL transfer, then decrements both counters. No user wallet popup.

**Unwind (ER, user only).** `close_session` unreserves `remaining` and closes the ephemeral account. `withdraw` moves unreserved eATA balance out.

Typical agent path: wallet creates a session token scoped to HyperPay, `open_session` with a deposit, then merchant (or agent with that session key) `charge`s until `remaining` is 0.

## Errors

Fail closed: `AmountZero`, `InsufficientAvailable`, `InsufficientRemaining`, `SessionAlreadyOpen`, `Unauthorized`, plus session-keys `InvalidToken`. eSPL CPI failures surface as-is.

## Tests

Anchor against `solana-test-validator` with session-keys cloned (`KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`). Local ER for ephemeral create/close.

- `open` + `deposit` reserves; second `open` for the same triple fails
- `deposit` above `available` fails; two merchants cannot reserve more than the eATA
- `charge` by merchant and by user session key both transfer and decrement
- wrong merchant / wrong session token / merchant `withdraw` or `close_session` fail
- `close_session` unreserves and refunds rent; `withdraw` cannot take reserved
- `amount = 0` fails

## Client

Drop PaymentsAPI in Rust and TypeScript: no `HYPERPAY_API`, no `pay()`, stealth handles, or `visibility`. The SDK builds, signs, and submits program instructions: `initUser`, `fundUser`, `openSession`, `deposit`, `charge`, `closeSession`, `withdraw`. `sessionBalance` reads `Session.remaining` (and eATA / `reserved` for available). Policy still runs before sign. CLI / MCP / x402 / React retarget to this; they do not keep a parallel API path.

## Non-goals

- Reimplementing eSPL shuttle, private transfers, or a hosted transaction builder
- Session-owned eATAs or a shared vault with allowances
- Multiple concurrent sessions per `(user, merchant, mint)`
- Creating the merchant eATA inside `charge`
