/**
 * Full proxy loop with no OpenRouter account and no funded wallet.
 *
 *   npx vitest run examples/openrouter/e2e.test.ts
 *
 * Optional live HyperPay top-up (devnet USDC):
 *   E2E_PAYER_KEY=~/.config/solana/id.json npx vitest run examples/openrouter/e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Keypair } from '@solana/web3.js'
import { HyperPay } from '@magicblock-labs/hyperpay-core'

const merchantKey = Keypair.generate()
process.env.HYPERPAY_KEY = JSON.stringify(Array.from(merchantKey.secretKey))
process.env.HYPERPAY_CLUSTER = 'devnet'
process.env.OPENROUTER_API_KEY = 'sk-or-e2e'

const MODEL = 'openai/gpt-4o-mini'
const COST_USD = 0.00001
const DEBIT = 10n // COST_USD at 6 decimals, under the max_tokens: 16 hold
let completions = 0
let proxyUrl = ''
let mock: Server
let proxy: Server

beforeAll(async () => {
  mock = await listenMock()
  process.env.OPENROUTER_BASE = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/api/v1`
  const { start } = await import('./server.ts')
  const started = await start(0)
  proxy = started.server
  proxyUrl = `http://127.0.0.1:${started.port}`
})

afterAll(async () => {
  await close(proxy)
  await close(mock)
})

describe('openrouter proxy e2e', () => {
  const refId = '42'

  it('quotes the merchant and USDC mint', async () => {
    const quote = await api('GET', '/quote')
    expect(quote.merchant).toBe(merchantKey.publicKey.toBase58())
    expect(quote.token).toBe('USDC')
  })

  it('returns 503 when OPENROUTER_API_KEY is missing', async () => {
    const prev = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account': refId },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
    })
    process.env.OPENROUTER_API_KEY = prev
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('openrouter_unconfigured')
  })

  it('refuses a completion before OpenRouter when credit cannot cover the hold', async () => {
    completions = 0
    const res = await chat(refId, { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: string; neededUnits: string }
    expect(body.error).toBe('payment_required')
    expect(BigInt(body.neededUnits)).toBeGreaterThan(0n)
    expect(completions).toBe(0)
  })

  it('credits a top-up receipt and rejects replays', async () => {
    const first = await api('POST', '/topup', { signature: 'sig-'.padEnd(40, 'a'), refId, amount: '1 USDC' })
    expect(first.remainingUnits).toBe('1000000')
    const replay = await fetch(`${proxyUrl}/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: 'sig-'.padEnd(40, 'a'), refId, amount: '1 USDC' }),
    })
    expect(replay.status).toBe(409)
  })

  it('forwards a completion, captures OpenRouter cost, and refunds unused hold', async () => {
    const before = (await api('GET', `/credits?refId=${refId}`)) as { remainingUnits: string }
    const res = await chat(refId, { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-openrouter-cost-usd')).toBe(String(COST_USD))
    const data = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(data.choices[0]!.message.content).toBe('hello from mock')

    const after = (await api('GET', `/credits?refId=${refId}`)) as { remainingUnits: string; charged: string }
    expect(BigInt(after.remainingUnits)).toBe(BigInt(before.remainingUnits) - DEBIT)
    expect(after.charged).toBe('0.00001 USDC')
  })

  it('releases the hold when OpenRouter fails', async () => {
    const before = (await api('GET', `/credits?refId=${refId}`)) as { remainingUnits: string }
    const res = await chat(refId, {
      model: 'fail/me',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(500)
    const after = (await api('GET', `/credits?refId=${refId}`)) as { remainingUnits: string }
    expect(after.remainingUnits).toBe(before.remainingUnits)
  })

  it('streams a completion and still settles the bill', async () => {
    const before = (await api('GET', `/credits?refId=${refId}`)) as { remainingUnits: string }
    const res = await chat(refId, {
      model: MODEL,
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('hello from mock')
    expect(text).toContain('[DONE]')

    const after = (await api('GET', `/credits?refId=${refId}`)) as { remainingUnits: string }
    expect(BigInt(after.remainingUnits)).toBe(BigInt(before.remainingUnits) - DEBIT)
  })
})

describe.skipIf(!process.env.E2E_PAYER_KEY)('live HyperPay top-up', () => {
  it('pays the merchant from the rollup and unlocks a completion', async () => {
    const hp = new HyperPay({ key: process.env.E2E_PAYER_KEY, cluster: 'devnet' })
    const quote = (await api('GET', '/quote')) as { merchant: string }
    const refId = String(Date.now())
    const payment = await hp.openSession(quote.merchant, '0.01 USDC')
    await api('POST', '/topup', { signature: payment.signature, refId, amount: payment.amount })

    const res = await chat(refId, { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-openrouter-cost-usd')).toBe(String(COST_USD))
  }, 180_000)
})

function chat(refId: string, body: unknown) {
  return fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-account': refId },
    body: JSON.stringify(body),
  })
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${proxyUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = (await res.json()) as Record<string, string>
  if (res.status >= 400) throw new Error(json.message ?? `${res.status}`)
  return json
}

function listenMock(): Promise<Server> {
  const s = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/api/v1/models') {
      json(res, 200, {
        data: [{ id: MODEL, pricing: { prompt: '0.00000015', completion: '0.0000006' } }],
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/generation') {
      json(res, 200, { data: { total_cost: COST_USD } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/chat/completions') {
      completions++
      const payload = JSON.parse((await readBody(req)).toString() || '{}') as {
        stream?: boolean
        model?: string
      }
      if (payload.model === 'fail/me') {
        json(res, 500, { error: { message: 'upstream failed' } })
        return
      }
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content: 'hello from mock' } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      json(res, 200, { id: 'gen-1', choices: [{ message: { content: 'hello from mock' } }] })
      return
    }
    json(res, 404, { error: 'not_found' })
  })
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)))
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function close(s?: Server) {
  return new Promise<void>((resolve, reject) => {
    if (!s) return resolve()
    s.close((err) => (err ? reject(err) : resolve()))
  })
}
