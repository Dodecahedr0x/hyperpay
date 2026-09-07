# @magicblock-labs/hyperpay-core

The HyperPay client: `initUser`, `openSession`, `charge`, `deposit`, `withdraw`, and spend policy.

```ts
import { HyperPay, memoryJournal, fileJournal } from '@magicblock-labs/hyperpay-core'

const hp = HyperPay.fromEnv()
await hp.initUser(1_000_000n)
await hp.openSession(merchant, '10 USDC')
await merchantHp.charge(userWallet, '1 USDC')
```

The user must `openSession` before a merchant can `charge`. `memoryJournal` and `fileJournal` live here (also `@magicblock-labs/hyperpay/core`), not the umbrella root.

`fromEnv()` and `{ key }` are Node-only. In the browser, pass `{ signer }` (see `@magicblock-labs/hyperpay-react`). When the signer is a session key, pass `authority` (the wallet that owns the User PDA).

Canonical surface: [`docs/reference.md`](../../docs/reference.md).
