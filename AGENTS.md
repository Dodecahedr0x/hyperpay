# HyperPay

Payment sessions on Solana. A user opens a session with a merchant; the merchant
`charge`s it. This repo is the Anchor program plus TypeScript and Rust SDKs that
build, sign, and submit those instructions. **There is no hosted payments API.**

Canonical API surface (generated from source): [`docs/reference.md`](docs/reference.md).
Consumer skill: [`examples/ai-skill/SKILL.md`](examples/ai-skill/SKILL.md).

Program id: `Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU`

## Layout

| Path | What |
|---|---|
| `programs/hyperpay` | Anchor program (`User` / `UserMint` / `Session`). Tests under `programs/hyperpay/tests` (LiteSVM). |
| `packages/core` | `HyperPay` client, instruction builders, policy |
| `packages/types` | Amounts + typed errors. No I/O. |
| `packages/solana` | Signers, ATA helpers, submit/confirm |
| `packages/x402` | HTTP 402 paywall + `payingFetch` |
| `packages/react` | Provider, hooks, PayButton / PayModal / PaymentStatus |
| `packages/hyperpay` | Umbrella + CLI + MCP. Re-exports; does not depend on React. |
| `crates/hyperpay` | Same client in Rust. JSON-RPC over reqwest — no `solana-client`. |
| `examples/` | react, x402, metered, openrouter, ai-skill |
| `test/unit` `test/e2e` `test/live` | JS tests. `test/e2e/mb-stack.e2e.test.ts` boots a local MagicBlock stack. |
| `scripts/docs.mjs` | Regenerates `docs/reference.md` and fails CI if docs drift |
| `scripts/version.mjs` | Lockstep versions across npm packages, crates, and lockfiles |
| `docs/plans/` | Historical design/implementation notes. Not the current API. |

`.worktrees/` is gitignored local checkout noise. Do not edit it.

## Commands

```sh
just              # list recipes
just check        # typecheck, JS+Rust unit tests, fmt, clippy, docs-check
just docs         # regenerate docs/reference.md from source
just docs-check   # fail if reference.md or hand-written docs drifted
npm test          # JS unit tests (no network)
just test-rs      # Rust SDK tests
just test-program # program unit tests (reservation math + LiteSVM)
just test-e2e-local  # mb-stack + TS/Rust SDKs (needs mb-stack)
```

Node 18+. `just` is the task runner. Do not add a parallel Makefile.

## Architecture

Tokens sit in an eSPL eATA owned by the User PDA. `UserMint.reserved` +
`Session.remaining` isolate merchants. `charge` is a PDA-signed transfer the
merchant (or the user) authorizes.

| Call | Where it lands |
|---|---|
| `initUser`, `delegateUser` | base cluster |
| `topUp` | base (vault/eATA/SPL deposit + delegate eATA), then `ensure_user_mint` on the ER |
| `openSession`, `deposit`, `charge`, `closeSession`, `withdraw`, `sessionBalance` | ephemeral rollup |
| `balance`, `quote` | base read / local policy check |

`topUp` is SDK-only: it is not a program instruction. It composes eSPL + `ensure_user_mint`.

The user must `openSession` before a merchant can `charge`. Amount may be `0` to
open an empty session. Session keys: pass `authority` (the wallet that owns the
User PDA). Never pass a user's session token to a merchant `charge`.

`fromEnv()` and `{ key }` are Node-only. In the browser, pass `{ signer }` (or
`wallet` to `HyperPayProvider`).

Client-side policy (`HYPERPAY_MAX_PER_TX`, daily cap, allow/deny) runs **before
anything is signed**. It is a blast-radius limiter, not a security boundary.
Fund session keys like prepaid cards. Caps fail closed.

Internal npm deps use `*` (no `workspace:` protocol). Publish every
`packages/*` together.

## Don't invent

These do **not** exist. Do not add them back without an explicit request:

- `pay()`, `waitForCredit()`, `PaymentsApi`, `HYPERPAY_API`
- `InsufficientFundsError`
- A hosted payments HTTP API
- Transfer-API fallback in x402 — the user opens a session; the merchant `charge`s it

Typed errors: `HyperPayError`, `PolicyError`, `ApiError`, `ConfirmationError`,
`ResolutionError`, `SignerError`. Catch `PolicyError` separately — nothing was signed.

## Changing the public API

If you add/rename/remove a program instruction, `HyperPay` method, CLI command,
MCP tool, env var, error class, or package:

1. Update the source of truth (program / client / CLI / MCP).
2. Run `just docs` and commit `docs/reference.md`.
3. Update the narrative if the story changed: `README.md`, package READMEs,
   `examples/ai-skill/SKILL.md`, `.env.example`, CLI `HELP`.
4. `just docs-check` must pass. CI runs it.

Do not hand-edit `docs/reference.md`.

Keep TS and Rust clients aligned. Keep the three program ids identical
(`programs/hyperpay/src/lib.rs`, `packages/core/src/program.ts`,
`crates/hyperpay/src/program.rs`).

## Tests worth knowing

- Amounts/policy/x402: `test/unit/`
- Charge flow: `test/unit/charge.test.ts`
- Export/tree-shake: `test/exports/`
- Version lockstep: `test/unit/version.test.ts`
- Docs freshness: `test/unit/docs.test.ts`
- Program: `programs/hyperpay/tests/*.rs` (`just test-program`)
- Live MCP stdio: `npm run test:live` (needs keys)
- Live devnet: `npm run test:e2e` (`E2E_PAYER_KEY`, `E2E_PAYEE`, `E2E_MINT`)
- Local stack: `npm run test:e2e:local` (`mb-stack`; ephemeral submits skip preflight)

## Style

- Match the file you are in. No new abstraction layers, wrappers, or config
  formats unless the existing ones cannot do the job.
- Do not bump versions or publish unless asked. Versions stay lockstep via
  `just version-align` / `just version-check`.
