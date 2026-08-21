/**
 * Buyer for the prepaid weather-token API.
 *
 *   npx vite-node examples/metered/client.ts quote
 *   npx vite-node examples/metered/client.ts buy 5
 *   npx vite-node examples/metered/client.ts use 2
 *   npx vite-node examples/metered/client.ts status
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperPay } from '@magicblock-labs/hyperpay'

const BASE = process.env.METERED_URL ?? 'http://127.0.0.1:4040'
const SESSION = join(tmpdir(), 'hyperpay-metered.json')

const [cmd, arg, city] = process.argv.slice(2)
if (!cmd || !['quote', 'buy', 'use', 'status'].includes(cmd)) {
  throw new Error('usage: client.ts quote | buy <units> | use <units> [city] | status')
}

if (cmd === 'quote') {
  const units = arg ? Number(arg) : undefined
  const q = await api('GET', units ? `/quote?units=${units}` : '/quote')
  console.log(q)
  process.exit(0)
}

if (cmd === 'status') {
  const refId = loadRef()
  if (!refId) {
    console.log('no session — run buy first')
    process.exit(0)
  }
  console.log(await api('GET', `/credits?refId=${refId}`))
  process.exit(0)
}

if (cmd === 'use') {
  const units = Number(arg)
  if (!Number.isInteger(units) || units < 1) throw new Error('use <units> [city]')
  const refId = loadRef()
  if (!refId) throw new Error('no session — run buy first')
  const { status, body } = await raw('POST', '/use', { refId, units, city })
  console.log(status === 402 ? '402 payment required — buy more tokens' : `${status}`)
  console.log(body)
  process.exit(status === 402 ? 2 : 0)
}

// buy
const units = Number(arg)
if (!Number.isInteger(units) || units < 1) throw new Error('buy <units>')

const q = (await api('GET', `/quote?units=${units}`)) as {
  merchant: string
  amount: string
  pricePerUnit: string
  mint: string
}
const hp = HyperPay.fromEnv()
const refId = loadRef() ?? newRefId()

console.log(`paying ${q.amount} to ${q.merchant} (private, ${q.pricePerUnit} × ${units})`)
console.log(`from   ${hp.signer?.publicKey.toBase58()}`)
if (hp.signer?.publicKey.toBase58() === q.merchant) {
  console.log('(demo: payer and merchant share a wallet — use two keys in production)')
}

const payment = await hp.pay(q.merchant, q.amount, { refId })
console.log(`paid   ${payment.amount}  ref ${payment.refId}  sig ${payment.signature}`)
console.log(`        private — not on the public explorer`)

const topup = await api('POST', '/topup', { signature: payment.signature, refId, units })
saveRef(refId)
console.log(topup)

function newRefId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v.toString()
}

function loadRef(): string | undefined {
  try {
    return (JSON.parse(readFileSync(SESSION, 'utf8')) as { refId?: string }).refId
  } catch {
    return undefined
  }
}

function saveRef(refId: string) {
  writeFileSync(SESSION, JSON.stringify({ refId }))
}

async function api(method: string, path: string, body?: unknown) {
  const { status, body: json } = await raw(method, path, body)
  if (status >= 400) throw new Error((json as { message?: string }).message ?? `${status}`)
  return json
}

async function raw(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}
