---
name: hyperpay
description: >-
  Set up a HyperPay signer, spend policy, and private Solana payments (quote
  then pay). Use when creating a HyperPay account, funding the ephemeral rollup,
  paying a pubkey or stealth handle (alice@magicblock.id), or running the
  HyperPay CLI/MCP tools.
---

# HyperPay — set up and pay

HyperPay (`@magicblock-labs/hyperpay`) pays on Solana. Private by default: transfers settle inside a MagicBlock ephemeral rollup. You sign locally; the hosted API (`https://payments.magicblock.app`) never holds keys.

**Always quote, then pay.** Never invent methods (`waitForCredit`, `InsufficientFundsError` — they do not exist).

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
| `HYPERPAY_API` | Payments API base URL |
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
export HYPERPAY_ALLOW="alice@magicblock.id,*.vendor.id"
export HYPERPAY_DENY=""                    # checked first; wins over allow
# export HYPERPAY_JOURNAL=~/.hyperpay/spend.json   # default
```

- Caps are `"25 USDC"` or `"25 USDC, 10 USDT"`. Each named token is required.
- Fail closed: a USDC cap refuses a USDT payment rather than waving it through.
- `HYPERPAY_ALLOW` / `HYPERPAY_DENY`: comma-separated; `*` wildcards. Pubkeys match exactly (Base58 is case-sensitive).
- Daily spend journals to `HYPERPAY_JOURNAL` (default `~/.hyperpay/spend.json`) and survives restarts.

## 3. Fund and go private

Private `pay()` spends the **ephemeral** balance, not the base-layer one.

```sh
npx @magicblock-labs/hyperpay address
npx @magicblock-labs/hyperpay balance
npx @magicblock-labs/hyperpay init-mint          # once per mint; no-op if already done
npx @magicblock-labs/hyperpay deposit "100 USDC"
```

SDK equivalent:

```ts
const b = await hp.balance()            // { base, private?, ... }
await hp.initializeMint()               // required once before private transfers of this mint
await hp.deposit('100 USDC')            // base layer → rollup
await hp.withdraw('50 USDC')            // rollup → base layer
```

- Recipients that are stealth handles (`alice@magicblock.id`) must already have a stealth pool, or the API rejects the transfer.
- Private transfers cost **0.1%** in-token. Gasless mode: **0.2 USDC/USDT** relay fee, **0.5** minimum.
- Private `pay()` deposits the shortfall from the base layer if the rollup balance is too low.
- `pay()` can return before the queue lands; settlement may take seconds.
- Privacy reduces linkability, not total observability.

## 4. Pay

### SDK

Published package:

```ts
import { HyperPay, PolicyError } from '@magicblock-labs/hyperpay'

const hp = HyperPay.fromEnv()
const to = 'alice@magicblock.id'
const amount = '10 USDC'

const quote = await hp.quote(to, amount)   // policy-checked, sends nothing
const payment = await hp.pay(to, amount)   // private by default
console.log(payment.signature, payment.settledOn)
```

This monorepo: from `examples/ai-skill/` import `../../src/index.js` (from `examples/` it is `../src/index.js`).

Useful `pay` / `quote` options (`PayOptions`):

```ts
await hp.pay(pubkey, '2.5 USDC', { visibility: 'public' })
await hp.pay(pubkey, '10 USDC', { split: 5, delayMs: [1000, 30000] })
```

`to` is a pubkey or stealth handle. `amount` is `"10 USDC"` (or `"10"` plus `opts.token` / `HYPERPAY_TOKEN`).

### CLI

```sh
npx @magicblock-labs/hyperpay quote alice@magicblock.id "10 USDC"
npx @magicblock-labs/hyperpay pay alice@magicblock.id "10 USDC" --yes
npx @magicblock-labs/hyperpay pay <pubkey> "2.5 USDC" --public
```

`--yes` / `--json` skip the TTY confirm (required for unattended agents). Other flags: `--token`, `--memo`, `--split <n>`, `--delay min:max`, `--cluster`.

### MCP

```sh
claude mcp add hyperpay -- npx @magicblock-labs/hyperpay mcp
```

Tools: `pay`, `quote`, `balance`, `deposit`, `withdraw`, `policy`. Call `policy` first (caps and remaining daily), then `quote`, then `pay`. The same env policy applies.

## 5. Merchant charge

The user funds the session with `pay`. The merchant then reads the remaining session units and debits them.

```ts
const remaining = await hp.sessionBalance(user)
await hp.charge(user, '10 USDC')
```

`sessionBalance(user)` returns the remaining units on the session with this merchant. `charge(user, amount)` debits that session. The merchant signer signs the debit.

The client methods exist. The hosted API (`https://payments.magicblock.app`) does not serve `GET /v1/spl/session-balance` or `POST /v1/spl/charge`. Those routes return 404.

## 6. Errors

All extend `HyperPayError`. Catch `PolicyError` separately — it means nothing was signed.

| Class | When |
|---|---|
| `PolicyError` | Cap, allow, or deny rejected the payment |
| `ApiError` | Payments API non-2xx / `{ error }` body |
| `ConfirmationError` | Submitted but not confirmed in the blockhash window |
| `ResolutionError` | Token, mint, or amount could not be resolved |
| `SignerError` | No signer, bad `HYPERPAY_KEY`, or signer cannot sign |

There is **no** `InsufficientFundsError`.

## 7. x402 (consumer only)

To pay for an HTTP API that returns 402:

```ts
import { payingFetch } from '@magicblock-labs/hyperpay/x402'

const fetch = payingFetch({ hp: HyperPay.fromEnv(), maxPrice: '0.05 USDC' })
const res = await fetch('https://api.example.com/data')
```

Do not build an x402 server from this skill. See `examples/x402/`.
