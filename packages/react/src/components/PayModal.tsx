'use client'

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PayOptions, Payment } from '@magicblock-labs/hyperpay-core/client'
import { usePay } from '../hooks.js'
import { PaymentStatus } from './PaymentStatus.js'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

export interface PayModalProps {
  open: boolean
  to: string
  amount: string | number | bigint
  options?: PayOptions
  title?: ReactNode
  onClose: () => void
  onSettled?: (payment: Payment) => void
  onError?: (error: Error) => void
  className?: string
  style?: CSSProperties
}

export function PayModal({
  open,
  to,
  amount,
  options,
  title = 'Confirm payment',
  onClose,
  onSettled,
  onError,
  className,
  style,
}: PayModalProps) {
  const { preview, pay, quote, status, error, payment, busy, reset } = usePay()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    if (!open) {
      reset()
      return
    }
    void preview(to, amount, options).catch((cause) => {
      const err = cause instanceof Error ? cause : new Error(String(cause))
      onErrorRef.current?.(err)
    })
  }, [open, to, amount, options, preview, reset])

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return

    const panel = dialog
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusable = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled'))

    focusable()[0]?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={typeof title === 'string' ? title : 'Payment'}
        className={className}
        style={style}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        <p>
          {quote ? `${quote.amount} → ${quote.to}` : `Pay ${String(amount)} to ${to}`}
          {quote ? ` · ${quote.visibility}, settles on ${quote.settlesOn}` : ''}
        </p>
        <PaymentStatus status={status === 'quoting' ? 'idle' : status} payment={payment} error={error} />
        <div>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || status === 'success'}
            onClick={() => {
              void pay(to, amount, options).then(onSettled, onError)
            }}
          >
            {status === 'paying' ? 'Paying…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
