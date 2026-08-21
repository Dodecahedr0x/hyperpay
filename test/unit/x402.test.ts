import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HyperPay, parseTokensEnv } from '@magicblock-labs/hyperpay-core'
import {
  MemoryChallengeStore,
  Paywall,
  payingFetch,
  challengeBody,
  PAYMENT_HEADER,
  type PaymentProof,
  type PaymentRequirement,
} from '@magicblock-labs/hyperpay-x402'

const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

const hp = new HyperPay({ cluster: 'devnet' })
const paywall = () => new Paywall({ hp, price: '0.01 USDC', to: MERCHANT, description: 'test' })

const encode = (proof: PaymentProof) => Buffer.from(JSON.stringify(proof)).toString('base64')

describe('HYPERPAY_TOKENS', () => {
  it('is honoured by fromEnv, not just the CLI', () => {
    const client = HyperPay.fromEnv(
      {},
      { HYPERPAY_CLUSTER: 'devnet', HYPERPAY_TOKENS: 'TEST:7u1w42mrzdPqU2Mw8ngkKjXEbdcYEKdM1yjnwezqJtDo:6', HYPERPAY_TOKEN: 'TEST' },
    )
    return expect(client.resolveAmount('1.5')).resolves.toMatchObject({
      token: { symbol: 'TEST', decimals: 6 },
      units: 1_500_000n,
    })
  })

  it('rejects a malformed entry loudly instead of ignoring it', () => {
    expect(() => parseTokensEnv('TEST:missing-decimals')).toThrow(/SYMBOL:MINT:DECIMALS/)
    expect(parseTokensEnv(undefined)).toEqual([])
  })
})

describe('Paywall.challenge', () => {
  it('describes exactly what to pay', async () => {
    const req = await paywall().challenge()
    expect(req.scheme).toBe('hyperpay')
    expect(req.to).toBe(MERCHANT)
    expect(req.amount).toBe('10000')
    expect(req.display).toBe('0.01 USDC')
    expect(req.token.symbol).toBe('USDC')
    expect(req.refId).toMatch(/^\d+$/)
    expect(Date.parse(req.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('issues a distinct reference every time', async () => {
    const p = paywall()
    const [a, b] = [await p.challenge(), await p.challenge()]
    expect(a.refId).not.toBe(b.refId)
  })

  it('renders a 402 body an agent can act on', async () => {
    const body = challengeBody(await paywall().challenge())
    expect(body.error).toBe('payment_required')
    expect(body.accepts[0]!.display).toBe('0.01 USDC')
  })
})

describe('Paywall.verify — rejections that never touch the network', () => {
  it('rejects a missing header', async () => {
    expect(await paywall().verify(undefined)).toMatchObject({ ok: false, reason: /Missing/ })
  })

  it('rejects a malformed header', async () => {
    expect(await paywall().verify('not-base64-json')).toMatchObject({ ok: false, reason: /base64/ })
  })

  it('rejects a proof with no signature', async () => {
    const header = encode({ refId: '1', signature: '', from: 'x', network: 'devnet' })
    expect(await paywall().verify(header)).toMatchObject({ ok: false, reason: /refId and signature/ })
  })

  it('rejects a reference it never issued', async () => {
    const header = encode({ refId: '999', signature: 'sig', from: 'x', network: 'devnet' })
    expect(await paywall().verify(header)).toMatchObject({ ok: false, reason: /Unknown, expired/ })
  })
})

describe('MemoryChallengeStore', () => {
  const requirement = (refId: string, expiresAt: string) =>
    ({ refId, expiresAt }) as PaymentRequirement

  it('hands a reference out exactly once, so a proof cannot be replayed', () => {
    const store = new MemoryChallengeStore()
    store.put('abc', requirement('abc', new Date(Date.now() + 60_000).toISOString()))
    expect(store.take('abc')).toBeDefined()
    expect(store.take('abc')).toBeUndefined()
  })

  it('refuses an expired reference', () => {
    const store = new MemoryChallengeStore()
    store.put('old', requirement('old', new Date(Date.now() - 1).toISOString()))
    expect(store.take('old')).toBeUndefined()
  })
})

describe('payingFetch', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('passes through any non-402 response without paying', async () => {
    globalThis.fetch = vi.fn(async () => new Response('hello', { status: 200 })) as never
    const res = await payingFetch({ hp })('https://example.com')
    expect(res.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('returns the 402 untouched when it names no hyperpay requirement', async () => {
    globalThis.fetch = vi.fn(
      async () => Response.json({ accepts: [{ scheme: 'other' }] }, { status: 402 }),
    ) as never
    const res = await payingFetch({ hp })('https://example.com')
    expect(res.status).toBe(402)
  })

  it('refuses to pay above maxPrice', async () => {
    const requirement = await paywall().challenge()
    globalThis.fetch = vi.fn(async () => Response.json({ accepts: [requirement] }, { status: 402 })) as never

    await expect(
      payingFetch({ hp, maxPrice: '0.001 USDC' })('https://example.com'),
    ).rejects.toThrow(/above the 0.001 USDC limit/)
  })

  it('honours an approve callback that declines', async () => {
    const requirement = await paywall().challenge()
    globalThis.fetch = vi.fn(async () => Response.json({ accepts: [requirement] }, { status: 402 })) as never

    await expect(
      payingFetch({ hp, approve: () => false })('https://example.com'),
    ).rejects.toThrow(/declined/)
  })

  it('sends the proof in the X-Payment header after paying', async () => {
    const requirement = await paywall().challenge()
    const calls: RequestInit[] = []
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(init ?? {})
      return calls.length === 1
        ? Response.json({ accepts: [requirement] }, { status: 402 })
        : new Response('paid content', { status: 200 })
    }) as never

    const fakeHp = {
      ...hp,
      cluster: 'devnet',
      signer: { publicKey: { toBase58: () => 'PAYER' } },
      resolveAmount: hp.resolveAmount.bind(hp),
      pay: async () => ({ signature: 'SIG123' }),
    } as unknown as HyperPay

    const res = await payingFetch({ hp: fakeHp })('https://example.com')
    expect(res.status).toBe(200)

    const header = new Headers(calls[1]!.headers).get(PAYMENT_HEADER)!
    const proof = JSON.parse(Buffer.from(header, 'base64').toString()) as PaymentProof
    expect(proof).toMatchObject({ refId: requirement.refId, signature: 'SIG123', from: 'PAYER' })
  })
})
