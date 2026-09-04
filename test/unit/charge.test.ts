import { afterEach, describe, expect, it, vi } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { HyperPay, PaymentsApi } from '@magicblock-labs/hyperpay-core'
import { PolicyError } from '@magicblock-labs/hyperpay-types'
import type { ChargeRequest, SessionBalanceResponse } from '@magicblock-labs/hyperpay-types'
import type { HyperPaySigner } from '@magicblock-labs/hyperpay-solana'

const USER = 'User11111111111111111111111111111111'
const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const API = 'https://payments.test'

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function merchantSigner(): HyperPaySigner {
  return {
    publicKey: new PublicKey(MERCHANT),
    signTransaction: async (tx) => tx,
  }
}

describe('PaymentsApi.sessionBalance', () => {
  it('GETs user merchant mint cluster and parses the remaining units string', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(url.origin + url.pathname).toBe(`${API}/v1/spl/session-balance`)
      expect(url.searchParams.get('user')).toBe(USER)
      expect(url.searchParams.get('merchant')).toBe(MERCHANT)
      expect(url.searchParams.get('mint')).toBe(DEVNET_USDC)
      expect(url.searchParams.get('cluster')).toBe('devnet')
      const body: SessionBalanceResponse = {
        user: USER,
        merchant: MERCHANT,
        mint: DEVNET_USDC,
        balance: '5000',
      }
      return jsonOk(body)
    })

    const api = new PaymentsApi({ baseUrl: API, fetch: fetch as typeof globalThis.fetch })
    const res = await api.sessionBalance(USER, MERCHANT, DEVNET_USDC, 'devnet')

    expect(res.balance).toBe('5000')
    expect(res.user).toBe(USER)
    expect(res.merchant).toBe(MERCHANT)
    expect(res.mint).toBe(DEVNET_USDC)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('PaymentsApi.charge', () => {
  it('POSTs a camelCase debit request and returns the build', async () => {
    const req: ChargeRequest = {
      user: USER,
      merchant: MERCHANT,
      mint: DEVNET_USDC,
      amount: 10_000,
      cluster: 'devnet',
      visibility: 'private',
    }

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${API}/v1/spl/charge`)
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        user: USER,
        merchant: MERCHANT,
        mint: DEVNET_USDC,
        amount: 10_000,
        cluster: 'devnet',
        visibility: 'private',
      })
      return jsonOk({
        kind: 'transfer',
        version: 'legacy',
        transactionBase64: 'dGVzdA==',
        sendTo: 'ephemeral',
        recentBlockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 1,
        instructionCount: 1,
        requiredSigners: [],
      })
    })

    const api = new PaymentsApi({ baseUrl: API, fetch: fetch as typeof globalThis.fetch })
    const res = await api.charge(req)

    expect(res.transactionBase64).toBe('dGVzdA==')
    expect(res.sendTo).toBe('ephemeral')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('HyperPay.sessionBalance', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reads remaining units for the user against this merchant and the default mint', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/v1/spl/session-balance')
      expect(url.searchParams.get('user')).toBe(USER)
      expect(url.searchParams.get('merchant')).toBe(MERCHANT)
      expect(url.searchParams.get('mint')).toBe(DEVNET_USDC)
      expect(url.searchParams.get('cluster')).toBe('devnet')
      return jsonOk({
        user: USER,
        merchant: MERCHANT,
        mint: DEVNET_USDC,
        balance: '42000',
      })
    })
    globalThis.fetch = fetch as typeof globalThis.fetch

    const hp = new HyperPay({
      signer: merchantSigner(),
      cluster: 'devnet',
      apiUrl: API,
    })
    const bal = await hp.sessionBalance(USER)

    expect(bal.address).toBe(USER)
    expect(bal.baseUnits).toBe('42000')
    expect(bal.base).toBe('0.042')
    expect(bal.token.mint).toBe(DEVNET_USDC)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('HyperPay.charge', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('checks policy against the merchant before it posts a charge', async () => {
    const fetch = vi.fn()
    globalThis.fetch = fetch as typeof globalThis.fetch

    const hp = new HyperPay({
      signer: merchantSigner(),
      cluster: 'devnet',
      apiUrl: API,
      policy: { deny: [MERCHANT] },
    })

    await expect(hp.charge(USER, '0.01 USDC')).rejects.toBeInstanceOf(PolicyError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('posts a private charge for this merchant and does not submit a chain transaction', async () => {
    const fetch = vi.fn(async () =>
      jsonOk({
        kind: 'transfer',
        version: 'legacy',
        transactionBase64: 'not-a-real-transaction',
        sendTo: 'ephemeral',
        recentBlockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 1,
        instructionCount: 1,
        requiredSigners: [],
      }),
    )
    globalThis.fetch = fetch as typeof globalThis.fetch

    const hp = new HyperPay({
      signer: merchantSigner(),
      cluster: 'devnet',
      apiUrl: API,
    })

    await expect(hp.charge(USER, '0.01 USDC')).rejects.toThrow(
      /invalid|decode|transaction|buffer/i,
    )

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe(`${API}/v1/spl/charge`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      user: USER,
      merchant: MERCHANT,
      mint: DEVNET_USDC,
      amount: 10_000,
      cluster: 'devnet',
      visibility: 'private',
    })
  })
})
