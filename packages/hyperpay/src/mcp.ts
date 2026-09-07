import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { HyperPay } from '@magicblock-labs/hyperpay-core'
import { formatAmount, HyperPayError, PolicyError } from '@magicblock-labs/hyperpay-types'

/**
 * MCP server exposing HyperPay to agents.
 *
 * Every payment goes through the same `Policy` the SDK uses, so the caps in the
 * environment apply to the agent whether it calls the tool politely or not.
 */
export function createMcpServer(hp: HyperPay = defaultClient()): McpServer {
  const server = new McpServer({ name: 'hyperpay', version: '0.1.0' })

  const ok = (text: string, data?: unknown) => ({
    content: [{ type: 'text' as const, text }],
    ...(data === undefined ? {} : { structuredContent: data as Record<string, unknown> }),
  })

  const fail = (error: unknown) => ({
    content: [
      {
        type: 'text' as const,
        text:
          error instanceof PolicyError
            ? `Blocked by spend policy: ${error.message}`
            : error instanceof HyperPayError
              ? error.message
              : `Payment failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  })

  server.registerTool(
    'open_session',
    {
      title: 'Open a payment session',
      description:
        'Open a session with a merchant and optionally reserve an amount. Amount may be 0. ' +
        'The user must open a session before a merchant can charge.',
      inputSchema: {
        merchant: z.string().describe('Merchant pubkey'),
        amount: z.string().optional().describe('Amount to reserve, e.g. "10 USDC". Omit or "0" for an empty session.'),
        token: z.string().optional().describe('Token symbol or mint; defaults to USDC'),
        authority: z.string().optional().describe('Wallet that owns the User PDA, if the signer is a session key'),
      },
    },
    async ({ merchant, amount, token, authority }) => {
      try {
        const p = await hp.openSession(merchant, amount ?? 0, { token, authority })
        return ok(`Opened session with ${p.to}. Signature: ${p.signature}`, p as unknown as Record<string, unknown>)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'charge',
    {
      title: 'Charge a payment session',
      description:
        'Merchant debit of a user session. The user must have opened the session first. ' +
        'Subject to the configured spend caps.',
      inputSchema: {
        user: z.string().describe('User wallet pubkey (User PDA authority)'),
        amount: z.string().describe('Amount, e.g. "10 USDC" or "2.5"'),
        token: z.string().optional(),
      },
    },
    async ({ user, amount, token }) => {
      try {
        const p = await hp.charge(user, amount, { token })
        return ok(`Charged ${p.amount}. Signature: ${p.signature}`, p as unknown as Record<string, unknown>)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'deposit',
    {
      title: 'Reserve more into a session',
      description: 'Increase remaining on an existing session against the user eATA.',
      inputSchema: {
        merchant: z.string(),
        amount: z.string(),
        token: z.string().optional(),
        authority: z.string().optional(),
      },
    },
    async ({ merchant, amount, token, authority }) => {
      try {
        const p = await hp.deposit(merchant, amount, { token, authority })
        return ok(`Deposited ${p.amount}. Signature: ${p.signature}`, p as unknown as Record<string, unknown>)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'withdraw',
    {
      title: 'Withdraw unreserved tokens',
      description: 'Move unreserved eATA tokens to a destination eATA. Does not touch session remaining.',
      inputSchema: {
        amount: z.string(),
        token: z.string().optional(),
        destination: z.string().optional(),
        authority: z.string().optional(),
      },
    },
    async ({ amount, token, destination, authority }) => {
      try {
        const p = await hp.withdraw(amount, { token, destination, authority })
        return ok(`Withdrew ${p.amount}. Signature: ${p.signature}`, p as unknown as Record<string, unknown>)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'session_balance',
    {
      title: 'Read session remaining',
      description: 'Remaining units on the ER session between `user` and this merchant.',
      inputSchema: { user: z.string() },
    },
    async ({ user }) => {
      try {
        const b = await hp.sessionBalance(user)
        return ok(`${b.address}: ${b.base} ${b.token.symbol} remaining.`, b as unknown as Record<string, unknown>)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'balance',
    {
      title: 'Read ATA balance',
      description: 'Base-layer token account balance. Omit address to read your own wallet.',
      inputSchema: {
        token: z.string().optional(),
        address: z.string().optional(),
      },
    },
    async ({ token, address }) => {
      try {
        const b = await hp.balance({ token, address })
        return ok(`${b.address}: ${b.base} ${b.token.symbol}.`, b as unknown as Record<string, unknown>)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'policy',
    {
      title: 'Show spending limits',
      description:
        'Report this wallet, its configured spend caps, and how much of the daily cap is left. ' +
        'Call this first to learn what you are allowed to spend.',
      inputSchema: {},
    },
    async () => {
      const address = hp.signer?.publicKey.toBase58() ?? '(no signer configured)'
      const env = process.env
      const spent = await spentSummary(hp)
      return ok(
        [
          `wallet:        ${address}`,
          `cluster:       ${hp.cluster}`,
          `max per tx:    ${env.HYPERPAY_MAX_PER_TX ?? 'unlimited'}`,
          `daily cap:     ${env.HYPERPAY_DAILY_CAP ?? 'unlimited'}`,
          `spent today:   ${spent}`,
          `allow list:    ${env.HYPERPAY_ALLOW ?? '(anyone)'}`,
          `deny list:     ${env.HYPERPAY_DENY ?? '(none)'}`,
        ].join('\n'),
        { address, cluster: hp.cluster, maxPerTx: env.HYPERPAY_MAX_PER_TX, dailyCap: env.HYPERPAY_DAILY_CAP },
      )
    },
  )

  return server
}

async function spentSummary(hp: HyperPay): Promise<string> {
  const caps = process.env.HYPERPAY_DAILY_CAP
  if (!caps) return 'not tracked (no daily cap set)'
  const parts: string[] = []
  for (const entry of caps.split(',')) {
    const symbol = entry.trim().split(/\s+/)[1]
    if (!symbol) continue
    try {
      const token = await hp.resolveAmount('0', symbol, { allowZero: true }).then((r) => r.token)
      parts.push(formatAmount(hp.policy.spentToday(token.symbol), token))
    } catch {
      // An unresolvable cap symbol is a config problem, not a reason to fail the tool.
    }
  }
  return parts.length ? parts.join(', ') : 'nothing yet'
}

function defaultClient(): HyperPay {
  return HyperPay.fromEnv()
}

export async function runMcpServer(hp?: HyperPay): Promise<void> {
  const server = createMcpServer(hp)
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && /(?:^|[\\/])mcp\.[jt]s$/.test(process.argv[1])) {
  runMcpServer().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
