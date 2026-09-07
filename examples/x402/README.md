# x402 paid HTTP resource

A premium market snapshot that returns JSON only after a valid `X-Payment` proof.

The server is `node:http` + `Paywall` (no Express). The client is `payingFetch`: it hits 402, identifies the user, and retries so the merchant can `charge` a session the user already opened.

## Setup

```sh
export HYPERPAY_KEY=~/.config/solana/id.json
export HYPERPAY_CLUSTER=devnet
# optional — default 0.01 USDC
export PRICE="0.01 USDC"
```

This demo uses **one wallet** for merchant and payer (self-pay). Production uses two.

The user must `hp.openSession(merchant, amount)` before `payingFetch`. There is no transfer-API fallback. Token top-up into the User eATA is outside HyperPay.

## Run — two terminals

Terminal 1:

```sh
npx vite-node examples/x402/server.ts
```

Terminal 2 — open a session first, then fetch:

```sh
npx vite-node examples/x402/client.ts
```

The client comments that `openSession` must happen before `payingFetch`. In this self-pay demo, open a session with the same wallet the server uses as merchant.

## What you should see

1. Client GET `/snapshot` with no payment → **402** and a challenge (`accepts` names the price, recipient, mint, `refId`).
2. `payingFetch` sends `X-Payment` identifying the user. The merchant `charge`s the open session.
3. Server verifies the proof → **200** and the snapshot JSON.

Server logs `result.strength`:

- `settled` — the recipient's token balance went up by the required amount.
- `accepted` — the transaction confirmed and matches the `refId`, but the amount is not publicly observable on the base layer. Poll `hp.sessionBalance(user)` if you need certainty before releasing something costly.
