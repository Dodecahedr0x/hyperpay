'use client'

import type { CSSProperties, ReactNode } from 'react'
import type { PayOptions, Payment } from '@magicblock-labs/hyperpay-core/client'
import { usePay } from '../hooks.js'
import { useHyperPay } from '../provider.js'

export interface PayButtonProps {
  to: string
  amount: string | number | bigint
  options?: PayOptions
  children?: ReactNode
  disabled?: boolean
  className?: string
  style?: CSSProperties
  onSettled?: (payment: Payment) => void
  onError?: (error: Error) => void
}

export function PayButton({
  to,
  amount,
  options,
  children,
  disabled,
  className,
  style,
  onSettled,
  onError,
}: PayButtonProps) {
  const hp = useHyperPay()
  const { pay, busy } = usePay()
  const disconnected = !hp.signer
  const label = typeof amount === 'string' ? amount : String(amount)

  return (
    <button
      type="button"
      className={className}
      style={style}
      disabled={disabled || busy || disconnected}
      onClick={() => {
        if (disconnected) return
        void pay(to, amount, options).then(onSettled, onError)
      }}
    >
      {disconnected ? 'Connect wallet' : (children ?? (busy ? 'Paying…' : `Pay ${label}`))}
    </button>
  )
}
