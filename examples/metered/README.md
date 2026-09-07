# Metered weather forecasts

Prepaid API: reserve forecast tokens in USDC via a payment session, then spend them. This is **pre-paid metering**, not the x402 paywall example.

Sessions settle on the MagicBlock ephemeral rollup (eSPL). They are not on the public explorer.

This demo uses **one wallet** for merchant and buyer. A real deployment uses two.

## Setup

```sh
export HYPERPAY_KEY=~/.config/solana/id.json
export HYPERPAY_CLUSTER=devnet
```

The client `openSession`s with the merchant. Token top-up into the User eATA is outside HyperPay.

## Run

Terminal 1 — provider (port 4040):

```sh
npx vite-node examples/metered/provider.ts
```

Terminal 2 — client:

```sh
npx vite-node examples/metered/client.ts quote
npx vite-node examples/metered/client.ts buy 5
npx vite-node examples/metered/client.ts use 2
npx vite-node examples/metered/client.ts use 1 Tokyo
npx vite-node examples/metered/client.ts status
```

`buy` / `use` / `status` reuse a refId stored in a temp session file. Price is **0.01 USDC** per city-day forecast.

Override the provider URL with `METERED_URL` (default `http://127.0.0.1:4040`).

## What the provider checks

1. Client `GET /quote` — price per unit, merchant pubkey, USDC mint.
2. Client `hp.openSession(merchant, amount)`.
3. Client `POST /topup` with `{ signature, refId, units }`.
4. Provider credits that refId. It does **not** have `waitForCredit` or a hosted `pay`. It credits from a receipt for a session opened **with this merchant**, rejects replayed signatures, and may read `hp.sessionBalance(user)` as a hint — not cryptographic proof of this payment.
5. `POST /use` decrements credit. Empty (or short) credit returns **402** JSON telling the client to top up.

## Production changes

- Give the provider and the client **separate** `HYPERPAY_KEY`s. The client opens a session with the provider's pubkey from the quote.
- Persist credits (JSON file or sqlite). This process keeps them in memory.
- After `openSession`, the merchant can `charge` remaining session units. Poll `hp.sessionBalance(user)` if you need remaining before releasing something costly.
