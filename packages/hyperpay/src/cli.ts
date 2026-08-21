#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { HyperPay, type PayOptions } from '@magicblock-labs/hyperpay-core'
import { HyperPayError, PolicyError, type Cluster } from '@magicblock-labs/hyperpay-types'

const HELP = `
hyperpay — the easiest way to pay on Solana. Private by default.

USAGE
  hyperpay pay <to> <amount>        Pay a pubkey or stealth handle
  hyperpay quote <to> <amount>      Price a payment without sending it
  hyperpay balance                  Show base and private balances
  hyperpay deposit <amount>         Move funds into the ephemeral rollup
  hyperpay withdraw <amount>        Move funds back to the base layer
  hyperpay init-mint [token]        Register a mint with the ephemeral validator
  hyperpay address                  Print the configured wallet address
  hyperpay mcp                      Run the MCP server on stdio (for agents)

OPTIONS
  --token <symbol|mint>   Token to pay in (default USDC)
  --public                Send publicly instead of privately
  --memo <text>           Attach a memo
  --cluster <name|url>    mainnet | devnet | an RPC URL
  --address <pubkey>      Read someone else's balance
  --split <n>             Fan a private transfer across 1-15 queue entries
  --delay <min:max>       Settlement delay window in ms, e.g. 1000:5000
  --yes, -y               Skip the confirmation prompt
  --json                  Machine-readable output
  --help, -h              Show this

ENVIRONMENT
  HYPERPAY_KEY            Secret key (base58, JSON array, or file path)
  HYPERPAY_CLUSTER        Default cluster
  HYPERPAY_MAX_PER_TX     Per-transaction spend cap, e.g. "25 USDC"
  HYPERPAY_DAILY_CAP      Daily spend cap
  HYPERPAY_ALLOW          Comma-separated recipient allow list
  HYPERPAY_TOKENS         Custom mints, e.g. "TEST:<mint>:6"

EXAMPLES
  hyperpay pay alice@magicblock.id "10 USDC"
  hyperpay pay 9WzD...AWWM 2.5 --token USDC --public
  hyperpay balance --token USDC
`.trim()

const options = {
  token: { type: 'string' },
  public: { type: 'boolean' },
  memo: { type: 'string' },
  cluster: { type: 'string' },
  address: { type: 'string' },
  split: { type: 'string' },
  delay: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true,
  })

  const [command, ...rest] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return command ? 0 : 1
  }

  if (command === 'mcp') {
    const { runMcpServer } = await import('./mcp.js')
    await runMcpServer()
    return 0
  }

  const hp = HyperPay.fromEnv({
    ...(values.cluster ? { cluster: values.cluster as Cluster } : {}),
    ...(values.token ? { defaultToken: values.token } : {}),
  })

  const out = (human: string, data: unknown) => {
    console.log(values.json ? JSON.stringify(data, null, 2) : human)
  }

  switch (command) {
    case 'address': {
      const address = hp.signer?.publicKey.toBase58()
      if (!address) throw new HyperPayError('No signer configured. Set HYPERPAY_KEY.')
      out(address, { address, cluster: hp.cluster })
      return 0
    }

    case 'balance': {
      const b = await hp.balance({ token: values.token, address: values.address })
      const priv = b.private === undefined ? '(needs a signer)' : `${b.private} ${b.token.symbol}`
      out(
        `${b.address}\n  base    ${b.base} ${b.token.symbol}\n  private ${priv}`,
        b,
      )
      return 0
    }

    case 'quote': {
      const [to, ...amountParts] = requireArgs(rest, 2, 'quote <to> <amount>')
      const q = await hp.quote(to!, amountParts.join(' '), payOptions(values))
      out(
        `${q.amount} → ${q.to}\n  visibility  ${q.visibility}\n  settles on  ${q.settlesOn}\n` +
          `  fees        ${q.fees ? `${q.fees.tokens} base units + ${q.fees.lamports} lamports` : 'none'}`,
        q,
      )
      return 0
    }

    case 'pay': {
      const [to, ...amountParts] = requireArgs(rest, 2, 'pay <to> <amount>')
      const amount = amountParts.join(' ')
      const q = await hp.quote(to!, amount, payOptions(values))

      if (!values.yes && !values.json && process.stdin.isTTY) {
        const ok = await confirm(
          `Send ${q.amount} to ${q.to} (${q.visibility}, settles on ${q.settlesOn})? [y/N] `,
        )
        if (!ok) {
          console.log('Cancelled.')
          return 1
        }
      }

      const p = await hp.pay(to!, amount, payOptions(values))
      out(
        `Paid ${p.amount} to ${p.to}\n  signature   ${p.signature}\n  settled on  ${p.settledOn}` +
          (p.explorerUrl ? `\n  explorer    ${p.explorerUrl}` : '') +
          (p.refId ? `\n  ref         ${p.refId}` : ''),
        p,
      )
      return 0
    }

    case 'deposit':
    case 'withdraw': {
      const amount = requireArgs(rest, 1, `${command} <amount>`).join(' ')
      const p = command === 'deposit' ? await hp.deposit(amount, { token: values.token }) : await hp.withdraw(amount, { token: values.token })
      out(`${command === 'deposit' ? 'Deposited' : 'Withdrew'} ${p.amount}\n  signature ${p.signature}`, p)
      return 0
    }

    case 'init-mint': {
      const r = await hp.initializeMint(rest[0] ?? values.token)
      out(
        r.alreadyInitialized
          ? `${r.mint} is already registered`
          : `Registered ${r.mint}\n  signature ${r.signature}`,
        r,
      )
      return 0
    }

    default:
      console.error(`Unknown command "${command}". Run \`hyperpay --help\`.`)
      return 1
  }
}

function payOptions(values: Record<string, unknown>): PayOptions {
  const delay = typeof values.delay === 'string' ? values.delay.split(':').map(Number) : undefined
  if (delay && (delay.length !== 2 || delay.some(Number.isNaN))) {
    throw new HyperPayError('--delay must look like "1000:5000" (min:max milliseconds)')
  }
  return {
    visibility: values.public ? 'public' : 'private',
    token: values.token as string | undefined,
    memo: values.memo as string | undefined,
    split: values.split ? Number(values.split) : undefined,
    delayMs: delay as [number, number] | undefined,
  }
}

function requireArgs(args: string[], n: number, usage: string): string[] {
  if (args.length < n) throw new HyperPayError(`Usage: hyperpay ${usage}`)
  return args
}

async function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(prompt)
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', (d) => resolve(String(d).trim().toLowerCase()))
  })
  process.stdin.pause()
  return answer === 'y' || answer === 'yes'
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof PolicyError) {
      console.error(`Blocked by spend policy: ${error.message}`)
    } else if (error instanceof HyperPayError) {
      console.error(error.message)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    process.exit(1)
  })
