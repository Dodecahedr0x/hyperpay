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
    'pay',
    {
      title: 'Send a payment',
      description:
        'Pay a Solana address or stealth handle (alice@magicblock.id). Private by default: ' +
        'the transfer settles inside a MagicBlock ephemeral rollup rather than publicly on Solana. ' +
        'Subject to the configured spend caps and recipient allow list.',
      inputSchema: {
        to: z.string().describe('Recipient pubkey or stealth handle'),
        amount: z.string().describe('Amount, e.g. "10 USDC" or "2.5"'),
        token: z.string().optional().describe('Token symbol or mint; defaults to USDC'),
        visibility: z.enum(['private', 'public']).optional(),
        memo: z.string().optional(),
      },
    },
    async ({ to, amount, token, visibility, memo }) => {
      try {
        const p = await hp.pay(to, amount, { token, visibility, memo })
        return ok(
          `Paid ${p.amount} to ${p.to} (${p.visibility}, settled on ${p.settledOn}). Signature: ${p.signature}`,
          p as unknown as Record<string, unknown>,
        )
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'quote',
    {
      title: 'Price a payment without sending it',
      description:
        'Check what a payment would cost and whether the spend policy allows it. Sends nothing. ' +
        'Use this before pay when the amount is uncertain.',
      inputSchema: {
        to: z.string(),
        amount: z.string(),
        token: z.string().optional(),
        visibility: z.enum(['private', 'public']).optional(),
      },
    },
    async ({ to, amount, token, visibility }) => {
      try {
        const q = await hp.quote(to, amount, { token, visibility })
        return ok(
          `${q.amount} to ${q.to} would settle on ${q.settlesOn} (${q.visibility}). ` +
            `Fees: ${q.fees ? `${q.fees.tokens} token base units, ${q.fees.lamports} lamports` : 'none'}.`,
          q as unknown as Record<string, unknown>,
        )
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'balance',
    {
      title: 'Read balances',
      description:
        'Base-layer and private (ephemeral rollup) balance for a token. ' +
        'Omit address to read your own wallet.',
      inputSchema: {
        token: z.string().optional(),
        address: z.string().optional(),
      },
    },
    async ({ token, address }) => {
      try {
        const b = await hp.balance({ token, address })
        return ok(
          `${b.address}: ${b.base} ${b.token.symbol} on base, ` +
            `${b.private ?? 'unknown'} ${b.token.symbol} private.`,
          b as unknown as Record<string, unknown>,
        )
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'deposit',
    {
      title: 'Fund the private balance',
      description:
        'Move tokens from the Solana base layer into the ephemeral rollup, where private transfers spend from.',
      inputSchema: { amount: z.string(), token: z.string().optional() },
    },
    async ({ amount, token }) => {
      try {
        const p = await hp.deposit(amount, { token })
        return ok(`Deposited ${p.amount}. Signature: ${p.signature}`, p as unknown as Record<string, unknown>)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'withdraw',
    {
      title: 'Move funds back to the base layer',
      description: 'Withdraw tokens from the ephemeral rollup to the Solana base layer.',
      inputSchema: { amount: z.string(), token: z.string().optional() },
    },
    async ({ amount, token }) => {
      try {
        const p = await hp.withdraw(amount, { token })
        return ok(`Withdrew ${p.amount}. Signature: ${p.signature}`, p as unknown as Record<string, unknown>)
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
      const token = await hp.resolveAmount('0', symbol).then((r) => r.token)
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

// `hyperpay mcp` and `node dist/mcp.js` both land here.
if (process.argv[1] && /(?:^|[\\/])mcp\.[jt]s$/.test(process.argv[1])) {
  runMcpServer().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
