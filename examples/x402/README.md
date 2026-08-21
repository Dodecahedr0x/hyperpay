# x402 paid HTTP resource

A premium market snapshot that returns JSON only after a valid `X-Payment` proof.

The server is `node:http` + `Paywall` (no Express). The client is `payingFetch`: it hits 402, pays, and retries with the proof.

## Setup

```sh
export HYPERPAY_KEY=~/.config/solana/id.json
export HYPERPAY_CLUSTER=devnet
# optional — default 0.01 USDC
export PRICE="0.01 USDC"
```

This demo uses **one wallet** for merchant and payer (self-pay). Production uses two.

`payingFetch` pays privately from the rollup. If that balance is short, it deposits USDC from the base layer first — so a funded base-layer wallet is enough to start.

## Run — two terminals

Terminal 1:

```sh
npx vite-node examples/x402/server.ts
```

Terminal 2:

```sh
npx vite-node examples/x402/client.ts
```

## What you should see

1. Client GET `/snapshot` with no payment → **402** and a challenge (`accepts` names the price, recipient, mint, `refId`).
2. `payingFetch` pays that quote privately (depositing from the base layer if the rollup is short) and retries with `X-Payment`.
3. Server verifies the proof → **200** and the snapshot JSON.

Server logs `result.strength`:

- `settled` — the recipient's token balance on the base layer went up by the required amount.
- `accepted` — the transaction confirmed and matches the `refId`, but the amount is not publicly observable (private transfer). Poll `hp.balance()` if you need certainty before releasing something costly.

With `visibility: 'private'` you will usually see `accepted`.
