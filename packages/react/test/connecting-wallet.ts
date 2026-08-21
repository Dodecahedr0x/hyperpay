import type { AnyTransaction, HyperPaySigner } from '@magicblock-labs/hyperpay-solana'
import type { WalletAdapterLike } from '../src/wallet.js'

/** Test wallet that can connect and disconnect without throwing from `walletAdapterSigner`. */
export type ConnectingWallet = WalletAdapterLike & {
  connect: () => void
  disconnect: () => void
}

export function createConnectingWallet(address = 'payer'): ConnectingWallet {
  let publicKey: HyperPaySigner['publicKey'] | null = null
  const fakeKey = { toBase58: () => address } as HyperPaySigner['publicKey']

  return {
    get publicKey() {
      return publicKey
    },
    signTransaction: async <T extends AnyTransaction>(tx: T) => tx,
    signMessage: async (message: Uint8Array) => message,
    connect() {
      publicKey = fakeKey
    },
    disconnect() {
      publicKey = null
    },
  }
}
