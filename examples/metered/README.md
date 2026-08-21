# Metered weather forecasts

Prepaid API: buy forecast tokens in USDC, then spend them. This is **pre-paid metering**, not the x402 paywall example.

Payments are **private by default** (MagicBlock ephemeral rollup). They are not on the public explorer.

This demo uses **one wallet** for merchant and buyer. A real deployment uses two.

## Setup

```sh
export HYPERPAY_KEY=~/.config/solana/id.json
export HYPERPAY_CLUSTER=devnet
```

Private `pay()` spends rollup USDC. If that balance is short, it deposits the shortfall from the base layer first.

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
2. Client `hp.pay(merchant, amount, { refId })`.
3. Client `POST /topup` with `{ signature, refId, units }`.
4. Provider credits that refId. It does **not** have `waitForCredit` or `charge`. Private transfers are not publicly indexed, so it credits from a receipt paid **to this wallet**, rejects replayed signatures, and may read `hp.balance()` as a hint — not cryptographic proof of this payment.
5. `POST /use` decrements credit. Empty (or short) credit returns **402** JSON telling the client to top up.

## Production changes

- Give the provider and the client **separate** `HYPERPAY_KEY`s. The client pays the provider's pubkey from the quote.
- Persist credits (JSON file or sqlite). This process keeps them in memory.
- After a private top-up, poll `hp.balance()` until the merchant's private USDC rises by the expected amount. `pay()` can return before the rollup queue lands.
- For public transfers you can confirm on the base-layer explorer instead.
