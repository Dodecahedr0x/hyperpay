'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Balances, PayOptions, Payment, Quote } from '@magicblock-labs/hyperpay-core/client'
import { useHyperPay } from './provider.js'

export type PayStatus = 'idle' | 'quoting' | 'paying' | 'success' | 'error'

export function usePay() {
  const hp = useHyperPay()
  const [status, setStatus] = useState<PayStatus>('idle')
  const [payment, setPayment] = useState<Payment>()
  const [quote, setQuote] = useState<Quote>()
  const [error, setError] = useState<Error>()

  const reset = useCallback(() => {
    setStatus('idle')
    setPayment(undefined)
    setQuote(undefined)
    setError(undefined)
  }, [])

  const preview = useCallback(
    async (to: string, amount: string | number | bigint, opts?: PayOptions) => {
      setStatus('quoting')
      setError(undefined)
      try {
        const next = await hp.quote(to, amount, opts)
        setQuote(next)
        setStatus('idle')
        return next
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause))
        setError(err)
        setStatus('error')
        throw err
      }
    },
    [hp],
  )

  const pay = useCallback(
    async (to: string, amount: string | number | bigint, opts?: PayOptions) => {
      setStatus('paying')
      setError(undefined)
      try {
        const next = await hp.pay(to, amount, opts)
        setPayment(next)
        setStatus('success')
        return next
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause))
        setError(err)
        setStatus('error')
        throw err
      }
    },
    [hp],
  )

  return {
    pay,
    preview,
    payment,
    quote,
    status,
    error,
    reset,
    busy: status === 'quoting' || status === 'paying',
  }
}

/** True when private reads failed because the signer cannot authenticate (no `signMessage` / `login`). */
function isPrivateReadUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /cannot sign messages|signMessage|private balances are unavailable/i.test(message)
}

export function useBalance(opts: { token?: string; address?: string } = {}) {
  const hp = useHyperPay()
  const [balances, setBalances] = useState<Balances>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setBalances(await hp.balance(opts))
    } catch (cause) {
      // Private balance needs signer.signMessage (HyperPay.login()). Missing that
      // capability is not a UI failure — surface base-only / omit private instead.
      if (isPrivateReadUnavailable(cause) || !hp.signer?.signMessage) {
        setBalances((prev) =>
          prev ? { ...prev, private: undefined, privateUnits: undefined } : undefined,
        )
      } else {
        setError(cause instanceof Error ? cause : new Error(String(cause)))
      }
    } finally {
      setLoading(false)
    }
  }, [hp, opts.token, opts.address])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { balances, loading, error, refresh }
}
