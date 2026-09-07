# @magicblock-labs/hyperpay

Umbrella package: re-exports core, types, and solana from the root, with subpaths for x402 and MCP.

Prefer a focused package when you want the smallest possible graph. `./react` is an optional re-export — install `@magicblock-labs/hyperpay-react` yourself; this package does not depend on it.

```ts
import { HyperPay } from '@magicblock-labs/hyperpay'
import { payingFetch } from '@magicblock-labs/hyperpay/x402'
import { PayButton } from '@magicblock-labs/hyperpay-react'
import { memoryJournal, fileJournal } from '@magicblock-labs/hyperpay/core'
```

`memoryJournal` and `fileJournal` are not on the umbrella root. `fromEnv()` and `{ key }` are Node-only; in the browser pass `{ signer }`. `HyperPayProvider` accepts `wallet` (wallet-adapter shape).

Canonical surface: [`docs/reference.md`](../../docs/reference.md). Agent map: [`AGENTS.md`](../../AGENTS.md).

## Publishing

Bump every `packages/*/package.json` version together, then `npm run build && npm run typecheck && npm test && npm run publish:packages`. Internal deps use `*` (npm workspaces have no `workspace:` protocol) so lockstep publishes do not 404. Do not publish one package without the others.
