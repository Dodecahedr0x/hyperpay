# OpenRouter proxy

End users **do not need an OpenRouter API key**. They need a HyperPay keypair with USDC (base layer is enough — `pay()` deposits onto the rollup if the ephemeral balance is short). This process holds `OPENROUTER_API_KEY` and forwards chat completions.

When OpenRouter bills a generation, that USD cost is deducted from a **hold taken before the upstream call**. If credit cannot cover a worst-case generation (`max_tokens` × model price, plus a buffer), the server returns **402 and does not call OpenRouter**. Unused hold is released after the real `total_cost` lands; if the cost cannot be read, the hold is kept.

The proxy cannot sign the user's key. The ER debit is the top-up (`hp.pay`).

## Setup

Operator (server):

```sh
export HYPERPAY_KEY=~/.config/solana/id.json   # merchant wallet
export HYPERPAY_CLUSTER=devnet
export OPENROUTER_API_KEY=sk-or-...            # never given to users
```

User (client) — keypair with USDC (base or rollup):

```sh
export HYPERPAY_KEY=~/.hyperpay/agent.json
export HYPERPAY_CLUSTER=devnet
# no OPENROUTER_API_KEY
```

The server starts without `OPENROUTER_API_KEY`. Completions then return **503** until you set one.

This demo may use **one wallet** for merchant and payer (self-pay). Production uses two.

Default top-up is **1 USDC** (`TOPUP_AMOUNT`). Override the proxy with `OPENROUTER_PROXY` (default `http://127.0.0.1:4050`).

## Run — two terminals

Terminal 1:

```sh
npx vite-node examples/openrouter/server.ts
```

Terminal 2:

```sh
npx vite-node examples/openrouter/client.ts
npx vite-node examples/openrouter/client.ts openai/gpt-4o-mini
npx vite-node examples/openrouter/client.ts --stream "Say hi in one sentence."
```

The client tops up from ephemeral USDC if credit is empty, then `POST /v1/chat/completions` with `x-account`. No OpenRouter key on the client.

## What you should see

1. `GET /quote` — merchant pubkey and USDC mint.
2. Client `hp.pay(merchant, "1 USDC")` from the rollup → `POST /topup`.
3. `POST /v1/chat/completions` with `x-account: <refId>`. If credit < worst-case hold → **402** (`needed`); OpenRouter is not called. The client tops up that amount and retries.
4. Server sets `max_tokens` (default 2048), forwards with its OpenRouter key.
5. After a 200, server reads OpenRouter `total_cost`, captures that from the hold, and refunds the unused hold to the account.

## Production changes

- Separate merchant and user `HYPERPAY_KEY`s.
- Persist the credit ledger.
- After a private top-up, poll `hp.balance()` until the merchant's private USDC rises.
- The proxy still fronts OpenRouter's USD invoice; it cannot pull USDC from a user's rollup without their signature, so keep a prepaid float and debit it per generation.
