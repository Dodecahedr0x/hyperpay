# @magicblock-labs/hyperpay-react

Drop HyperPay into an existing React app. Install this package separately; the umbrella does not depend on it.

`fromEnv()` and `{ key }` are Node-only. Pass `wallet` (same shape as `useWallet()`) or `signer` to `HyperPayProvider`.

```tsx
import { useWallet } from '@solana/wallet-adapter-react'
import { HyperPayProvider, PayButton, walletAdapterSigner } from '@magicblock-labs/hyperpay-react'

function Checkout() {
  const wallet = useWallet()
  return (
    <HyperPayProvider cluster="devnet" wallet={wallet}>
      <PayButton to={merchant} amount="10 USDC" />
    </HyperPayProvider>
  )
}

// Equivalent: signer={walletAdapterSigner(wallet)} — undefined while disconnected
```

`PayModal`, `PaymentStatus`, `usePay`, and `useBalance` cover custom UI. Runnable app: [`examples/react`](../../examples/react). Canonical surface: [`docs/reference.md`](../../docs/reference.md).
