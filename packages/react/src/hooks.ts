'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Balances, Payment, Quote, SessionOptions } from '@magicblock-labs/hyperpay-core/client'
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
    async (merchant: string, amount: string | number | bigint, opts?: SessionOptions) => {
      setStatus('quoting')
      setError(undefined)
      try {
        const next = await hp.quote(merchant, amount, opts)
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

  const openSession = useCallback(
    async (merchant: string, amount: string | number | bigint, opts?: SessionOptions) => {
      setStatus('paying')
      setError(undefined)
      try {
        const next = await hp.openSession(merchant, amount, opts)
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

  const charge = useCallback(
    async (user: string, amount: string | number | bigint) => {
      setStatus('paying')
      setError(undefined)
      try {
        const next = await hp.charge(user, amount)
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
    openSession,
    charge,
    preview,
    payment,
    quote,
    status,
    error,
    reset,
    busy: status === 'quoting' || status === 'paying',
  }
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
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      setLoading(false)
    }
  }, [hp, opts.token, opts.address])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { balances, loading, error, refresh }
}
