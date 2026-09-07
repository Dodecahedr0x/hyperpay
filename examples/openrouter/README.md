# OpenRouter proxy

End users **do not need an OpenRouter API key**. They need a HyperPay keypair and an open payment session with this merchant. This process holds `OPENROUTER_API_KEY` and forwards chat completions.

When OpenRouter bills a generation, that USD cost is deducted from a **hold taken before the upstream call**. If credit cannot cover a worst-case generation (`max_tokens` × model price, plus a buffer), the server returns **402 and does not call OpenRouter**. Unused hold is released after the real `total_cost` lands; if the cost cannot be read, the hold is kept.

The proxy cannot sign the user's key. The user `openSession`s; the merchant may `charge` that session.

## E2E (no keys)

The example ships a mock OpenRouter and a throwaway merchant wallet. This is the full billing loop: 402 without credit, top-up, hold, capture, refund, upstream failure, stream.

```sh
npx vitest run examples/openrouter/e2e.test.ts
```

To also send a real `openSession` on devnet, pass a funded key (the mock still stands in for OpenRouter):

```sh
E2E_PAYER_KEY=~/.config/solana/id.json npx vitest run examples/openrouter/e2e.test.ts
```

`npm test` includes this file.

## Live demo — two terminals

Operator (server):

```sh
export HYPERPAY_KEY=~/.config/solana/id.json   # merchant wallet
export HYPERPAY_CLUSTER=devnet
export OPENROUTER_API_KEY=sk-or-...            # never given to users
npx vite-node examples/openrouter/server.ts
```

User (client) — keypair that can open a session. No OpenRouter key:

```sh
export HYPERPAY_KEY=~/.hyperpay/agent.json
export HYPERPAY_CLUSTER=devnet
npx vite-node examples/openrouter/client.ts
npx vite-node examples/openrouter/client.ts openai/gpt-4o-mini
npx vite-node examples/openrouter/client.ts --stream "Say hi in one sentence."
```

Point the proxy at another OpenRouter-compatible origin with `OPENROUTER_BASE` (default `https://openrouter.ai/api/v1`).

The server starts without `OPENROUTER_API_KEY`. Completions then return **503** until you set one.

This demo may use **one wallet** for merchant and payer (self-pay). Production uses two.

Default top-up is **1 USDC** (`TOPUP_AMOUNT`). Override the proxy with `OPENROUTER_PROXY` (default `http://127.0.0.1:4050`).

## What you should see

1. `GET /quote` — merchant pubkey and USDC mint.
2. Client `hp.openSession(merchant, "1 USDC")` → `POST /topup`.
3. `POST /v1/chat/completions` with `x-account: <refId>`. If credit < worst-case hold → **402** (`needed`); OpenRouter is not called. The client opens more session remaining and retries.
4. Server sets `max_tokens` (default 2048), forwards with its OpenRouter key.
5. After a 200, server reads OpenRouter `total_cost`, captures that from the hold, and refunds the unused hold to the account.

## Production changes

- Separate merchant and user `HYPERPAY_KEY`s.
- Persist the credit ledger.
- After `openSession`, the merchant can `charge` remaining. Poll `hp.sessionBalance(user)` if you need remaining before releasing something costly.
- The proxy still fronts OpenRouter's USD invoice; it cannot pull USDC from a user's eATA without their session, so keep a prepaid float and debit it per generation.
