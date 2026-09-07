#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { HyperPay } from '@magicblock-labs/hyperpay-core'
import { HyperPayError, PolicyError, type Cluster } from '@magicblock-labs/hyperpay-types'

const HELP = `
hyperpay — payment sessions on Solana.

USAGE
  hyperpay init-user <lamports>              Create the User PDA
  hyperpay delegate-user                     Delegate the User PDA to the ER
  hyperpay top-up <amount>                   Deposit wallet ATA tokens into the User eATA
  hyperpay open-session <merchant> [amount]  Open a session (amount may be 0)
  hyperpay deposit <merchant> <amount>       Reserve more into a session
  hyperpay charge <user> <amount>            Merchant debit of a session
  hyperpay close-session <merchant>          Close a session (user only)
  hyperpay withdraw <amount>                 Withdraw unreserved eATA tokens
  hyperpay session-balance <user>            Remaining units for this merchant
  hyperpay balance                           Show the wallet ATA balance
  hyperpay address                           Print the configured wallet address
  hyperpay mcp                               Run the MCP server on stdio

OPTIONS
  --token <symbol|mint>   Token (default USDC)
  --authority <pubkey>    Wallet that owns the User PDA (when signer is a session key)
  --destination <pubkey>  Withdraw destination owner (default: signer)
  --cluster <name|url>    mainnet | devnet | an RPC URL
  --address <pubkey>      Read someone else's ATA balance
  --yes, -y               Skip the confirmation prompt
  --json                  Machine-readable output
  --help, -h              Show this

ENVIRONMENT
  HYPERPAY_KEY            Secret key (base58, JSON array, or file path)
  HYPERPAY_CLUSTER        Default cluster
  HYPERPAY_RPC            Base-layer RPC override
  HYPERPAY_EPHEMERAL_RPC  Ephemeral-rollup RPC override
  HYPERPAY_MAX_PER_TX     Per-transaction spend cap, e.g. "25 USDC"
  HYPERPAY_DAILY_CAP      Daily spend cap
  HYPERPAY_ALLOW          Comma-separated recipient allow list
  HYPERPAY_TOKENS         Custom mints, e.g. "TEST:<mint>:6"

EXAMPLES
  hyperpay open-session 9WzD...AWWM "10 USDC"
  hyperpay charge 8fRp...LhHR 1 --token USDC
  hyperpay session-balance 8fRp...LhHR
`.trim()

const options = {
  token: { type: 'string' },
  authority: { type: 'string' },
  destination: { type: 'string' },
  cluster: { type: 'string' },
  address: { type: 'string' },
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

  const sessionOpts = {
    token: values.token,
    authority: values.authority,
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
      out(`${b.address}\n  ${b.base} ${b.token.symbol}`, b)
      return 0
    }

    case 'session-balance': {
      const [user] = requireArgs(rest, 1, 'session-balance <user>')
      const b = await hp.sessionBalance(user!)
      out(`${b.address}\n  remaining ${b.base} ${b.token.symbol}`, b)
      return 0
    }

    case 'init-user': {
      const [lamports] = requireArgs(rest, 1, 'init-user <lamports>')
      const p = await hp.initUser(BigInt(lamports!))
      out(`Initialized user\n  signature ${p.signature}`, p)
      return 0
    }

    case 'delegate-user': {
      const p = await hp.delegateUser()
      out(`Delegated user\n  signature ${p.signature}`, p)
      return 0
    }

    case 'top-up': {
      const amount = requireArgs(rest, 1, 'top-up <amount>').join(' ')
      const p = await hp.topUp(amount, sessionOpts)
      out(`Topped up ${p.amount}\n  signature ${p.signature}`, p)
      return 0
    }

    case 'open-session': {
      const [merchant, ...amountParts] = requireArgs(rest, 1, 'open-session <merchant> [amount]')
      const amount = amountParts.join(' ') || 0
      const p = await hp.openSession(merchant!, amount, sessionOpts)
      out(`Opened session with ${p.to}\n  signature ${p.signature}`, p)
      return 0
    }

    case 'deposit': {
      const [merchant, ...amountParts] = requireArgs(rest, 2, 'deposit <merchant> <amount>')
      const p = await hp.deposit(merchant!, amountParts.join(' '), sessionOpts)
      out(`Deposited ${p.amount}\n  signature ${p.signature}`, p)
      return 0
    }

    case 'charge': {
      const [user, ...amountParts] = requireArgs(rest, 2, 'charge <user> <amount>')
      const amount = amountParts.join(' ')
      if (!values.yes && !values.json && process.stdin.isTTY) {
        const q = await hp.quote(hp.signer!.publicKey.toBase58(), amount, { token: values.token })
        const ok = await confirm(`Charge ${q.amount} from ${user}? [y/N] `)
        if (!ok) {
          console.log('Cancelled.')
          return 1
        }
      }
      const p = await hp.charge(user!, amount, { token: values.token })
      out(
        `Charged ${p.amount}\n  signature   ${p.signature}\n  settled on  ${p.settledOn}` +
          (p.explorerUrl ? `\n  explorer    ${p.explorerUrl}` : ''),
        p,
      )
      return 0
    }

    case 'close-session': {
      const [merchant] = requireArgs(rest, 1, 'close-session <merchant>')
      const p = await hp.closeSession(merchant!, sessionOpts)
      out(`Closed session with ${p.to}\n  signature ${p.signature}`, p)
      return 0
    }

    case 'withdraw': {
      const amount = requireArgs(rest, 1, 'withdraw <amount>').join(' ')
      const p = await hp.withdraw(amount, { ...sessionOpts, destination: values.destination })
      out(`Withdrew ${p.amount}\n  signature ${p.signature}`, p)
      return 0
    }

    default:
      console.error(`Unknown command "${command}". Run \`hyperpay --help\`.`)
      return 1
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
