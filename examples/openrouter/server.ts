/**
 * OpenRouter intermediary. End users only need a HyperPay keypair with USDC
 * on the ephemeral rollup. This process holds OPENROUTER_API_KEY.
 *
 * Users pay this merchant from the rollup (POST /topup). When OpenRouter
 * bills a generation, that USD cost is deducted from the user's credit.
 *
 *   export HYPERPAY_KEY=~/.config/solana/id.json
 *   export HYPERPAY_CLUSTER=devnet
 *   export OPENROUTER_API_KEY=sk-or-...   # operator only; never sent to clients
 *   # optional: OPENROUTER_BASE=http://127.0.0.1:4051/api/v1  (mock / self-host)
 *   npx vite-node examples/openrouter/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { formatAmount, HyperPay } from '@magicblock-labs/hyperpay'

const PORT = Number(process.env.PORT ?? 4050)
const DEFAULT_MAX_TOKENS = 2048
const ESTIMATE_BUFFER = 1.25
const FALLBACK_HOLD_USD = Number(process.env.FALLBACK_HOLD_USD ?? '0.25')

function openRouter(path: string) {
  return `${(process.env.OPENROUTER_BASE ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')}${path}`
}

const hp = HyperPay.fromEnv()
const merchant = hp.signer?.publicKey.toBase58()
if (!merchant) throw new Error('Set HYPERPAY_KEY — top-ups credit this wallet')

const usdc = await hp.resolveAmount('1 USDC').then((r) => r.token)

// ponytail: in-memory USDC ledger (base units). Persist when the process must survive a restart.
const accounts = new Map<string, { remaining: bigint; charged: bigint }>()
const seen = new Set<string>()

const server = createServer(async (req, res) => {
  try {
    await handle(req, res)
  } catch (error) {
    console.error('request failed:', error instanceof Error ? error.message : error)
    if (!res.headersSent) json(res, 400, { error: 'bad_request', message: String(error instanceof Error ? error.message : error) })
  }
})

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (req.method === 'GET' && path === '/quote') {
    json(res, 200, {
      merchant,
      mint: usdc.mint,
      token: usdc.symbol,
      decimals: usdc.decimals,
      cluster: hp.cluster,
      visibility: 'private',
      note:
        'Pay this merchant from your ephemeral USDC with hp.pay(merchant, amount, { refId }), then POST /topup. A completion is refused with 402 until credit covers a worst-case hold; OpenRouter is not called first.',
    })
    return
  }

  if (req.method === 'GET' && path === '/credits') {
    const refId = parseRefId(url.searchParams.get('refId'))
    json(res, 200, creditBody(refId))
    return
  }

  if (req.method === 'POST' && path === '/topup') {
    const body = await readJson(req)
    const refId = parseRefId(body.refId)
    const signature = body.signature
    if (typeof signature !== 'string' || signature.length < 32) {
      json(res, 400, { error: 'bad_receipt', message: 'signature is required' })
      return
    }
    if (seen.has(signature)) {
      json(res, 409, { error: 'replay', message: 'this signature was already credited' })
      return
    }

    const { units } = await hp.resolveAmount(String(body.amount ?? ''), usdc.symbol)
    if (units <= 0n) throw new Error('amount must be greater than zero')

    // Private transfers are not publicly indexed. Credit the receipt aimed at this
    // merchant. Production: poll hp.balance() until private USDC rises.
    seen.add(signature)
    const acct = accounts.get(refId) ?? { remaining: 0n, charged: 0n }
    acct.remaining += units
    accounts.set(refId, acct)

    console.log(`topup +${formatAmount(units, usdc)} → ref ${refId} (remaining ${formatAmount(acct.remaining, usdc)})`)
    json(res, 200, {
      ...creditBody(refId),
      credited: formatAmount(units, usdc),
      paidTo: merchant,
    })
    return
  }

  if (req.method === 'POST' && path === '/v1/chat/completions') {
    const refId = parseRefId(req.headers['x-account'] ?? url.searchParams.get('refId'))
    const acct = accounts.get(refId) ?? { remaining: 0n, charged: 0n }
    accounts.set(refId, acct)

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      json(res, 503, { error: 'openrouter_unconfigured', message: 'Set OPENROUTER_API_KEY' })
      return
    }

    const raw = await readBody(req)
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      json(res, 400, { error: 'bad_request', message: 'body must be JSON' })
      return
    }

    const streaming = payload.stream === true
    const maxTokens =
      typeof payload.max_tokens === 'number' && payload.max_tokens > 0
        ? Math.min(Math.floor(payload.max_tokens), 32_768)
        : DEFAULT_MAX_TOKENS
    payload.max_tokens = maxTokens

    const hold = await estimateHold(String(payload.model ?? ''), payload.messages, maxTokens)
    if (acct.remaining < hold) {
      const needed = hold - acct.remaining
      json(res, 402, {
        error: 'payment_required',
        message: 'Not enough credit to cover a worst-case generation. Top up before OpenRouter is called.',
        remaining: formatAmount(acct.remaining, usdc),
        remainingUnits: acct.remaining.toString(),
        hold: formatAmount(hold, usdc),
        holdUnits: hold.toString(),
        needed: formatAmount(needed, usdc),
        neededUnits: needed.toString(),
        merchant,
        mint: usdc.mint,
      })
      return
    }

    acct.remaining -= hold
    let locked = hold
    const bounded = Buffer.from(JSON.stringify(payload))
    try {
      const upstream = await fetch(openRouter('/chat/completions'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'http-referer': 'https://github.com/magicblock-labs/hyperpay',
          'x-title': 'HyperPay OpenRouter example',
        },
        body: bounded,
      })

      const contentType = upstream.headers.get('content-type') ?? 'application/json'

      if (!streaming) {
        const text = await upstream.text()
        if (!upstream.ok) {
          acct.remaining += locked
          locked = 0n
          res.writeHead(upstream.status, { 'content-type': contentType, 'x-account': refId })
          res.end(text)
          return
        }
        const billed = await settle(apiKey, refId, acct, hold, generationIdFromJson(text))
        locked = 0n
        res.writeHead(upstream.status, {
          'content-type': contentType,
          'x-account': refId,
          'x-openrouter-cost-usd': billed ? String(billed.usd) : 'hold',
          'x-credit-remaining': formatAmount(acct.remaining, usdc),
        })
        res.end(text)
        return
      }

      if (!upstream.ok) {
        const text = await upstream.text()
        acct.remaining += locked
        locked = 0n
        res.writeHead(upstream.status, { 'content-type': contentType, 'x-account': refId })
        res.end(text)
        return
      }

      res.writeHead(upstream.status, { 'content-type': contentType, 'x-account': refId })
      if (!upstream.body) {
        await settle(apiKey, refId, acct, hold, undefined)
        locked = 0n
        res.end()
        return
      }

      const reader = upstream.body.getReader()
      const chunks: Buffer[] = []
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            chunks.push(Buffer.from(value))
            res.write(value)
          }
        }
        await settle(apiKey, refId, acct, hold, generationIdFromSse(Buffer.concat(chunks).toString('utf8')))
        locked = 0n
      } finally {
        res.end()
      }
    } catch (error) {
      acct.remaining += locked
      throw error
    }
    return
  }

  json(res, 404, { error: 'not_found' })
}

async function settle(
  apiKey: string,
  refId: string,
  acct: { remaining: bigint; charged: bigint },
  hold: bigint,
  generationId: string | undefined,
): Promise<{ usd: number; debit: bigint } | undefined> {
  const usd = generationId ? await openRouterCost(apiKey, generationId) : undefined
  const actual = usd === undefined ? hold : usdToUnits(usd, usdc.decimals)
  const debit = actual > hold ? hold : actual
  acct.remaining += hold - debit
  acct.charged += debit
  if (usd === undefined) {
    console.warn(`no OpenRouter cost for ref ${refId} gen ${generationId ?? '?'} — kept hold ${formatAmount(hold, usdc)}`)
    return
  }
  console.log(
    `openrouter billed $${usd} → ${formatAmount(debit, usdc)} from ref ${refId} (remaining ${formatAmount(acct.remaining, usdc)})`,
  )
  return { usd, debit }
}

let modelPrices: { fetched: number; byId: Map<string, { prompt: number; completion: number }> } | undefined

async function estimateHold(model: string, messages: unknown, maxTokens: number): Promise<bigint> {
  const prices = await pricingFor(model)
  const promptTokens = Math.ceil(JSON.stringify(messages ?? '').length / 3)
  const usd = prices
    ? (promptTokens * prices.prompt + maxTokens * prices.completion) * ESTIMATE_BUFFER
    : FALLBACK_HOLD_USD
  const units = usdToUnits(Math.max(usd, 0), usdc.decimals)
  return units > 0n ? units : 1n
}

async function pricingFor(model: string): Promise<{ prompt: number; completion: number } | undefined> {
  if (!modelPrices || Date.now() - modelPrices.fetched > 10 * 60_000) {
    try {
      const res = await fetch(openRouter('/models'))
      const body = (await res.json()) as {
        data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[]
      }
      const byId = new Map<string, { prompt: number; completion: number }>()
      for (const m of body.data ?? []) {
        if (!m.id) continue
        byId.set(m.id, {
          prompt: Number(m.pricing?.prompt ?? 0),
          completion: Number(m.pricing?.completion ?? 0),
        })
      }
      modelPrices = { fetched: Date.now(), byId }
    } catch {
      modelPrices = { fetched: Date.now(), byId: new Map() }
    }
  }
  return modelPrices.byId.get(model)
}

function creditBody(refId: string) {
  const acct = accounts.get(refId) ?? { remaining: 0n, charged: 0n }
  return {
    refId,
    remaining: formatAmount(acct.remaining, usdc),
    remainingUnits: acct.remaining.toString(),
    charged: formatAmount(acct.charged, usdc),
  }
}

function usdToUnits(usd: number, decimals: number): bigint {
  const n = Math.ceil(usd * 10 ** decimals - 1e-12)
  return BigInt(Math.max(0, n))
}

async function openRouterCost(apiKey: string, id: string): Promise<number | undefined> {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 250 * (i + 1)))
    const res = await fetch(`${openRouter('/generation')}?id=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) continue
    const body = (await res.json()) as { data?: { total_cost?: number }; total_cost?: number }
    const cost = body.data?.total_cost ?? body.total_cost
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) return cost
  }
}

function generationIdFromJson(text: string): string | undefined {
  try {
    const id = (JSON.parse(text) as { id?: string }).id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

function generationIdFromSse(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const id = (JSON.parse(payload) as { id?: string }).id
      if (typeof id === 'string') return id
    } catch {
      // keepalives
    }
  }
}

function parseRefId(v: unknown): string {
  const s = Array.isArray(v) ? v[0] : v
  if (typeof s !== 'string' || !/^\d+$/.test(s)) throw new Error('refId must be a non-negative integer string (x-account)')
  return s
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return readBody(req).then((buf) => JSON.parse(buf.toString() || '{}') as Record<string, unknown>)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

export function start(port = PORT): Promise<{ server: typeof server; port: number }> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      console.log(`openrouter proxy on http://127.0.0.1:${addr.port}`)
      console.log(`merchant wallet: ${merchant}`)
      console.log(
        process.env.OPENROUTER_API_KEY
          ? 'OPENROUTER_API_KEY set'
          : 'OPENROUTER_API_KEY missing — completions return 503',
      )
      console.log('GET /quote  POST /topup  GET /credits  POST /v1/chat/completions')
      resolve({ server, port: addr.port })
    })
  })
}

if (!process.env.VITEST) await start()
