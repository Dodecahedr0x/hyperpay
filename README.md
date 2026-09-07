# HyperPay

Payment sessions on Solana. A user opens a session with a merchant; the merchant
`charge`s it. The SDK builds, signs, and submits the
[hyperpay program](programs/hyperpay) — it does not call a hosted payments API.

Program id: `Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU`

```ts
import { HyperPay } from '@magicblock-labs/hyperpay'

const user = HyperPay.fromEnv()
await user.initUser(1_000_000n)
await user.delegateUser()
await user.topUp('10 USDC')
await user.openSession(merchant, '10 USDC')

const merchantHp = new HyperPay({ key: merchantKey, cluster: 'devnet' })
await merchantHp.charge(userWallet, '1 USDC')
```

Typical flow: `initUser` → `delegateUser` → `topUp` →
`openSession(merchant, amount)` → merchant `charge` → `closeSession` → `withdraw`.

---

## Why this exists

The user PDA sponsors fees and is the token authority. Tokens sit in an eSPL eATA
owned by that PDA. `remaining` + `reserved` isolate merchants: opening a session
reserves units; `charge` is a PDA-signed transfer the merchant (or the user)
authorizes. Session keys work too — pass `authority` when the signer is not the
wallet that owns the User PDA.

HyperPay is the client for that program: amounts, spend policy, instruction
builders, sign, submit, confirm.

---

## Install

```sh
npm install @magicblock-labs/hyperpay
```

The repo is an npm workspace. Each concern is its own package; the umbrella re-exports them without bundling:

| Package | What |
|---|---|
| `@magicblock-labs/hyperpay` | Umbrella + CLI + MCP. `export *` per submodule so unused packages drop. |
| `@magicblock-labs/hyperpay-core` | `HyperPay`, program Ixs, policy |
| `@magicblock-labs/hyperpay-types` | Amounts, errors |
| `@magicblock-labs/hyperpay-solana` | Signers, ATA, submit/confirm |
| `@magicblock-labs/hyperpay-x402` | HTTP 402 paywall + `payingFetch` |
| `@magicblock-labs/hyperpay-react` | Provider, hooks, PayButton / PayModal / PaymentStatus |

Prefer a focused package for tree-shaking. React is a separate install (`@magicblock-labs/hyperpay-react`); the umbrella does not depend on it.

```ts
import { toBaseUnits } from '@magicblock-labs/hyperpay-types/amounts'
import { HyperPay } from '@magicblock-labs/hyperpay-core'
import { PayButton } from '@magicblock-labs/hyperpay-react'
```

`memoryJournal` and `fileJournal` live on `@magicblock-labs/hyperpay-core` (or `@magicblock-labs/hyperpay/core`), not the umbrella root.

`HyperPay.fromEnv()` and `{ key }` are Node-only. In the browser, pass `{ signer }`.

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

const user = HyperPay.fromEnv() // Node-only; in the browser pass { signer }

await user.initUser(1_000_000n)
await user.openSession(merchant, '10 USDC')
await user.deposit(merchant, '2 USDC')          // reserve more into an open session
await user.closeSession(merchant)
await user.withdraw('5 USDC')                   // unreserved eATA → destination eATA

const merchantHp = new HyperPay({ key: merchantKey, cluster: 'devnet' })
await merchantHp.sessionBalance(userWallet)     // remaining on this merchant's session
await merchantHp.charge(userWallet, '1 USDC')   // merchant signs the debit

await user.balance()                            // base-layer ATA
await user.quote(merchant, '10 USDC')           // policy-check, send nothing
```

The user must `openSession` before a merchant can `charge`. Never pass a user's
session token to a merchant `charge`.

### 2. CLI

```sh
npx @magicblock-labs/hyperpay init-user 1000000
npx @magicblock-labs/hyperpay delegate-user
npx @magicblock-labs/hyperpay open-session <merchant> "10 USDC"
npx @magicblock-labs/hyperpay charge <user> "1 USDC"
npx @magicblock-labs/hyperpay session-balance <user>
npx @magicblock-labs/hyperpay close-session <merchant>
npx @magicblock-labs/hyperpay withdraw "5 USDC"
```

### 3. MCP — give an agent a wallet

```sh
claude mcp add hyperpay -- npx @magicblock-labs/hyperpay mcp
```

The agent gets `open_session`, `charge`, `deposit`, `withdraw`, `session_balance`,
`balance`, and `policy`. `policy` reports the agent's own spending limits, so it
can find out what it is allowed to spend before trying.

### 4. x402 — agents paying for APIs, with no human in the loop

The user opens a session first. The merchant `charge`s that session; there is no
transfer-API fallback.

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

await hp.openSession(merchant, '1 USDC')
const fetch = payingFetch({ hp: HyperPay.fromEnv(), maxPrice: '0.05 USDC' })
const res = await fetch('https://api.example.com/data')   // identifies the user; merchant charges
```

Runnable server + client: [`examples/x402`](examples/x402).

### 5. React — drop-in checkout

`wallet` on `HyperPayProvider` is the same shape as `useWallet()` from `@solana/wallet-adapter-react`. Do not pass `{ key }` in the browser.

```tsx
import { useWallet } from '@solana/wallet-adapter-react'
import { HyperPayProvider, PayButton } from '@magicblock-labs/hyperpay-react'

function Checkout() {
  const wallet = useWallet()
  return (
    <HyperPayProvider cluster="devnet" wallet={wallet}>
      <PayButton to={merchant} amount="10 USDC" />
    </HyperPayProvider>
  )
}
```

`PayButton` calls `openSession`. Equivalent if you already have a signer:
`signer={walletAdapterSigner(wallet)}` (undefined while disconnected). Install
`@magicblock-labs/hyperpay-react` separately; the umbrella does not depend on it.

`PayModal` quotes then confirms; `usePay` / `useBalance` cover custom UI. React is a peer dependency and is not bundled.

Runnable app: [`examples/react`](examples/react).

---

## Examples

Node examples need `HYPERPAY_KEY` and `HYPERPAY_CLUSTER=devnet`. The React app takes a wallet instead.

| Path | What |
|---|---|
| [`examples/react`](examples/react) | Vite + React: connect a wallet, then `PayButton` (`openSession`) |
| [`examples/ai-skill`](examples/ai-skill) | Agent skill: set up a signer, spend caps, open a session, then charge |
| [`examples/metered`](examples/metered) | Prepaid metered API — open a session, then spend reserved units |
| [`examples/x402`](examples/x402) | Paid HTTP resource — `Paywall` server and `payingFetch` client |
| [`examples/openrouter`](examples/openrouter) | OpenRouter proxy — users open a session; `npx vitest run examples/openrouter/e2e.test.ts` is a full loop against a mock upstream |

---

## Agent safety

Never give an agent your main wallet. Give it a **session key** funded with a bounded amount,
and set caps. When the signer is a session key, pass `authority` (the wallet that owns the User PDA):

```sh
HYPERPAY_KEY=<session keypair>
HYPERPAY_MAX_PER_TX="25 USDC"
HYPERPAY_DAILY_CAP="200 USDC"
HYPERPAY_ALLOW="<merchant pubkey>"
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

## Sessions on the ephemeral rollup

`openSession`, `deposit`, `charge`, `closeSession`, and `withdraw` land on the MagicBlock
ephemeral rollup. `initUser` / `delegateUser` land on the base cluster
(lamports into the User PDA at init, then MagicBlock delegation). Extra lamports
are a system transfer or eSPL-sponsored. `topUp` deposits wallet ATA tokens into
the User eATA on base, then creates the ephemeral UserMint if it is missing.

Amounts and timing on the rollup may still be inferable at the network level. Privacy here
reduces **linkability**, not total observability.

---

## Rust

```toml
[dependencies]
hyperpay = { path = "crates/hyperpay" }
```

```rust
use hyperpay::HyperPay;

let user = HyperPay::from_env()?;
user.init_user(1_000_000).await?;
user.delegate_user(None).await?;
user.top_up("10 USDC", None, None).await?;
user.open_session(merchant, "10 USDC", None, None).await?;

let merchant = HyperPay::from_env()?;
let payment = merchant.charge(&user_wallet, "1 USDC").await?;
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
await hp.openSession(merchant, '5 TEST')
```

---

## Testing

```sh
npm test               # unit tests (amounts, policy, x402, react, tree-shake), no network
just test-program      # Anchor program tests (reservation math + LiteSVM)
npm run test:live      # MCP server driven over stdio by a real MCP client
npm run test:e2e       # real payments on live devnet
npm run test:e2e:local # spins up mb-stack and hits the TS + Rust SDKs
```

The e2e suites are not mocked: they build, sign, submit and confirm real transactions. Live
devnet needs `E2E_PAYER_KEY`, `E2E_PAYEE` and `E2E_MINT`. Local needs `mb-stack` (`npm i -g
@magicblock-labs/ephemeral-validator`).

---

## Reference

| Variable | Meaning |
|---|---|
| `HYPERPAY_KEY` | Secret key: base58, JSON byte array, or file path |
| `HYPERPAY_CLUSTER` | `mainnet`, `devnet`, or an RPC URL |
| `HYPERPAY_RPC` | Override the base-layer RPC |
| `HYPERPAY_EPHEMERAL_RPC` | Override the ephemeral-rollup RPC |
| `HYPERPAY_TOKEN` | Default token symbol (default `USDC`) |
| `HYPERPAY_TOKENS` | Custom mints, `SYMBOL:MINT:DECIMALS,…` |
| `HYPERPAY_MAX_PER_TX` | Per-transaction cap, e.g. `"25 USDC"` |
| `HYPERPAY_DAILY_CAP` | Rolling UTC-day cap |
| `HYPERPAY_ALLOW` / `HYPERPAY_DENY` | Recipient patterns, `*` wildcards |
| `HYPERPAY_JOURNAL` | Where daily spend is recorded |

**Errors** are typed: `PolicyError`, `ApiError` (JSON-RPC), `ConfirmationError`,
`ResolutionError`, `SignerError` — all extending `HyperPayError`.

---

## Dependencies and trust

HyperPay talks to the on-chain program
(`Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU`) and the RPCs you configure. It
never holds your keys; you sign everything locally.

## Publishing

Bump every `packages/*/package.json` version together, then:

```sh
npm run build && npm run typecheck && npm test && npm run publish:packages
```

Internal deps use `*` (this npm has no `workspace:` protocol) so lockstep publishes do not 404. Publish the workspace together — a single package at a new version will 404 its siblings.

## License

MIT
