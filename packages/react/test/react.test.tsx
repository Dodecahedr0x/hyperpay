import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import type { HyperPay } from '@magicblock-labs/hyperpay-core/client'
import type { Payment, Quote } from '@magicblock-labs/hyperpay-core/client'
import type { HyperPaySigner } from '@magicblock-labs/hyperpay-solana'
import {
  HyperPayProvider,
  PayButton,
  PayModal,
  PaymentStatus,
  useHyperPay,
  usePay,
  useBalance,
  useWalletSigner,
  walletAdapterSigner,
} from '@magicblock-labs/hyperpay-react'
import { createConnectingWallet } from './connecting-wallet.js'

const USDC = { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 }

const payment: Payment = {
  signature: 'sig111',
  to: 'alice@magicblock.id',
  amount: '10 USDC',
  units: '10000000',
  token: USDC,
  visibility: 'private',
  settledOn: 'ephemeral',
  rpcUrl: 'https://devnet.magicblock.app',
}

const quote: Quote = {
  to: 'alice@magicblock.id',
  amount: '10 USDC',
  units: '10000000',
  token: USDC,
  visibility: 'private',
  settlesOn: 'ephemeral',
  instructionCount: 3,
}

function mockPublicKey(address = 'payer'): HyperPaySigner['publicKey'] {
  return { toBase58: () => address } as HyperPaySigner['publicKey']
}

function mockSigner(overrides: Partial<HyperPaySigner> = {}): HyperPaySigner {
  return {
    publicKey: mockPublicKey(),
    signTransaction: async (tx) => tx,
    signMessage: async (message) => message,
    ...overrides,
  }
}

function mockClient(overrides: Partial<HyperPay> = {}): HyperPay {
  return {
    cluster: 'devnet',
    signer: mockSigner(),
    pay: vi.fn().mockResolvedValue(payment),
    quote: vi.fn().mockResolvedValue(quote),
    balance: vi.fn().mockResolvedValue({
      address: 'payer',
      token: USDC,
      base: '100',
      private: '40',
      baseUnits: '100000000',
      privateUnits: '40000000',
    }),
    ...overrides,
  } as unknown as HyperPay
}

function Probe({ children }: { children?: ReactNode }) {
  return <HyperPayProvider client={mockClient()}>{children}</HyperPayProvider>
}

afterEach(() => {
  cleanup()
})

describe('useHyperPay', () => {
  it('throws outside of HyperPayProvider', () => {
    function Boom() {
      useHyperPay()
      return null
    }
    expect(() => render(<Boom />)).toThrow(/HyperPayProvider/)
  })

  it('returns the provided client', () => {
    const client = mockClient()
    function ShowCluster() {
      return <span>{useHyperPay().cluster}</span>
    }
    render(
      <HyperPayProvider client={client}>
        <ShowCluster />
      </HyperPayProvider>,
    )
    expect(screen.getByText('devnet')).toBeTruthy()
  })

  it('does not rebuild HyperPay when the signer object identity changes', () => {
    const publicKey = mockPublicKey()
    const instances: HyperPay[] = []
    function Capture() {
      instances.push(useHyperPay())
      return null
    }
    const { rerender } = render(
      <HyperPayProvider cluster="devnet" signer={{ publicKey, signTransaction: async (tx) => tx }}>
        <Capture />
      </HyperPayProvider>,
    )
    rerender(
      <HyperPayProvider cluster="devnet" signer={{ publicKey, signTransaction: async (tx) => tx }}>
        <Capture />
      </HyperPayProvider>,
    )
    expect(instances.length).toBeGreaterThanOrEqual(2)
    expect(instances[0]).toBe(instances[1])
  })
})

describe('PayButton', () => {
  it('pays the configured recipient on click', async () => {
    const client = mockClient()
    const onSettled = vi.fn()
    render(
      <HyperPayProvider client={client}>
        <PayButton to="alice@magicblock.id" amount="10 USDC" onSettled={onSettled} />
      </HyperPayProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /pay 10 usdc/i }))
    await waitFor(() => expect(client.pay).toHaveBeenCalledWith('alice@magicblock.id', '10 USDC', undefined))
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(payment))
  })

  it('disables the button while a payment is in flight', async () => {
    let finish: (value: Payment) => void = () => {}
    const client = mockClient({
      pay: vi.fn(
        () =>
          new Promise<Payment>((resolve) => {
            finish = resolve
          }),
      ) as HyperPay['pay'],
    })
    render(
      <HyperPayProvider client={client}>
        <PayButton to="alice@magicblock.id" amount="10 USDC" />
      </HyperPayProvider>,
    )
    const button = screen.getByRole('button', { name: /pay 10 usdc/i })
    fireEvent.click(button)
    await waitFor(() => expect(button).toHaveProperty('disabled', true))
    finish(payment)
    await waitFor(() => expect(button).toHaveProperty('disabled', false))
  })

  it('shows a connect-wallet empty state when the client has no signer', () => {
    const client = mockClient({ signer: undefined })
    render(
      <HyperPayProvider client={client}>
        <PayButton to="alice@magicblock.id" amount="10 USDC" />
      </HyperPayProvider>,
    )
    const button = screen.getByRole('button', { name: /connect wallet/i })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(client.pay).not.toHaveBeenCalled()
  })
})

describe('PayModal', () => {
  it('quotes when opened and pays on confirm', async () => {
    const client = mockClient()
    const onSettled = vi.fn()
    render(
      <HyperPayProvider client={client}>
        <PayModal
          open
          to="alice@magicblock.id"
          amount="10 USDC"
          onClose={() => {}}
          onSettled={onSettled}
        />
      </HyperPayProvider>,
    )
    await waitFor(() => expect(client.quote).toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await waitFor(() => expect(client.pay).toHaveBeenCalled())
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(payment))
  })

  it('renders nothing when closed', () => {
    render(
      <Probe>
        <PayModal open={false} to="alice@magicblock.id" amount="10 USDC" onClose={() => {}} />
      </Probe>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <Probe>
        <PayModal open to="alice@magicblock.id" amount="10 USDC" onClose={onClose} />
      </Probe>,
    )
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('reports pay failures through onError', async () => {
    const onError = vi.fn()
    const client = mockClient({ pay: vi.fn().mockRejectedValue(new Error('no funds')) })
    render(
      <HyperPayProvider client={client}>
        <PayModal open to="alice@magicblock.id" amount="10 USDC" onClose={() => {}} onError={onError} />
      </HyperPayProvider>,
    )
    await waitFor(() => expect(client.quote).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no funds' })))
  })

  it('traps Tab focus inside the dialog', async () => {
    render(
      <Probe>
        <PayModal open to="alice@magicblock.id" amount="10 USDC" onClose={() => {}} />
      </Probe>,
    )
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    const cancel = screen.getByRole('button', { name: /cancel/i })
    const confirm = screen.getByRole('button', { name: /confirm/i })
    cancel.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    confirm.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
  })
})

describe('PaymentStatus', () => {
  it('shows a settled signature', () => {
    render(<PaymentStatus status="success" payment={payment} />)
    expect(screen.getByText(/sig111/)).toBeTruthy()
    expect(screen.getByText(/10 USDC/)).toBeTruthy()
  })

  it('shows an error message', () => {
    render(<PaymentStatus status="error" error={new Error('blocked by policy')} />)
    expect(screen.getByText(/blocked by policy/i)).toBeTruthy()
  })
})

describe('usePay', () => {
  it('records success and error from pay()', async () => {
    const client = mockClient()
    function Capture() {
      const { pay, status, payment, error } = usePay()
      return (
        <div>
          <span>{status}</span>
          <span>{payment?.signature ?? ''}</span>
          <span>{error?.message ?? ''}</span>
          <button type="button" onClick={() => void pay('alice@magicblock.id', '10 USDC').catch(() => {})}>
            go
          </button>
        </div>
      )
    }
    const { rerender } = render(
      <HyperPayProvider client={client}>
        <Capture />
      </HyperPayProvider>,
    )
    expect(screen.getByText('idle')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => expect(screen.getByText('success')).toBeTruthy())
    expect(screen.getByText('sig111')).toBeTruthy()

    const failing = mockClient({ pay: vi.fn().mockRejectedValue(new Error('no funds')) })
    rerender(
      <HyperPayProvider client={failing}>
        <Capture />
      </HyperPayProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => expect(screen.getByText('error')).toBeTruthy())
    expect(screen.getByText(/no funds/)).toBeTruthy()
  })
})

describe('useBalance', () => {
  it('loads balances when a client is present', async () => {
    const client = mockClient()
    function Show() {
      const { balances, loading } = useBalance()
      if (loading || !balances) return <span>loading</span>
      return <span>{`${balances.base} ${balances.token.symbol}`}</span>
    }
    render(
      <HyperPayProvider client={client}>
        <Show />
      </HyperPayProvider>,
    )
    await waitFor(() => expect(screen.getByText('100 USDC')).toBeTruthy())
    expect(client.balance).toHaveBeenCalled()
  })

  it('treats private balance as unavailable when signMessage is missing', async () => {
    const client = mockClient({
      signer: mockSigner({ signMessage: undefined }),
      balance: vi.fn().mockResolvedValue({
        address: 'payer',
        token: USDC,
        base: '100',
        baseUnits: '100000000',
      }),
    })
    function Show() {
      const { balances, loading, error } = useBalance()
      if (loading) return <span>loading</span>
      if (error) return <span>{error.message}</span>
      return <span>{`base:${balances?.base ?? 'none'} private:${balances?.private ?? 'unavailable'}`}</span>
    }
    render(
      <HyperPayProvider client={client}>
        <Show />
      </HyperPayProvider>,
    )
    await waitFor(() => expect(screen.getByText('base:100 private:unavailable')).toBeTruthy())
  })

  it('does not hard-fail when balance() rejects because signMessage is missing', async () => {
    const client = mockClient({
      signer: mockSigner({ signMessage: undefined }),
      balance: vi.fn().mockRejectedValue(
        new Error('This signer cannot sign messages, so private balances are unavailable'),
      ),
    })
    function Show() {
      const { balances, loading, error } = useBalance()
      if (loading) return <span>loading</span>
      return (
        <span>{error ? `failed:${error.message}` : `ok private:${balances?.private ?? 'unavailable'}`}</span>
      )
    }
    render(
      <HyperPayProvider client={client}>
        <Show />
      </HyperPayProvider>,
    )
    await waitFor(() => expect(screen.getByText('ok private:unavailable')).toBeTruthy())
  })
})

describe('walletAdapterSigner', () => {
  it('does not throw when the wallet is disconnected', () => {
    expect(
      walletAdapterSigner({
        publicKey: null,
        signTransaction: async (tx) => tx,
      }),
    ).toBeUndefined()
  })

  it('forwards signTransaction from a connected wallet', async () => {
    const publicKey = mockPublicKey()
    const signTransaction = vi.fn(async (tx: { x: number }) => tx)
    const signer = walletAdapterSigner({
      publicKey,
      signTransaction: signTransaction as never,
    })
    expect(signer).toBeDefined()
    expect(signer!.publicKey).toBe(publicKey)
    await signer!.signTransaction({ x: 1 } as never)
    expect(signTransaction).toHaveBeenCalled()
  })

  it('tracks a connecting and disconnecting wallet adapter', () => {
    const wallet = createConnectingWallet('payer')
    expect(walletAdapterSigner(wallet)).toBeUndefined()
    wallet.connect()
    const connected = walletAdapterSigner(wallet)
    expect(connected?.publicKey.toBase58()).toBe('payer')
    wallet.disconnect()
    expect(walletAdapterSigner(wallet)).toBeUndefined()
  })
})

describe('useWalletSigner', () => {
  it('tracks publicKey across connect and disconnect', () => {
    const wallet = createConnectingWallet()
    function Harness() {
      const signer = useWalletSigner(wallet)
      const [, setTick] = useState(0)
      return (
        <div>
          <span>{signer ? signer.publicKey.toBase58() : 'none'}</span>
          <button
            type="button"
            onClick={() => {
              wallet.connect()
              setTick((n) => n + 1)
            }}
          >
            in
          </button>
          <button
            type="button"
            onClick={() => {
              wallet.disconnect()
              setTick((n) => n + 1)
            }}
          >
            out
          </button>
        </div>
      )
    }
    render(<Harness />)
    expect(screen.getByText('none')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'in' }))
    expect(screen.getByText('payer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'out' }))
    expect(screen.getByText('none')).toBeTruthy()
  })
})

describe('wallet lifecycle', () => {
  it('shows Connect wallet until the adapter connects, then Pay', () => {
    const wallet = createConnectingWallet()
    function Harness() {
      const [, setTick] = useState(0)
      return (
        <HyperPayProvider cluster="devnet" wallet={wallet}>
          <PayButton to="alice@magicblock.id" amount="10 USDC" />
          <button
            type="button"
            onClick={() => {
              wallet.connect()
              setTick((n) => n + 1)
            }}
          >
            connect
          </button>
          <button
            type="button"
            onClick={() => {
              wallet.disconnect()
              setTick((n) => n + 1)
            }}
          >
            disconnect
          </button>
        </HyperPayProvider>
      )
    }
    render(<Harness />)
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'connect' }))
    expect(screen.getByRole('button', { name: /pay 10 usdc/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'disconnect' }))
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeTruthy()
  })
})
