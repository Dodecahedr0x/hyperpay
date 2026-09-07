# @magicblock-labs/hyperpay-solana

Signers, associated-token accounts, and submit/confirm for HyperPay.

```ts
import { keypairSigner, signAndSubmit } from '@magicblock-labs/hyperpay-solana'
import { ensureRecipientAta } from '@magicblock-labs/hyperpay-solana/ata'
```

`keypairSigner` needs a secret key — Node or a trusted backend, not the browser. In React, pass a wallet adapter to `@magicblock-labs/hyperpay-react`.

Canonical surface: [`docs/reference.md`](../../docs/reference.md).
