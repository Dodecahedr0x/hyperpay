# @magicblock-labs/hyperpay-x402

HTTP 402 paywall and auto-paying `fetch` for HyperPay. Prefer this package over `@magicblock-labs/hyperpay/x402` if you only want the paywall.

```ts
import { expressPaywall, payingFetch } from '@magicblock-labs/hyperpay-x402'
import { HyperPay } from '@magicblock-labs/hyperpay-core'

const hp = HyperPay.fromEnv() // Node-only
// User must hp.openSession(merchant, amount) before the merchant can charge.
```
