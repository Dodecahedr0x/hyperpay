/**
 * Prepaid weather-forecast tokens. Clients pay this wallet, then spend credit.
 *
 *   export HYPERPAY_KEY=~/.config/solana/id.json
 *   export HYPERPAY_CLUSTER=devnet
 *   npx vite-node examples/metered/provider.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { formatAmount, HyperPay } from '@magicblock-labs/hyperpay'

const PORT = 4040
const PRICE = '0.01 USDC'
const CITIES = ['Lisbon', 'Tokyo', 'Nairobi', 'Reykjavik', 'Austin'] as const
const SKIES = ['clear', 'clouds', 'wind', 'rain'] as const

const hp = HyperPay.fromEnv()
const merchant = hp.signer?.publicKey.toBase58()
if (!merchant) throw new Error('Set HYPERPAY_KEY — top-ups credit this wallet')

const { token, units: priceUnits } = await hp.resolveAmount(PRICE)

// ponytail: in-memory ledger; write a JSON file or sqlite when this process must survive a restart
const accounts = new Map<string, { remaining: number; used: number }>()
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
    const raw = url.searchParams.get('units')
    const units = raw ? parseUnits(raw) : undefined
    json(res, 200, {
      resource: 'weather-forecast-tokens',
      description: 'One token = one city-day forecast',
      pricePerUnit: PRICE,
      ...(units !== undefined ? { units, amount: formatAmount(priceUnits * BigInt(units), token) } : {}),
      merchant,
      mint: token.mint,
      token: token.symbol,
      decimals: token.decimals,
      cluster: hp.cluster,
      note: 'Open a session first: hp.openSession(merchant, amount). Then POST /topup { signature, refId, units }.',
    })
    return
  }

  if (req.method === 'GET' && path === '/credits') {
    const refId = parseRefId(url.searchParams.get('refId'))
    const acct = accounts.get(refId)
    json(res, 200, { refId, remaining: acct?.remaining ?? 0, used: acct?.used ?? 0 })
    return
  }

  if (req.method === 'POST' && path === '/topup') {
    const body = await readJson(req)
    const refId = parseRefId(body.refId)
    const units = parseUnits(body.units)
    const signature = body.signature
    if (typeof signature !== 'string' || signature.length < 32) {
      json(res, 400, { error: 'bad_receipt', message: 'signature is required' })
      return
    }
    if (seen.has(signature)) {
      json(res, 409, { error: 'replay', message: 'this signature was already credited' })
      return
    }

    // Private HyperPay transfers are not publicly indexed. There is no waitForCredit
    // or charge API. We require payment *to this wallet* (the quote's merchant), then
    // credit from the receipt the client presents. A balance read can corroborate
    // that *some* private funds arrived; it cannot prove this signature moved
    // `units` — especially when the demo payer and merchant share a key.
    seen.add(signature)
    const acct = accounts.get(refId) ?? { remaining: 0, used: 0 }
    acct.remaining += units
    accounts.set(refId, acct)

    let merchantPrivate: string | undefined
    try {
      merchantPrivate = (await hp.balance()).private
    } catch {
      // Private balance needs a live session; absence is not a failed payment.
    }

    console.log(`topup +${units} → ref ${refId} (remaining ${acct.remaining}) sig ${signature}`)
    json(res, 200, {
      refId,
      credited: units,
      remaining: acct.remaining,
      verification: {
        strength: 'receipt',
        paidTo: merchant,
        note:
          'Private transfers are not on the public explorer. Credited from a receipt aimed at this merchant. Poll hp.balance() in production until private funds show up.',
        merchantPrivateBalance: merchantPrivate,
      },
    })
    return
  }

  if (req.method === 'POST' && path === '/use') {
    const body = await readJson(req)
    const refId = parseRefId(body.refId)
    const units = parseUnits(body.units)
    const acct = accounts.get(refId)

    if (!acct || acct.remaining < units) {
      json(res, 402, {
        error: 'payment_required',
        message: 'Not enough forecast credit. Pay the merchant and POST /topup.',
        remaining: acct?.remaining ?? 0,
        needed: units,
        quote: { pricePerUnit: PRICE, merchant, mint: token.mint },
      })
      return
    }

    const city = typeof body.city === 'string' && body.city.trim() ? body.city.trim() : undefined
    const forecasts = []
    for (let i = 0; i < units; i++) {
      forecasts.push(issue(city ?? CITIES[(acct.used + i) % CITIES.length]!, acct.used + i))
    }
    acct.remaining -= units
    acct.used += units

    console.log(`use ${units} → ref ${refId} (remaining ${acct.remaining})`)
    json(res, 200, { forecasts, remaining: acct.remaining, refId })
    return
  }

  json(res, 404, { error: 'not_found' })
}

function issue(city: string, offset: number) {
  const date = new Date(Date.UTC(2026, 7, 19 + offset)).toISOString().slice(0, 10)
  const seed = [...city].reduce((n, c) => n + c.charCodeAt(0), offset)
  return {
    city,
    date,
    highC: 12 + (seed * 7) % 22,
    lowC: 2 + (seed * 5) % 14,
    conditions: SKIES[seed % SKIES.length] ?? 'clear',
    unit: 1,
  }
}

function parseUnits(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('units must be an integer 1–1000')
  return n
}

function parseRefId(v: unknown): string {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error('refId must be a non-negative integer string')
  return v
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>)
      } catch {
        reject(new Error('body must be JSON'))
      }
    })
    req.on('error', reject)
  })
}

server.listen(PORT, () => {
  console.log(`weather tokens on http://127.0.0.1:${PORT}  (${PRICE} / forecast)`)
  console.log(`merchant wallet: ${merchant}`)
  console.log(`GET /quote  POST /topup  POST /use  GET /credits?refId=`)
})
