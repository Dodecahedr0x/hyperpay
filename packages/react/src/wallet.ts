'use client'

import { useMemo, useRef } from 'react'
import type { AnyTransaction, HyperPaySigner } from '@magicblock-labs/hyperpay-solana'

export interface WalletAdapterLike {
  publicKey: HyperPaySigner['publicKey'] | null
  signTransaction<T extends AnyTransaction>(tx: T): Promise<T>
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
}

/**
 * Adapts a Solana wallet-adapter (or anything shaped like one) into a HyperPay signer.
 * Returns `undefined` when `publicKey` is null so a disconnected wallet is “no signer”,
 * not a throw — the provider and PayButton treat that as a connect-wallet empty state.
 */
export function walletAdapterSigner(wallet: WalletAdapterLike): HyperPaySigner | undefined {
  if (!wallet.publicKey) return undefined
  return {
    publicKey: wallet.publicKey,
    signTransaction: (tx) => wallet.signTransaction(tx),
    signMessage: wallet.signMessage ? (message) => wallet.signMessage!(message) : undefined,
  }
}

function signerKeyOf(publicKey: WalletAdapterLike['publicKey']): string | null {
  return publicKey && typeof publicKey.toBase58 === 'function' ? publicKey.toBase58() : null
}

/**
 * Stable signer from a wallet adapter (or a HyperPaySigner). Memoizes on
 * `publicKey` / `signMessage` so a new adapter object each render does not
 * rebuild `HyperPay`. Calls through to the latest wallet via ref.
 */
export function useWalletSigner(wallet: WalletAdapterLike | null | undefined): HyperPaySigner | undefined {
  const publicKey = wallet?.publicKey ?? null
  const signerKey = signerKeyOf(publicKey)
  const hasSignMessage = Boolean(wallet?.signMessage)
  const walletRef = useRef(wallet)
  walletRef.current = wallet

  return useMemo(() => {
    const current = walletRef.current
    if (!current || !signerKey) return undefined
    const adapted = walletAdapterSigner(current)
    if (!adapted) return undefined
    return {
      publicKey: adapted.publicKey,
      signTransaction: (tx) => {
        const live = walletRef.current
        if (!live?.publicKey) throw new Error('Wallet is not connected')
        return live.signTransaction(tx)
      },
      signMessage: hasSignMessage
        ? (message) => {
            const live = walletRef.current
            if (!live?.signMessage) {
              throw new Error('This signer cannot sign messages, so private balances are unavailable')
            }
            return live.signMessage(message)
          }
        : undefined,
    }
  }, [signerKey, hasSignMessage])
}
