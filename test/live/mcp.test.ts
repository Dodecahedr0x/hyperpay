import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Drives the built MCP server over stdio with a real MCP client — the same way
 * Claude Code or Cursor would. Requires `npm run build` and the same E2E_* env
 * the payment e2e uses.
 */
const { E2E_PAYER_KEY, E2E_PAYEE, E2E_MINT } = process.env
const configured = Boolean(E2E_PAYER_KEY && E2E_PAYEE && E2E_MINT)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe.skipIf(!configured)('MCP server over stdio', () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ name: 'hyperpay-test', version: '0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(root, 'packages/hyperpay/dist/mcp.js')],
        env: {
          PATH: process.env.PATH!,
          HYPERPAY_KEY: E2E_PAYER_KEY!,
          HYPERPAY_CLUSTER: 'devnet',
          HYPERPAY_TOKENS: `TEST:${E2E_MINT}:6`,
          HYPERPAY_TOKEN: 'TEST',
          HYPERPAY_MAX_PER_TX: '5 TEST',
          HYPERPAY_DAILY_CAP: '50 TEST',
          HYPERPAY_JOURNAL: resolve(root, 'test/.artifacts/mcp-spend.json'),
        },
      }),
    )
  }, 60_000)

  afterAll(async () => {
    await client?.close()
  })

  it('advertises the payment tools an agent needs', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'balance',
      'charge',
      'deposit',
      'open_session',
      'policy',
      'session_balance',
      'withdraw',
    ])
  })

  it('reports its spending limits so an agent knows its budget', async () => {
    const res = await client.callTool({ name: 'policy', arguments: {} })
    const text = (res.content as { text: string }[])[0]!.text
    expect(text).toContain('max per tx:    5 TEST')
    expect(text).toContain('daily cap:     50 TEST')
    expect(text).toContain('cluster:       devnet')
  })

  it('reads a session balance', async () => {
    const res = await client.callTool({
      name: 'session_balance',
      arguments: { user: E2E_PAYEE! },
    })
    expect(res.isError).toBeFalsy()
    expect((res.content as { text: string }[])[0]!.text).toMatch(/TEST/)
  })

  it('reads a live balance', async () => {
    const res = await client.callTool({ name: 'balance', arguments: {} })
    expect((res.content as { text: string }[])[0]!.text).toMatch(/TEST/)
  })

  it('refuses a payment over the cap and says why, without erroring out', async () => {
    const res = await client.callTool({
      name: 'open_session',
      arguments: { merchant: E2E_PAYEE!, amount: '9 TEST' },
    })
    expect(res.isError).toBe(true)
    expect((res.content as { text: string }[])[0]!.text).toMatch(
      /Blocked by spend policy.*per-transaction cap of 5 TEST/,
    )
  })

  it('sends a real payment', async () => {
    const res = await client.callTool({
      name: 'open_session',
      arguments: { merchant: E2E_PAYEE!, amount: '1 TEST' },
    })
    expect(res.isError).toBeFalsy()
    expect((res.content as { text: string }[])[0]!.text).toMatch(/Opened session .*Signature: [1-9A-HJ-NP-Za-km-z]{64,}/s)
  }, 120_000)
})
