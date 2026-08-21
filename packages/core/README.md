# @magicblock-labs/hyperpay-core

The HyperPay client: `pay`, `quote`, `balance`, `deposit`, `withdraw`, and spend policy.

```ts
import { HyperPay, PaymentsApi, memoryJournal, fileJournal } from '@magicblock-labs/hyperpay-core'

const hp = HyperPay.fromEnv()
await hp.pay('alice@magicblock.id', '10 USDC')
```

`PaymentsApi`, `memoryJournal`, and `fileJournal` live here (also `@magicblock-labs/hyperpay/core`), not the umbrella root.

`fromEnv()` and `{ key }` are Node-only. In the browser, pass `{ signer }` (see `@magicblock-labs/hyperpay-react`) or `{ wallet }`.
