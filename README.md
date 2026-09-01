# HyperPay

**The easiest way to pay on Solana.** Private by default, instant, and built for agents.

```ts
import { HyperPay } from '@magicblock-labs/hyperpay'

const hp = HyperPay.fromEnv()
await hp.pay('alice@magicblock.id', '10 USDC')
```

That one call resolves the token, checks your spend policy, builds the transaction, signs it,
routes it to the right network, and waits for confirmation. The payment settles inside a
[MagicBlock](https://magicblock.xyz) **private ephemeral rollup** using **ephemeral SPL (eSPL)**
tokens, so the transfer is not broadcast publicly on the base layer.

---

## Why this exists

MagicBlock's payments API is excellent, but it hands you an **unsigned transaction**. Between
"I want to pay Alice" and "Alice has the money" you still have to:

1. Convert `10 USDC` into `10000000` using the mint's decimals.
2. Choose the right combination of `initIfMissing` / `initAtasIfMissing` / `initVaultIfMissing` —
   set all three and your transaction exceeds the 1232-byte limit.
3. Decode base64 and detect `legacy` vs `v0`.
4. Sign, then submit to `sendTo` — the **base** cluster or the **ephemeral** RPC. These are
   different networks, and picking wrong fails with `blockhash not found`.
5. Poll for confirmation on whichever network you used.
6. Create the recipient's token account yourself — `initAtasIfMissing` creates the *sender's*,
   so a public payment to a new wallet fails with `InvalidAccountData`.
7. Do a challenge/sign/login handshake before you can read a private balance.

HyperPay is that entire list, deleted. It does not reimplement rollups or cryptography — it is a
client-side ergonomics and safety layer over an API that already works.

---

## Install

```sh
npm install @magicblock-labs/hyperpay
```

The repo is an npm workspace. Each concern is its own package; the umbrella re-exports them without bundling:

| Package | What |
|---|---|
| `@magicblock-labs/hyperpay` | Umbrella + CLI + MCP. `export *` per submodule so unused packages drop. |
| `@magicblock-labs/hyperpay-core` | `HyperPay`, policy, payments API |
| `@magicblock-labs/hyperpay-types` | Amounts, errors, wire types |
| `@magicblock-labs/hyperpay-solana` | Signers, ATA, submit/confirm |
| `@magicblock-labs/hyperpay-x402` | HTTP 402 paywall + `payingFetch` |
| `@magicblock-labs/hyperpay-react` | Provider, hooks, PayButton / PayModal / PaymentStatus |

Prefer a focused package for tree-shaking. React is a separate install (`@magicblock-labs/hyperpay-react`); the umbrella does not depend on it.

```ts
import { toBaseUnits } from '@magicblock-labs/hyperpay-types/amounts'
import { HyperPay } from '@magicblock-labs/hyperpay-core'
import { PayButton } from '@magicblock-labs/hyperpay-react'
```

`PaymentsApi`, `memoryJournal`, and `fileJournal` live on `@magicblock-labs/hyperpay-core` (or `@magicblock-labs/hyperpay/core`), not the umbrella root.

`HyperPay.fromEnv()` and `{ key }` are Node-only. In the browser, pass `{ signer }` or `{ wallet }`.

The CLI binary is `hyperpay`, so once the package is a dependency (or installed globally) you can
just run `hyperpay …`. With `npx`, always include the scope — bare `npx hyperpay` would resolve to
an unrelated package of that name on the public registry.

```sh
export HYPERPAY_KEY=~/.config/solana/id.json   # base58, JSON array, or file path
export HYPERPAY_CLUSTER=devnet                 # or mainnet
```

---

## Five ways to use it

### 1. SDK

```ts
import { HyperPay } from '@magicblock-labs/hyperpay'

const hp = HyperPay.fromEnv() // Node-only; in the browser pass { signer } or { wallet }

await hp.pay('alice@magicblock.id', '10 USDC')          // private by default
await hp.pay(pubkey, '2.5 USDC', { visibility: 'public' })
await hp.pay(pubkey, '10 USDC', { split: 5, delayMs: [1000, 30000] })  // harder to correlate

await hp.balance()                    // { base, private, ... }
await hp.quote(pubkey, '10 USDC')     // price it without sending
await hp.deposit('100 USDC')          // base layer  → rollup
await hp.withdraw('50 USDC')          // rollup      → base layer
```

### 2. CLI

```sh
npx @magicblock-labs/hyperpay pay alice@magicblock.id "10 USDC"
npx @magicblock-labs/hyperpay balance
npx @magicblock-labs/hyperpay quote <pubkey> "10 USDC"
```

### 3. MCP — give an agent a wallet

```sh
claude mcp add hyperpay -- npx @magicblock-labs/hyperpay mcp
```

The agent gets six tools: `pay`, `quote`, `balance`, `deposit`, `withdraw`, and `policy`.
`policy` reports the agent's own spending limits, so it can find out what it is allowed to
spend before trying.

### 4. x402 — agents paying for APIs, with no human in the loop

**Server:**

```ts
import express from 'express'
import { HyperPay } from '@magicblock-labs/hyperpay'
import { expressPaywall } from '@magicblock-labs/hyperpay/x402'

const app = express()
app.use('/data', expressPaywall({ hp: HyperPay.fromEnv(), price: '0.01 USDC' }))
app.get('/data', (_req, res) => res.json({ premium: 'content' }))
```

**Agent:**

```ts
import { payingFetch } from '@magicblock-labs/hyperpay/x402'

const fetch = payingFetch({ hp: HyperPay.fromEnv(), maxPrice: '0.05 USDC' })
const res = await fetch('https://api.example.com/data')   // pays and retries automatically
```

The agent hits the endpoint, gets `402` with a quote, pays on Solana, and retries with proof —
no API key, no signup, no human. If the rollup USDC balance is short, `pay()` deposits the
shortfall from the base layer first. Ephemeral-rollup latency is what makes per-request
payments viable; a base-layer confirmation per API call would not be.

Runnable server + client: [`examples/x402`](examples/x402).

### 5. React — drop-in checkout

`wallet` is the same shape as `useWallet()` from `@solana/wallet-adapter-react`. Do not pass `{ key }` in the browser.

```tsx
import { useWallet } from '@solana/wallet-adapter-react'
import { HyperPayProvider, PayButton } from '@magicblock-labs/hyperpay-react'

function Checkout() {
  const wallet = useWallet()
  return (
    <HyperPayProvider cluster="devnet" wallet={wallet}>
      <PayButton to="alice@magicblock.id" amount="10 USDC" />
    </HyperPayProvider>
  )
}
```

Equivalent if you already have a signer: `signer={walletAdapterSigner(wallet)}` (undefined while disconnected). Install `@magicblock-labs/hyperpay-react` separately; the umbrella does not depend on it.

`PayModal` quotes then confirms; `usePay` / `useBalance` cover custom UI. React is a peer dependency and is not bundled.

Runnable app: [`examples/react`](examples/react).

---

## Examples

Node examples need `HYPERPAY_KEY` and `HYPERPAY_CLUSTER=devnet`. The React app takes a wallet instead.

| Path | What |
|---|---|
| [`examples/react`](examples/react) | Vite + React: connect a wallet, then `PayButton` |
| [`examples/ai-skill`](examples/ai-skill) | Agent skill: set up a signer, spend caps, fund the rollup, quote then pay |
| [`examples/metered`](examples/metered) | Prepaid metered API — buy forecast tokens, then spend them |
| [`examples/x402`](examples/x402) | Paid HTTP resource — `Paywall` server and `payingFetch` client |
| [`examples/openrouter`](examples/openrouter) | OpenRouter proxy — users pay from ephemeral USDC; `npx vitest run examples/openrouter/e2e.test.ts` is a full loop against a mock upstream |

---

## Agent safety

Never give an agent your main wallet. Give it a **session key** funded with a bounded amount,
and set caps:

```sh
HYPERPAY_KEY=<session keypair>
HYPERPAY_MAX_PER_TX="25 USDC"
HYPERPAY_DAILY_CAP="200 USDC"
HYPERPAY_ALLOW="alice@magicblock.id,*.vendor.id"
```

Every payment is checked **before anything is signed**, so a rejected payment leaves no
transaction in existence. Daily spend is journaled to `~/.hyperpay/spend.json` and survives
restarts. Caps fail closed: if you cap USDC and the agent tries to pay in some other token, it
is refused rather than waved through.

> **Be clear about what this protects.** Client-side caps are a blast-radius limiter, not a
> security boundary. Any process holding the key can sign without consulting HyperPay. The real
> containment is that a session key only ever holds what you deposited into it. Fund it like a
> prepaid card, not a bank account.

---

## What "private" means here

Quoting MagicBlock's own caveat, because it matters: privacy here reduces **linkability**, not
total observability. Amounts and timing may still be inferable at the network level.

- Private transfers cost **0.1%** in the token itself.
- Gasless mode has a flat **0.2 USDC/USDT** relay fee and a **0.5** minimum transfer.
- `split` and `delayMs` weaken amount and timing correlation.
- Private transfers settle through a queue, so they can land **seconds after** `pay()` returns.
- Stealth handles (`alice@magicblock.id`) require the recipient to have initialized a stealth
  pool first, otherwise the API rejects the transfer.

---

## Rust

```toml
[dependencies]
hyperpay = { path = "crates/hyperpay" }
```

```rust
use hyperpay::{HyperPay, PayOptions};

let hp = HyperPay::from_env()?;
let payment = hp.pay("alice@magicblock.id", "10 USDC", PayOptions::default()).await?;
println!("{}", payment.signature);
```

The Rust crate deliberately avoids `solana-client`, using two plain JSON-RPC calls instead, which
keeps the dependency tree and compile time small.

---

## Custom tokens

Symbols resolve for USDC, USDT and SOL. For anything else, name the mint — this is also what
makes symbol-keyed spend caps work for it:

```ts
const hp = new HyperPay({
  cluster: 'devnet',
  tokens: [{ symbol: 'TEST', mint: '7u1w…', decimals: 6 }],
  defaultToken: 'TEST',
  policy: { maxPerTx: '5 TEST' },
})
await hp.initializeMint()   // register the mint with the ephemeral validator, once
```

---

## Testing

```sh
npm test          # unit tests (amounts, policy, x402, react, tree-shake), no network
npm run test:live # MCP server driven over stdio by a real MCP client
npm run test:e2e  # real payments on live devnet
```

The e2e suites are not mocked: they build, sign, submit and confirm real transactions on Solana
devnet and the MagicBlock ephemeral rollup. Set `E2E_PAYER_KEY`, `E2E_PAYEE` and `E2E_MINT` to
run them.

---

## Reference

| Variable | Meaning |
|---|---|
| `HYPERPAY_KEY` | Secret key: base58, JSON byte array, or file path |
| `HYPERPAY_CLUSTER` | `mainnet`, `devnet`, or an RPC URL |
| `HYPERPAY_RPC` | Override the base-layer RPC |
| `HYPERPAY_API` | Override the payments API base URL |
| `HYPERPAY_TOKEN` | Default token symbol (default `USDC`) |
| `HYPERPAY_TOKENS` | Custom mints, `SYMBOL:MINT:DECIMALS,…` |
| `HYPERPAY_MAX_PER_TX` | Per-transaction cap, e.g. `"25 USDC"` |
| `HYPERPAY_DAILY_CAP` | Rolling UTC-day cap |
| `HYPERPAY_ALLOW` / `HYPERPAY_DENY` | Recipient patterns, `*` wildcards |
| `HYPERPAY_JOURNAL` | Where daily spend is recorded |

**Errors** are typed: `PolicyError`, `ApiError`, `ConfirmationError`, `ResolutionError`,
`SignerError` — all extending `HyperPayError`.

---

## Dependencies and trust

HyperPay talks to `https://payments.magicblock.app`, a hosted service operated by MagicBlock. It
builds your transactions; it never holds your keys, and you sign everything locally. Point
`HYPERPAY_API` elsewhere if you run your own. Because HyperPay uses the REST API rather than the
on-chain SDK, it is insulated from the `0.14.x` legacy-vault vs `0.15.x` idempotent-shuttle split.

## Publishing

Bump every `packages/*/package.json` version together, then:

```sh
npm run build && npm run typecheck && npm test && npm run publish:packages
```

Internal deps use `*` (this npm has no `workspace:` protocol) so lockstep publishes do not 404. Publish the workspace together — a single package at a new version will 404 its siblings.

## License

MIT
