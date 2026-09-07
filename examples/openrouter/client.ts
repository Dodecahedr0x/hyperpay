/**
 * End-user client: HyperPay keypair with ephemeral USDC. No OpenRouter API key.
 *
 * Tops up the proxy from the rollup, then chats. OpenRouter's bill is deducted
 * from that credit.
 *
 *   npx vite-node examples/openrouter/client.ts
 *   npx vite-node examples/openrouter/client.ts openai/gpt-4o-mini
 *   npx vite-node examples/openrouter/client.ts --stream "Say hi in one sentence."
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperPay } from '@magicblock-labs/hyperpay'

const BASE = process.env.OPENROUTER_PROXY ?? 'http://127.0.0.1:4050'
const SESSION = join(tmpdir(), 'hyperpay-openrouter.json')
const TOPUP = process.env.TOPUP_AMOUNT ?? '1 USDC'

const stream = process.argv.includes('--stream')
const rest = process.argv.slice(2).filter((a) => a !== '--stream')
const maybeModel = rest[0] && !rest[0].includes(' ') && rest[0].includes('/') ? rest[0] : undefined
const model = maybeModel ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini'
const prompt = (maybeModel ? rest.slice(1) : rest).join(' ') || 'Say hi in one sentence.'

const hp = HyperPay.fromEnv()
const quote = (await api('GET', '/quote')) as { merchant: string; mint: string }
const refId = loadRef() ?? newRefId()
saveRef(refId)

console.log('paying from', hp.signer?.publicKey.toBase58(), '(ephemeral USDC)')
if (hp.signer?.publicKey.toBase58() === quote.merchant) {
  console.log('(demo: payer and merchant share a wallet — use two keys in production)')
}

await ensureCredit(refId, quote.merchant)

const payload = {
  model,
  stream,
  messages: [{ role: 'user', content: prompt }],
}

let res = await chat(refId, payload)
if (res.status === 402) {
  const body = (await res.json()) as { needed?: string }
  await ensureCredit(refId, quote.merchant, body.needed)
  res = await chat(refId, payload)
}
await printResult(res)

const credits = await api('GET', `/credits?refId=${refId}`)
console.log('credit', credits)

async function chat(id: string, payload: unknown) {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-account': id },
    body: JSON.stringify(payload),
  })
}

async function ensureCredit(id: string, merchant: string, atLeast?: string) {
  const credits = (await api('GET', `/credits?refId=${id}`)) as { remainingUnits?: string }
  const remaining = BigInt(credits.remainingUnits ?? '0')
  const need = atLeast ? (await hp.resolveAmount(atLeast)).units : 0n
  if (!atLeast && remaining >= 1_000n) return
  if (atLeast && remaining >= need) return

  const amount = atLeast && need > (await hp.resolveAmount(TOPUP)).units ? atLeast : TOPUP
  console.log(`open session ${amount} → ${merchant}`)
  const payment = await hp.openSession(merchant, amount)
  console.log(`opened ${payment.amount}  sig ${payment.signature}`)
  await api('POST', '/topup', { signature: payment.signature, refId: id, amount: payment.amount })
}

async function printResult(res: Response) {
  console.log(`${res.status} ${res.statusText}`)
  const charged = res.headers.get('x-openrouter-cost-usd')
  const remaining = res.headers.get('x-credit-remaining')
  if (charged) console.log(`openrouter billed $${charged} → remaining ${remaining}`)
  if (!res.ok) {
    console.log(await res.text())
    process.exitCode = 1
    return
  }
  if (stream) {
    await printStream(res)
    return
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  console.log(data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2))
}

async function printStream(res: Response) {
  if (!res.body) return
  const decoder = new TextDecoder()
  let leftover = ''
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    leftover += decoder.decode(value, { stream: true })
    const lines = leftover.split('\n')
    leftover = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') {
        process.stdout.write('\n')
        return
      }
      try {
        const delta = (JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] })
          .choices?.[0]?.delta?.content
        if (delta) process.stdout.write(delta)
      } catch {
        // keepalives
      }
    }
  }
  process.stdout.write('\n')
}

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
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (res.status >= 400) throw new Error((json as { message?: string }).message ?? `${res.status}`)
  return json
}
