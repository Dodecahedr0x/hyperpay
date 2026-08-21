import bs58 from 'bs58'
import { Transaction } from '@solana/web3.js'
import {
  formatAmount,
  fromBaseUnits,
  parseMoney,
  toBaseUnits,
  tokenFamily,
  HyperPayError,
  SignerError,
  type BuildResponse,
  type Cluster,
  type TokenInfo,
  type TransferRequest,
} from '@magicblock-labs/hyperpay-types'
import {
  TokenResolver,
  baseRpcFor,
  ensureRecipientAta,
  signAndSubmit,
  type AnyTransaction,
  type HyperPaySigner,
  type SubmitResult,
} from '@magicblock-labs/hyperpay-solana'
import { DEFAULT_API_URL, PaymentsApi, newRefId } from './api.js'
import { Policy, type PolicyConfig } from './policy.js'
import { envSigner, loadKey } from './runtime.js'

export { newRefId }

/**
 * A built transaction carries a blockhash that expires in ~60s. Both the RPC
 * and the API surface this differently, so match on the message.
 */
function isStaleBlockhash(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return /blockhash not found|block height exceeded|expired unconfirmed/i.test(message)
}

export interface HyperPayConfig {
  /** Bring your own signer (wallet adapter, KMS…). Takes precedence over `key`. */
  signer?: HyperPaySigner
  /** Base58 secret key, JSON byte array, or path to a keypair file. */
  key?: string
  cluster?: Cluster
  /** Override the base-layer RPC. Defaults per cluster. */
  rpcUrl?: string
  apiUrl?: string
  policy?: Policy | PolicyConfig
  /** Token used when an amount omits its symbol. Defaults to USDC. */
  defaultToken?: string
  /** Names custom mints so amounts and spend caps can refer to them by symbol. */
  tokens?: TokenInfo[]
  authToken?: string
}

export interface PayOptions {
  /** Symbol or mint address. Overrides the symbol in the amount string. */
  token?: string
  /** Defaults to `private`. */
  visibility?: 'public' | 'private'
  from?: 'base' | 'ephemeral'
  to?: 'base' | 'ephemeral'
  memo?: string
  /** Correlation id. Must be a non-negative integer string; generated if omitted. */
  refId?: string
  /** Fan across 1–15 queue entries to weaken amount correlation. */
  split?: number
  /** `[min, max]` settlement delay in ms, for private transfers. */
  delayMs?: [number, number]
  /** Sponsor pays SOL fees; you reimburse in token. Minimum 0.5 USDC/USDT. */
  gasless?: boolean
  /** Recipient receives exactly `amount` after fees. */
  exactOut?: boolean
}

export interface Payment {
  signature: string
  refId?: string
  to: string
  /** Human form, e.g. `"10 USDC"`. */
  amount: string
  units: string
  token: TokenInfo
  visibility: 'public' | 'private'
  settledOn: 'base' | 'ephemeral'
  rpcUrl: string
  fees?: { lamports: string; tokens: string }
  /** Absent for ephemeral settlement — private transfers are not publicly indexed. */
  explorerUrl?: string
}

export interface Quote {
  to: string
  amount: string
  units: string
  token: TokenInfo
  visibility: 'public' | 'private'
  settlesOn: 'base' | 'ephemeral'
  instructionCount: number
  fees?: { lamports: string; tokens: string }
  refId?: string
}

export interface Balances {
  address: string
  token: TokenInfo
  /** On the Solana base layer. */
  base: string
  /** Inside the ephemeral rollup. `undefined` when no signer can authenticate. */
  private?: string
  baseUnits: string
  privateUnits?: string
}

/**
 * The whole payment system, in one object.
 *
 * ```ts
 * const hp = HyperPay.fromEnv()
 * await hp.pay('alice@magicblock.id', '10 USDC')
 * ```
 */
export class HyperPay {
  readonly cluster: Cluster
  readonly api: PaymentsApi
  readonly policy: Policy
  readonly signer?: HyperPaySigner
  readonly rpcUrl: string
  private readonly tokens: TokenResolver
  private readonly defaultToken: string

  constructor(config: HyperPayConfig = {}) {
    this.cluster = config.cluster ?? 'mainnet'
    this.rpcUrl = baseRpcFor(this.cluster, config.rpcUrl)
    this.api = new PaymentsApi({ baseUrl: config.apiUrl, authToken: config.authToken })
    this.signer = config.signer ?? (config.key ? loadKey(config.key) : undefined)
    this.policy =
      config.policy instanceof Policy ? config.policy : new Policy(config.policy ?? {})
    this.defaultToken = config.defaultToken ?? 'USDC'
    this.tokens = new TokenResolver(this.cluster, this.rpcUrl, config.tokens)
  }

  /**
   * Builds a client from environment variables:
   * `HYPERPAY_KEY`, `HYPERPAY_CLUSTER`, `HYPERPAY_RPC`, `HYPERPAY_API`,
   * `HYPERPAY_TOKEN`, plus the policy vars read by `Policy.fromEnv`.
   */
  static fromEnv(overrides: HyperPayConfig = {}, env: NodeJS.ProcessEnv = process.env): HyperPay {
    return new HyperPay({
      signer: envSigner(env),
      cluster: (env.HYPERPAY_CLUSTER as Cluster) ?? 'mainnet',
      rpcUrl: env.HYPERPAY_RPC,
      apiUrl: env.HYPERPAY_API ?? DEFAULT_API_URL,
      defaultToken: env.HYPERPAY_TOKEN,
      tokens: parseTokensEnv(env.HYPERPAY_TOKENS),
      policy: Policy.fromEnv(env),
      ...overrides,
    })
  }

  /** Resolves `"10 USDC"` (or `"10"` + `opts.token`) into a concrete token and base units. */
  async resolveAmount(amount: string | number | bigint, tokenSpec?: string) {
    const { value, symbol } = parseMoney(amount)
    const token = await this.tokens.resolve(tokenSpec ?? symbol ?? this.defaultToken)
    const units = toBaseUnits(value, token.decimals)
    if (units <= 0n) throw new HyperPayError(`Payment amount must be greater than zero`)
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HyperPayError(
        `Amount ${formatAmount(units, token)} exceeds the maximum the payments API accepts`,
      )
    }
    return { token, units }
  }

  /**
   * Pay someone. Private by default.
   *
   * `to` is a pubkey or a stealth handle (`alice@magicblock.id`). The handle
   * must already have a stealth pool, or the API rejects the transfer.
   *
   * Private payments spend rollup balance. If that is short and `from` is not
   * `'base'`, the shortfall is deposited from the base layer first.
   */
  async pay(to: string, amount: string | number | bigint, opts: PayOptions = {}): Promise<Payment> {
    const { token, units, visibility, refId, request } = await this.quoteTransfer(to, amount, opts)
    if (visibility === 'private' && opts.from !== 'base') {
      await this.fundPrivate(token, units)
    }

    const { built: build, result } = await this.buildAndSubmit(
      () => this.api.transfer(request),
      // Only public transfers need this: private ones settle through the
      // rollup, which creates the destination account itself.
      visibility === 'public'
        ? (tx) =>
            tx instanceof Transaction
              ? ensureRecipientAta(tx, this.requireSigner().publicKey, to, token.mint)
              : tx
        : undefined,
    )
    const { signature, rpcUrl, settledOn } = result
    this.policy.record({ to, token, units })

    return {
      signature,
      refId,
      to,
      amount: formatAmount(units, token),
      units: units.toString(),
      token,
      visibility,
      settledOn,
      rpcUrl,
      fees: build.fees,
      explorerUrl: settledOn === 'base' ? this.explorerUrl(signature) : undefined,
    }
  }

  /** Same as `pay`, but returns the quote instead of sending. */
  async quote(to: string, amount: string | number | bigint, opts: PayOptions = {}): Promise<Quote> {
    const { token, units, visibility, refId, request } = await this.quoteTransfer(to, amount, opts)
    const build = await this.api.transfer(request)
    return {
      to,
      amount: formatAmount(units, token),
      units: units.toString(),
      token,
      visibility,
      settlesOn: build.sendTo,
      instructionCount: build.instructionCount,
      fees: build.fees,
      refId,
    }
  }

  /**
   * Private payments spend rollup tokens. If the rollup is short, move the
   * shortfall from the base layer and wait until it is spendable.
   */
  private async fundPrivate(token: TokenInfo, units: bigint): Promise<void> {
    // ponytail: 0.1% ceil matches the API private fee; deposit that extra so pay doesn't fail on fee.
    const need = units + (units + 999n) / 1000n
    const balances = await this.balance({ token: token.mint })
    const have = BigInt(balances.privateUnits ?? '0')
    if (have >= need) return

    const shortfall = need - have
    if (BigInt(balances.baseUnits) < shortfall) {
      throw new HyperPayError(
        `Need ${formatAmount(need, token)} on the rollup to pay privately, but only ${fromBaseUnits(have, token.decimals)} ${token.symbol} is there and ${balances.base} ${token.symbol} is on the base layer.`,
      )
    }

    await this.initializeMint(token.mint)
    await this.deposit(formatAmount(shortfall, token), { token: token.mint })

    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const next = await this.balance({ token: token.mint })
      if (BigInt(next.privateUnits ?? '0') >= need) return
      await new Promise((r) => setTimeout(r, 1_000))
    }
    throw new HyperPayError(
      `Deposited ${formatAmount(shortfall, token)} onto the rollup, but the private balance has not landed yet. Wait a few seconds and retry.`,
    )
  }

  /** Moves tokens from the base layer into the ephemeral rollup. */
  async deposit(amount: string | number | bigint, opts: { token?: string } = {}): Promise<Payment> {
    const owner = this.requireSigner().publicKey.toBase58()
    const { token, units } = await this.resolveAmount(amount, opts.token)
    const { built, result } = await this.buildAndSubmit(() =>
      this.api.deposit({
        owner,
        mint: token.mint,
        amount: Number(units),
        cluster: this.cluster,
        initIfMissing: true,
        initVaultIfMissing: true,
        initAtasIfMissing: true,
      }),
    )
    return this.receipt('deposit', owner, token, units, built, result)
  }

  /** Moves tokens from the ephemeral rollup back to the base layer. */
  async withdraw(amount: string | number | bigint, opts: { token?: string } = {}): Promise<Payment> {
    const owner = this.requireSigner().publicKey.toBase58()
    const { token, units } = await this.resolveAmount(amount, opts.token)
    const { built, result } = await this.buildAndSubmit(() =>
      this.api.withdraw({
        owner,
        mint: token.mint,
        amount: Number(units),
        cluster: this.cluster,
        initIfMissing: true,
        initAtasIfMissing: true,
      }),
    )
    return this.receipt('withdraw', owner, token, units, built, result)
  }

  /**
   * Gives a mint a transfer queue on the ephemeral validator. Required once per
   * mint before anyone can send it privately; a no-op if already done.
   */
  async initializeMint(tokenSpec?: string): Promise<{ mint: string; signature?: string; alreadyInitialized: boolean }> {
    const token = await this.tokens.resolve(tokenSpec ?? this.defaultToken)
    const status = await this.api.isMintInitialized(token.mint, this.cluster)
    if (status.initialized) return { mint: token.mint, alreadyInitialized: true }

    const payer = this.requireSigner().publicKey.toBase58()
    const { result } = await this.buildAndSubmit(() =>
      this.api.initializeMint({ mint: token.mint, cluster: this.cluster, payer }),
    )
    return { mint: token.mint, signature: result.signature, alreadyInitialized: false }
  }

  /** Base-layer and (when authenticated) ephemeral balances. */
  async balance(opts: { token?: string; address?: string } = {}): Promise<Balances> {
    const address = opts.address ?? this.requireSigner().publicKey.toBase58()
    const token = await this.tokens.resolve(opts.token ?? this.defaultToken)

    const base = await this.api.balance(address, token.mint, this.cluster)
    let priv: string | undefined
    try {
      await this.login()
      priv = (await this.api.privateBalance(address, token.mint, this.cluster)).balance
    } catch {
      // Private balance needs a signer and a live session; absence is not an error.
    }

    return {
      address,
      token,
      base: fromBaseUnits(BigInt(base.balance), token.decimals),
      baseUnits: base.balance,
      private: priv === undefined ? undefined : fromBaseUnits(BigInt(priv), token.decimals),
      privateUnits: priv,
    }
  }

  /** Authenticates for private reads. Idempotent; caches the bearer token. */
  async login(): Promise<string> {
    if (this.api.authToken) return this.api.authToken
    const signer = this.requireSigner()
    if (!signer.signMessage) {
      throw new SignerError('This signer cannot sign messages, so private balances are unavailable')
    }
    const pubkey = signer.publicKey.toBase58()
    const { challenge } = await this.api.challenge(pubkey)
    const signature = bs58.encode(await signer.signMessage(new TextEncoder().encode(challenge)))
    const { token } = await this.api.login(pubkey, challenge, signature)
    this.api.authToken = token
    return token
  }

  explorerUrl(signature: string): string {
    const suffix = tokenFamily(this.cluster) === 'devnet' ? '?cluster=devnet' : ''
    return `https://explorer.solana.com/tx/${signature}${suffix}`
  }

  /** Resolve, policy-check, and build the transfer request — shared by `pay` and `quote`. */
  private async quoteTransfer(to: string, amount: string | number | bigint, opts: PayOptions) {
    const { token, units } = await this.resolveAmount(amount, opts.token)
    const visibility = opts.visibility ?? 'private'

    // Policy runs before anything is built or signed: a rejected payment must
    // leave no transaction in existence.
    this.policy.check({ to, token, units })

    const refId = opts.refId ?? (visibility === 'private' ? newRefId() : undefined)
    const request = this.transferRequest(to, token, units, visibility, refId, opts)
    return { token, units, visibility, refId, request }
  }

  private transferRequest(
    to: string,
    token: TokenInfo,
    units: bigint,
    visibility: 'public' | 'private',
    refId: string | undefined,
    opts: PayOptions,
  ): TransferRequest {
    return {
      from: this.requireSigner().publicKey.toBase58(),
      to,
      mint: token.mint,
      amount: Number(units),
      cluster: this.cluster,
      visibility,
      fromBalance: opts.from,
      toBalance: opts.to,
      memo: opts.memo,
      clientRefId: refId,
      split: opts.split,
      minDelayMs: opts.delayMs ? String(opts.delayMs[0]) : undefined,
      maxDelayMs: opts.delayMs ? String(opts.delayMs[1]) : undefined,
      gasless: opts.gasless,
      exactOut: opts.exactOut,
      // Creating missing token accounts is what makes a first payment to a new
      // recipient work at all. `initVaultIfMissing` is deliberately absent:
      // it adds three more instructions and pushes the transaction past the
      // 1232-byte limit. Vault setup belongs to initializeMint()/deposit().
      initIfMissing: true,
      initAtasIfMissing: true,
    }
  }

  private submit(build: BuildResponse, prepare?: (tx: AnyTransaction) => AnyTransaction) {
    return signAndSubmit(build, this.requireSigner(), this.cluster, {
      baseRpcUrl: this.rpcUrl,
      prepare,
    })
  }

  /**
   * Builds and submits, rebuilding once if the blockhash went stale.
   *
   * The API stamps a blockhash at build time; on a slow network or a busy
   * cluster it can expire before we submit. Retrying the *submit* would be
   * useless — the fix is a fresh build.
   */
  private async buildAndSubmit(
    build: () => Promise<BuildResponse>,
    prepare?: (tx: AnyTransaction) => AnyTransaction,
  ) {
    let last: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      const built = await build()
      try {
        return { built, result: await this.submit(built, prepare) }
      } catch (e) {
        if (!isStaleBlockhash(e)) throw e
        last = e
      }
    }
    throw new HyperPayError(
      `Could not land the transaction: its blockhash expired three times in a row. The network is likely congested.`,
      last,
    )
  }

  private receipt(
    kind: string,
    to: string,
    token: TokenInfo,
    units: bigint,
    build: BuildResponse,
    { signature, rpcUrl, settledOn }: SubmitResult,
  ): Payment {
    return {
      signature,
      to,
      amount: formatAmount(units, token),
      units: units.toString(),
      token,
      visibility: kind === 'deposit' ? 'private' : 'public',
      settledOn,
      rpcUrl,
      fees: build.fees,
      explorerUrl: settledOn === 'base' ? this.explorerUrl(signature) : undefined,
    }
  }

  private requireSigner(): HyperPaySigner {
    if (!this.signer) {
      throw new SignerError(
        'No signer configured. Set HYPERPAY_KEY, or pass { key } or { signer } to HyperPay.',
      )
    }
    return this.signer
  }
}

/**
 * Parses `HYPERPAY_TOKENS="TEST:<mint>:6,FOO:<mint>:9"`.
 *
 * Lives here rather than in the CLI so that every entry point — SDK, CLI, MCP —
 * honours the same variable. Duplicating it meant `HyperPay.fromEnv()` silently
 * ignored custom mints.
 */
export function parseTokensEnv(spec?: string): TokenInfo[] {
  if (!spec) return []
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [symbol, mint, decimals] = entry.split(':')
      if (!symbol || !mint || !decimals || Number.isNaN(Number(decimals))) {
        throw new HyperPayError(
          `Bad HYPERPAY_TOKENS entry "${entry}" — expected SYMBOL:MINT:DECIMALS`,
        )
      }
      return { symbol: symbol.toUpperCase(), mint, decimals: Number(decimals) }
    })
}
