'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { HyperPay, type HyperPayConfig } from '@magicblock-labs/hyperpay-core/client'
import { useWalletSigner, type WalletAdapterLike } from './wallet.js'

export type HyperPayProviderProps = Omit<HyperPayConfig, 'key'> & {
  children: ReactNode
  /** Use an existing client instead of constructing one from the other props. */
  client?: HyperPay
  /** Wallet adapter; preferred over passing a new `signer` object each render. */
  wallet?: WalletAdapterLike
}

const HyperPayContext = createContext<HyperPay | null>(null)

export function HyperPayProvider({
  children,
  client,
  wallet,
  signer,
  policy,
  tokens,
  cluster,
  rpcUrl,
  apiUrl,
  authToken,
  defaultToken,
}: HyperPayProviderProps) {
  const fromWallet = useWalletSigner(wallet)
  const fromSigner = useWalletSigner(signer)
  const resolvedSigner = fromSigner ?? fromWallet

  const value = useMemo(
    () =>
      client ??
      new HyperPay({
        signer: resolvedSigner,
        policy,
        tokens,
        cluster,
        rpcUrl,
        apiUrl,
        authToken,
        defaultToken,
      }),
    [client, resolvedSigner, policy, tokens, cluster, rpcUrl, apiUrl, authToken, defaultToken],
  )
  return <HyperPayContext.Provider value={value}>{children}</HyperPayContext.Provider>
}

export function useHyperPay(): HyperPay {
  const hp = useContext(HyperPayContext)
  if (!hp) {
    throw new Error('useHyperPay() must be used inside <HyperPayProvider>.')
  }
  return hp
}
