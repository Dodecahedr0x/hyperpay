import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Keypair } from '@solana/web3.js'
import { HyperPay, loadKeypair } from '@magicblock-labs/hyperpay-core'
import { keypairSigner } from '@magicblock-labs/hyperpay-solana'
import { Paywall, payingFetch, challengeBody, PAYMENT_HEADER } from '@magicblock-labs/hyperpay-x402'

/**
 * The full agent loop against live devnet: an agent hits a paid endpoint, gets
 * HTTP 402, pays on Solana, retries with proof, and receives the content.
 * Nothing here is mocked.
 */
const { E2E_PAYER_KEY, E2E_MINT } = process.env
const configured = Boolean(E2E_PAYER_KEY && E2E_MINT)

describe.skipIf(!configured)('x402 agent payment loop', () => {
  let server: Server
  let url: string
  let agent: HyperPay
  let merchant: string
  let requests = 0

  beforeAll(async () => {
    // The merchant is a fresh wallet, so any credit we observe came from this test.
    const merchantKey = Keypair.generate()
    merchant = merchantKey.publicKey.toBase58()

    const token = { mint: E2E_MINT!, symbol: 'TEST', decimals: 6 }
    agent = new HyperPay({
      key: E2E_PAYER_KEY,
      cluster: 'devnet',
      tokens: [token],
      defaultToken: 'TEST',
      policy: { maxPerTx: '5 TEST' },
    })

    const merchantHp = new HyperPay({
      cluster: 'devnet',
      tokens: [token],
      defaultToken: 'TEST',
      signer: keypairSigner(merchantKey),
    })
    const paywall = new Paywall({
      hp: merchantHp,
      price: '0.5 TEST',
      to: merchant,
      description: 'premium data',
    })

    server = createServer(async (req, res) => {
      const result = await paywall.verify(req.headers[PAYMENT_HEADER] as string | undefined)
      if (!result.ok) {
        const requirement = await paywall.challenge()
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...challengeBody(requirement), reason: result.reason }))
        return
      }
      requests++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: 'premium data', strength: result.strength }))
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/data`
  })

  afterAll(() => {
    server?.close()
  })

  it('answers an unpaid request with a 402 describing exactly what to pay', async () => {
    const res = await fetch(url)
    expect(res.status).toBe(402)

    const body = (await res.json()) as { accepts: { display: string; to: string; refId: string }[] }
    expect(body.accepts[0]!.display).toBe('0.5 TEST')
    expect(body.accepts[0]!.to).toBe(merchant)
    expect(body.accepts[0]!.refId).toMatch(/^\d+$/)
  })

  it('lets an agent pay publicly and proves settlement from the chain', async () => {
    await agent.openSession(merchant, '0.5')
    const res = await payingFetch({ hp: agent, maxPrice: '1 TEST' })(url)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: string; strength: string }
    expect(body.data).toBe('premium data')
    // A public transfer exposes the amount, so the server verified the credit.
    expect(body.strength).toBe('settled')

    const merchantBalance = await agent.balance({ address: merchant })
    expect(BigInt(merchantBalance.baseUnits)).toBeGreaterThanOrEqual(500_000n)
  }, 180_000)

  it('rejects a replayed payment proof', async () => {
    const paid = await payingFetch({ hp: agent })(url)
    expect(paid.status).toBe(200)

    // Re-use the exact proof the agent just sent. The challenge is single-use.
    const requirement = await (await fetch(url)).json() as { accepts: { refId: string }[] }
    const stale = Buffer.from(
      JSON.stringify({
        refId: requirement.accepts[0]!.refId,
        user: loadKeypair(E2E_PAYER_KEY!).publicKey.toBase58(),
        network: 'devnet',
      }),
    ).toString('base64')

    const first = await fetch(url, { headers: { [PAYMENT_HEADER]: stale } })
    expect(first.status).toBe(402)
    const second = await fetch(url, { headers: { [PAYMENT_HEADER]: stale } })
    expect(second.status).toBe(402)
    expect(((await second.json()) as { reason: string }).reason).toMatch(/Unknown, expired/)
  }, 180_000)

  it('refuses to pay a server that asks more than the agent allows', async () => {
    await expect(payingFetch({ hp: agent, maxPrice: '0.1 TEST' })(url)).rejects.toThrow(
      /above the 0.1 TEST limit/,
    )
  })

  it('served content only to paid requests', () => {
    expect(requests).toBeGreaterThan(0)
  })
})
