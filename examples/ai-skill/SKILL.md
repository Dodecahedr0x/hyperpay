---
name: hyperpay
description: >-
  Set up a HyperPay signer, spend policy, and payment sessions (initUser,
  openSession, then merchant charge). Use when creating a HyperPay account,
  funding the User PDA, opening a session with a merchant pubkey, or running
  the HyperPay CLI/MCP tools.
---

# HyperPay — set up and pay

HyperPay (`@magicblock-labs/hyperpay`) builds, signs, and submits the hyperpay
program (`Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU`). You sign locally.

Typical flow: `initUser` → `fundUser` → (eSPL top-up outside HyperPay) →
`openSession(merchant, amount)` → merchant `charge` → `closeSession` → `withdraw`.

**Always quote, then open or charge.** Never invent methods (`pay`, `waitForCredit`,
`InsufficientFundsError` — they do not exist). There is no hosted Payments API.

## 1. Signer

Create a **session keypair**, not the user's main wallet. JSON byte array is the common format:

```sh
solana-keygen new --no-bip39-passphrase -o ~/.hyperpay/agent.json
```

Reuse `~/.config/solana/id.json` only if that is already a disposable agent key.

```sh
export HYPERPAY_KEY=~/.hyperpay/agent.json   # file path, base58 secret, or JSON array
export HYPERPAY_CLUSTER=devnet               # or mainnet — defaults to mainnet if unset
```

Optional:

| Variable | Meaning |
|---|---|
| `HYPERPAY_RPC` | Base-layer RPC override |
| `HYPERPAY_EPHEMERAL_RPC` | Ephemeral-rollup RPC override |
| `HYPERPAY_TOKEN` | Default symbol (default `USDC`) |
| `HYPERPAY_TOKENS` | Custom mints: `SYMBOL:MINT:DECIMALS,…` |

```sh
npm install @magicblock-labs/hyperpay
```

CLI binary is `hyperpay`. With npx **always include the scope** (`npx @magicblock-labs/hyperpay …`); bare `npx hyperpay` is a different package.

## 2. Policy (unattended agents)

Client-side caps run **before anything is signed**. They limit blast radius; they are not a security boundary — any process with the key can sign without HyperPay. Fund the session key like a prepaid card.

```sh
export HYPERPAY_MAX_PER_TX="25 USDC"
export HYPERPAY_DAILY_CAP="200 USDC"
export HYPERPAY_ALLOW="<merchant pubkey>"
export HYPERPAY_DENY=""                    # checked first; wins over allow
# export HYPERPAY_JOURNAL=~/.hyperpay/spend.json   # default
```

- Caps are `"25 USDC"` or `"25 USDC, 10 USDT"`. Each named token is required.
- Fail closed: a USDC cap refuses a USDT payment rather than waving it through.
- `HYPERPAY_ALLOW` / `HYPERPAY_DENY`: comma-separated; `*` wildcards. Pubkeys match exactly (Base58 is case-sensitive).
- Daily spend journals to `HYPERPAY_JOURNAL` (default `~/.hyperpay/spend.json`) and survives restarts.
- When the signer is a session key, pass `authority` (the wallet that owns the User PDA).

## 3. Init, fund, open a session

`initUser` / `fundUser` put lamports in the User PDA on the base cluster. Token
balance lives in the User eATA (eSPL top-up is outside HyperPay). `openSession`
reserves that eATA against a merchant.

```sh
npx @magicblock-labs/hyperpay address
npx @magicblock-labs/hyperpay balance
npx @magicblock-labs/hyperpay init-user 1000000
npx @magicblock-labs/hyperpay fund-user 500000
npx @magicblock-labs/hyperpay open-session <merchant> "10 USDC"
```

SDK equivalent:

```ts
await hp.initUser(1_000_000n)
await hp.fundUser(500_000n)
await hp.openSession(merchant, '10 USDC')
await hp.withdraw('5 USDC')
```

## 4. Open / charge

### SDK

Published package:

```ts
import { HyperPay, PolicyError } from '@magicblock-labs/hyperpay'

const hp = HyperPay.fromEnv()
const merchant = '<merchant pubkey>'
const amount = '10 USDC'

const quote = await hp.quote(merchant, amount)   // policy-checked, sends nothing
const payment = await hp.openSession(merchant, amount)
console.log(payment.signature, payment.settledOn)
```

This monorepo: from `examples/ai-skill/` import from `@magicblock-labs/hyperpay`.

`merchant` is a pubkey. `amount` is `"10 USDC"` (or `"10"` plus `opts.token` / `HYPERPAY_TOKEN`).
Amount may be `0` to open an empty session.

### CLI

```sh
npx @magicblock-labs/hyperpay open-session <merchant> "10 USDC" --yes
npx @magicblock-labs/hyperpay charge <user> "1 USDC" --yes
npx @magicblock-labs/hyperpay session-balance <user>
```

`--yes` / `--json` skip the TTY confirm (required for unattended agents). Other flags: `--token`, `--authority`, `--cluster`.

### MCP

```sh
claude mcp add hyperpay -- npx @magicblock-labs/hyperpay mcp
```

Tools: `open_session`, `charge`, `deposit`, `withdraw`, `session_balance`, `balance`, `policy`.
Call `policy` first (caps and remaining daily), then `open_session` or `charge`. The same env policy applies.

## 5. Merchant charge

The user opens the session. The merchant then reads remaining units and debits them.

```ts
const remaining = await merchantHp.sessionBalance(userWallet)
await merchantHp.charge(userWallet, '1 USDC')
```

`sessionBalance(user)` returns remaining units on the session with this merchant.
`charge(user, amount)` debits that session. The merchant signer signs the debit.
Never pass a user's session token to a merchant `charge`.

## 6. Errors

All extend `HyperPayError`. Catch `PolicyError` separately — it means nothing was signed.

| Class | When |
|---|---|
| `PolicyError` | Cap, allow, or deny rejected the payment |
| `ApiError` | JSON-RPC non-2xx / `{ error }` body |
| `ConfirmationError` | Submitted but not confirmed in the blockhash window |
| `ResolutionError` | Token, mint, or amount could not be resolved |
| `SignerError` | No signer, bad `HYPERPAY_KEY`, or signer cannot sign |

There is **no** `InsufficientFundsError` and **no** `pay()`.

## 7. x402 (consumer only)

The user must `openSession` first. Then:

```ts
import { payingFetch } from '@magicblock-labs/hyperpay/x402'

await hp.openSession(merchant, '1 USDC')
const fetch = payingFetch({ hp: HyperPay.fromEnv(), maxPrice: '0.05 USDC' })
const res = await fetch('https://api.example.com/data')
```

Do not build an x402 server from this skill. See `examples/x402/`.
