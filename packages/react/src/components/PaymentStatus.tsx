'use client'

import type { CSSProperties } from 'react'
import type { Payment } from '@magicblock-labs/hyperpay-core/client'
import type { PayStatus } from '../hooks.js'

export interface PaymentStatusProps {
  status: PayStatus
  payment?: Payment
  error?: Error
  className?: string
  style?: CSSProperties
}

export function PaymentStatus({ status, payment, error, className, style }: PaymentStatusProps) {
  if (status === 'idle' || status === 'quoting') return null

  if (status === 'paying') {
    return (
      <p role="status" aria-live="polite" className={className} style={style}>
        Sending payment…
      </p>
    )
  }

  if (status === 'error') {
    return (
      <p role="alert" className={className} style={style}>
        {error?.message ?? 'Payment failed'}
      </p>
    )
  }

  if (!payment) return null

  return (
    <div role="status" aria-live="polite" className={className} style={style}>
      <div>
        Paid {payment.amount} to {payment.to}
      </div>
      <div>{payment.signature}</div>
      {payment.explorerUrl ? (
        <a href={payment.explorerUrl} target="_blank" rel="noreferrer">
          View on explorer
        </a>
      ) : null}
    </div>
  )
}
