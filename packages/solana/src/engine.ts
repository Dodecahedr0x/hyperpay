import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  ConfirmationError,
  HyperPayError,
  ResolutionError,
  lookupKnownToken,
  tokenFamily,
  type Cluster,
  type TokenInfo,
} from '@magicblock-labs/hyperpay-types'
import { type HyperPaySigner } from './signer.js'

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
  if (String(cluster).startsWith('http')) return String(cluster)
  return DEFAULT_RPC[tokenFamily(cluster)]
}

export function ephemeralRpcFor(cluster: Cluster, override?: string): string {
  if (override) return override
  return DEFAULT_EPHEMERAL_RPC[tokenFamily(cluster)]
}

export interface SubmitResult {
  signature: string
  rpcUrl: string
  settledOn: 'base' | 'ephemeral'
}

/** Reads account data via JSON-RPC `getAccountInfo` (base64). */
export async function getAccountData(
  rpcUrl: string,
  address: PublicKey | string,
): Promise<Buffer | null> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [typeof address === 'string' ? address : address.toBase58(), { encoding: 'base64' }],
    }),
  })
  const json = (await res.json()) as {
    error?: { message?: string }
    result?: { value?: { data?: [string, string] } | null }
  }
  if (json.error) {
    throw new HyperPayError(`getAccountInfo: ${json.error.message ?? 'unknown RPC error'}`)
  }
  const value = json.result?.value
  if (!value) return null
  const encoded = value.data?.[0]
  if (encoded === undefined) {
    throw new HyperPayError('getAccountInfo did not return base64 account data')
  }
  return Buffer.from(encoded, 'base64')
}

/**
 * Builds a transaction around one instruction, signs it, submits it, and waits
 * for confirmation.
 */
export async function signAndSubmit(
  ix: TransactionInstruction,
  signer: HyperPaySigner,
  rpcUrl: string,
  settledOn: 'base' | 'ephemeral',
): Promise<SubmitResult> {
  const connection = new Connection(rpcUrl, 'confirmed')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({
    feePayer: signer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(ix)
  const signed = await signer.signTransaction(tx)
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })
  await confirmSignature(connection, signature, lastValidBlockHeight)
  return { signature, rpcUrl, settledOn }
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
