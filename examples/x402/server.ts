/**
 * A paid HTTP resource. No framework — just node:http + Paywall.
 *
 *   export HYPERPAY_KEY=~/.config/solana/id.json
 *   export HYPERPAY_CLUSTER=devnet
 *   npx vite-node examples/x402/server.ts
 *
 * Then run examples/x402/client.ts against it.
 *
 * This demo merchant is the same wallet as the payer (self-pay). Production
 * uses two wallets: the server signs as the merchant, the client as the buyer.
 */
import { createServer } from 'node:http'
import { HyperPay } from '@magicblock-labs/hyperpay'
import { Paywall, challengeBody, PAYMENT_HEADER } from '@magicblock-labs/hyperpay/x402'

const PORT = 4021
const PATH = '/snapshot'

const hp = HyperPay.fromEnv()
const paywall = new Paywall({
  hp,
  price: process.env.PRICE ?? '0.01 USDC',
  description: 'premium SOL/USDC market snapshot',
})

const server = createServer(async (req, res) => {
  try {
    await handle(req, res)
  } catch (error) {
    console.error('request failed:', error instanceof Error ? error.message : error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal_error' }))
    }
  }
})

async function handle(
  req: Parameters<Parameters<typeof createServer>[1]>[0],
  res: Parameters<Parameters<typeof createServer>[1]>[1],
) {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (req.method !== 'GET' || path !== PATH) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
    return
  }

  const result = await paywall.verify(req.headers[PAYMENT_HEADER] as string | undefined)

  if (!result.ok) {
    const requirement = await paywall.challenge()
    console.log(`402 → ${requirement.display} (ref ${requirement.refId}): ${result.reason}`)
    res.writeHead(402, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...challengeBody(requirement), reason: result.reason }))
    return
  }

  // `settled` — base-layer balances prove the credit.
  // `accepted` — the tx confirmed and matches the refId, but the amount is not
  // publicly observable (private transfer). Poll hp.balance() if you need
  // certainty before releasing something costly. Do not wait on the tx itself.
  console.log(`200 → paid (${result.strength}) sig ${result.proof?.signature}`)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      asOf: new Date().toISOString(),
      pair: 'SOL/USDC',
      last: '142.18',
      bid: '142.15',
      ask: '142.21',
      volume24h: '18420000',
      verification: result.strength,
    }),
  )
}

server.listen(PORT, () => {
  console.log(`paid snapshot on http://127.0.0.1:${PORT}${PATH}`)
  console.log(`merchant wallet: ${hp.signer?.publicKey.toBase58()}`)
})
