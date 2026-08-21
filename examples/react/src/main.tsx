import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  HyperPayProvider,
  PayButton,
  walletAdapterSigner,
  type WalletAdapterLike,
} from '@magicblock-labs/hyperpay-react'

// Same shape as `useWallet()` from `@solana/wallet-adapter-react`.
function useDemoWallet() {
  const [publicKey, setPublicKey] = useState<WalletAdapterLike['publicKey']>(null)
  return {
    publicKey,
    connect: () =>
      setPublicKey({
        toBase58: () => 'Demo111111111111111111111111111111111111111',
      } as WalletAdapterLike['publicKey']),
    disconnect: () => setPublicKey(null),
    // ponytail: demo only — a real adapter signs here
    signTransaction: async (tx) => tx,
  } satisfies WalletAdapterLike & { connect(): void; disconnect(): void }
}

function App() {
  const wallet = useDemoWallet()

  return (
    <HyperPayProvider cluster="devnet" wallet={wallet} signer={walletAdapterSigner(wallet)}>
      <p>{wallet.publicKey ? wallet.publicKey.toBase58() : 'Wallet disconnected'}</p>
      <button type="button" onClick={() => (wallet.publicKey ? wallet.disconnect() : wallet.connect())}>
        {wallet.publicKey ? 'Disconnect' : 'Connect wallet'}
      </button>
      <PayButton to="alice@magicblock.id" amount="10 USDC" onError={(error) => console.error(error)} />
    </HyperPayProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
