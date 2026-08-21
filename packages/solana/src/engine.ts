import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import {
  ConfirmationError,
  ResolutionError,
  lookupKnownToken,
  tokenFamily,
  type BuildResponse,
  type Cluster,
  type TokenInfo,
} from '@magicblock-labs/hyperpay-types'
import { type AnyTransaction, type HyperPaySigner } from './signer.js'

export const DEFAULT_RPC: Record<'mainnet' | 'devnet', string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
}

export const DEFAULT_EPHEMERAL_RPC: Record<'mainnet' | 'devnet', string> = {
  mainnet: 'https://mainnet.magicblock.app',
  devnet: 'https://devnet.magicblock.app',
}

export function baseRpcFor(cluster: Cluster, override?: string): string {
  if (override) return override
  // A cluster given as a URL *is* the RPC.
  if (String(cluster).startsWith('http')) return String(cluster)
  return DEFAULT_RPC[tokenFamily(cluster)]
}

/**
 * Picks the network a built transaction must be submitted to.
 *
 * This is the single most common integration bug: private transfers settle on
 * the ephemeral rollup, not the base cluster, and submitting to the wrong one
 * fails with an unhelpful "blockhash not found".
 */
export function rpcForBuild(build: BuildResponse, cluster: Cluster, baseOverride?: string): string {
  if (build.sendTo === 'ephemeral') {
    return build.sendRpcEndpoint ?? DEFAULT_EPHEMERAL_RPC[tokenFamily(cluster)]
  }
  return baseRpcFor(cluster, baseOverride)
}

export function deserialize(build: BuildResponse): AnyTransaction {
  const bytes = Buffer.from(build.transactionBase64, 'base64')
  return build.version === 'v0' ? VersionedTransaction.deserialize(bytes) : Transaction.from(bytes)
}

export interface SubmitResult {
  signature: string
  rpcUrl: string
  settledOn: 'base' | 'ephemeral'
}

/** Signs a built transaction, submits it to the correct RPC, and waits for confirmation. */
export async function signAndSubmit(
  build: BuildResponse,
  signer: HyperPaySigner,
  cluster: Cluster,
  opts: {
    baseRpcUrl?: string
    /** Last chance to amend the transaction before it is signed. */
    prepare?: (tx: AnyTransaction) => AnyTransaction
  } = {},
): Promise<SubmitResult> {
  const required = build.requiredSigners ?? []
  const mine = signer.publicKey.toBase58()
  const missing = required.filter((s) => s !== mine)
  if (missing.length) {
    throw new ResolutionError(
      `Transaction needs signatures HyperPay cannot provide: ${missing.join(', ')} (signer is ${mine})`,
    )
  }

  const prepared = opts.prepare ? opts.prepare(deserialize(build)) : deserialize(build)
  const tx = await signer.signTransaction(prepared)
  const rpcUrl = rpcForBuild(build, cluster, opts.baseRpcUrl)
  const connection = new Connection(rpcUrl, 'confirmed')

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })

  await confirmSignature(connection, signature, build.lastValidBlockHeight)
  return { signature, rpcUrl, settledOn: build.sendTo }
}

/**
 * Polls signature status rather than using `confirmTransaction`.
 *
 * `confirmTransaction` opens a websocket subscription; the ephemeral rollup RPC
 * is not guaranteed to serve one, and a hung subscription looks identical to a
 * dropped payment. Polling works identically on both networks.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let heightChecks = 0

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature])
    const status = value[0]

    if (status?.err) {
      throw new ConfirmationError(
        `Transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`,
        signature,
      )
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return
    }

    // Blockhash expiry is authoritative, but checking it every loop triples our
    // RPC calls for no benefit — once a second is enough.
    if (++heightChecks % 3 === 0 && !status) {
      const height = await connection.getBlockHeight('confirmed').catch(() => 0)
      if (height > lastValidBlockHeight) {
        throw new ConfirmationError(
          `Transaction ${signature} expired unconfirmed (block height ${height} > ${lastValidBlockHeight}). It did not settle.`,
          signature,
        )
      }
    }
    await new Promise((r) => setTimeout(r, 400))
  }

  throw new ConfirmationError(
    `Timed out after ${timeoutMs}ms waiting for ${signature}. It may still settle — check before retrying.`,
    signature,
  )
}

/**
 * Turns a symbol (`"USDC"`) or a mint address into a `TokenInfo`.
 * Unknown mints have their decimals read from chain once, then cached.
 */
export class TokenResolver {
  private readonly cache = new Map<string, TokenInfo>()

  constructor(
    private readonly cluster: Cluster,
    private readonly baseRpcUrl: string,
    custom: TokenInfo[] = [],
  ) {
    this.register(custom)
  }

  /**
   * Teaches the resolver about tokens it could not otherwise name. Registering
   * a mint is what makes symbol-keyed spend caps work for it — without a
   * symbol, a policy has nothing to key on and fails closed.
   */
  register(tokens: TokenInfo[]): void {
    for (const token of tokens) {
      this.cache.set(token.mint, token)
      this.cache.set(token.symbol.toUpperCase(), token)
    }
  }

  async resolve(spec: string): Promise<TokenInfo> {
    // Custom registrations win over the built-in list, so callers can override.
    const cached = this.cache.get(spec) ?? this.cache.get(spec.toUpperCase())
    if (cached) return cached

    const known = lookupKnownToken(spec, this.cluster)
    if (known) return known

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(spec)) {
      throw new ResolutionError(
        `Unknown token "${spec}". Use a known symbol (USDC, USDT, SOL) or a mint address.`,
      )
    }

    const connection = new Connection(this.baseRpcUrl, 'confirmed')
    let decimals: number
    try {
      decimals = (await connection.getTokenSupply(new PublicKey(spec))).value.decimals
    } catch (cause) {
      throw new ResolutionError(`Could not read decimals for mint ${spec} — is it a real SPL mint?`, cause)
    }

    const info: TokenInfo = { mint: spec, symbol: spec.slice(0, 6), decimals }
    this.cache.set(spec, info)
    return info
  }
}
