import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import {
  formatAmount,
  fromBaseUnits,
  parseMoney,
  toBaseUnits,
  tokenFamily,
  HyperPayError,
  SignerError,
  type Cluster,
  type TokenInfo,
} from '@magicblock-labs/hyperpay-types'
import {
  TokenResolver,
  associatedTokenAddress,
  baseRpcFor,
  ephemeralRpcFor,
  getAccountData,
  signAndSubmit,
  type HyperPaySigner,
  type SubmitResult,
} from '@magicblock-labs/hyperpay-solana'
import { Policy, type PolicyConfig } from './policy.js'
import { envSigner, loadKey } from './runtime.js'
import {
  chargeIx,
  closeSessionIx,
  delegateEphemeralAtaIx,
  delegateUserIx,
  delegationRecordPda,
  depositIx,
  depositSplIx,
  ensureUserMintIx,
  initEphemeralAtaIx,
  initGlobalVaultIx,
  initUserIx,
  openSessionIx,
  remainingFromSessionData,
  sessionPda,
  userMintPda,
  userPda,
  withdrawIx,
  LOCAL_ER_VALIDATOR,
  eataPda,
  type SessionAccounts,
} from './program.js'

export {
  PROGRAM_ID,
  SESSION_REMAINING_OFFSET,
  chargeIx,
  closeSessionIx,
  delegateBufferPda,
  delegateEphemeralAtaIx,
  delegateUserIx,
  delegationMetadataPda,
  delegationRecordPda,
  depositIx,
  depositSplIx,
  eataPda,
  ensureUserMintIx,
  initEphemeralAtaIx,
  initGlobalVaultIx,
  initUserIx,
  openSessionIx,
  remainingFromSessionData,
  sessionPda,
  userMintPda,
  userPda,
  vaultPda,
  withdrawIx,
  DELEGATION_PROGRAM_ID,
  LOCAL_ER_VALIDATOR,
} from './program.js'
export type { SessionAccounts, WithdrawAccounts } from './program.js'

export interface HyperPayConfig {
  /** Bring your own signer (wallet adapter, KMS…). Takes precedence over `key`. */
  signer?: HyperPaySigner
  /** Base58 secret key, JSON byte array, or path to a keypair file. */
  key?: string
  cluster?: Cluster
  /** Override the base-layer RPC. Defaults per cluster. */
  rpcUrl?: string
  /** Override the ephemeral-rollup RPC. Defaults per cluster. */
  ephemeralRpcUrl?: string
  policy?: Policy | PolicyConfig
  /** Token used when an amount omits its symbol. Defaults to USDC. */
  defaultToken?: string
  /** Names custom mints so amounts and spend caps can refer to them by symbol. */
  tokens?: TokenInfo[]
}

export interface SessionOptions {
  /** Symbol or mint address. Overrides the symbol in the amount string. */
  token?: string
  /** MagicBlock session token account. Never pass a user's token to a merchant `charge`. */
  sessionToken?: string
  /**
   * Wallet that owns the User PDA (`["user", wallet]`).
   * Required when the signer is a session key — do not derive the User PDA from the session key.
   */
  authority?: string | PublicKey
}

export interface Payment {
  signature: string
  to: string
  /** Human form, e.g. `"10 USDC"`. */
  amount: string
  units: string
  token: TokenInfo
  settledOn: 'base' | 'ephemeral'
  rpcUrl: string
  explorerUrl?: string
}

export interface Quote {
  to: string
  amount: string
  units: string
  token: TokenInfo
  settlesOn: 'base' | 'ephemeral'
}

export interface Balances {
  address: string
  token: TokenInfo
  /** Session remaining (for `sessionBalance`) or ATA balance (for `balance`). */
  base: string
  baseUnits: string
}

/**
 * Client for the HyperPay payment-session program.
 *
 * ```ts
 * const user = HyperPay.fromEnv()
 * await user.initUser(1_000_000n)
 * await user.topUp('10 USDC')
 * await user.openSession(merchant, '10 USDC')
 *
 * const merchantHp = new HyperPay({ key: merchantKey, cluster: 'devnet' })
 * await merchantHp.charge(userWallet, '1 USDC')
 * ```
 */
export class HyperPay {
  readonly cluster: Cluster
  readonly policy: Policy
  readonly signer?: HyperPaySigner
  readonly rpcUrl: string
  readonly ephemeralRpcUrl: string
  private readonly tokens: TokenResolver
  private readonly defaultToken: string

  constructor(config: HyperPayConfig = {}) {
    this.cluster = config.cluster ?? 'mainnet'
    this.rpcUrl = baseRpcFor(this.cluster, config.rpcUrl)
    this.ephemeralRpcUrl = ephemeralRpcFor(this.cluster, config.ephemeralRpcUrl)
    this.signer = config.signer ?? (config.key ? loadKey(config.key) : undefined)
    this.policy =
      config.policy instanceof Policy ? config.policy : new Policy(config.policy ?? {})
    this.defaultToken = config.defaultToken ?? 'USDC'
    this.tokens = new TokenResolver(this.cluster, this.rpcUrl, config.tokens)
  }

  /**
   * Builds a client from environment variables:
   * `HYPERPAY_KEY`, `HYPERPAY_CLUSTER`, `HYPERPAY_RPC`, `HYPERPAY_EPHEMERAL_RPC`,
   * `HYPERPAY_TOKEN`, plus the policy vars read by `Policy.fromEnv`.
   */
  static fromEnv(overrides: HyperPayConfig = {}, env: NodeJS.ProcessEnv = process.env): HyperPay {
    return new HyperPay({
      signer: envSigner(env),
      cluster: (env.HYPERPAY_CLUSTER as Cluster) ?? 'mainnet',
      rpcUrl: env.HYPERPAY_RPC,
      ephemeralRpcUrl: env.HYPERPAY_EPHEMERAL_RPC,
      defaultToken: env.HYPERPAY_TOKEN,
      tokens: parseTokensEnv(env.HYPERPAY_TOKENS),
      policy: Policy.fromEnv(env),
      ...overrides,
    })
  }

  /**
   * Resolves `"10 USDC"` (or `"10"` + `tokenSpec`) into a concrete token and base units.
   * `openSession` may pass `{ allowZero: true }` so a session can be created empty.
   */
  async resolveAmount(
    amount: string | number | bigint,
    tokenSpec?: string,
    opts: { allowZero?: boolean } = {},
  ) {
    const { value, symbol } = parseMoney(amount)
    const token = await this.tokens.resolve(tokenSpec ?? symbol ?? this.defaultToken)
    const units = toBaseUnits(value, token.decimals)
    if (units < 0n || (units === 0n && !opts.allowZero)) {
      throw new HyperPayError(`Payment amount must be greater than zero`)
    }
    if (units > 0xffff_ffff_ffff_ffffn) {
      throw new HyperPayError(`Amount ${formatAmount(units, token)} exceeds u64`)
    }
    return { token, units }
  }

  /** User PDA accounts for a wallet authority — never derived from a session-key signer. */
  sessionAccounts(args: { authority: PublicKey; merchant: PublicKey; mint: PublicKey }): SessionAccounts {
    const [user] = userPda(args.authority)
    const [userMint] = userMintPda(user, args.mint)
    const [session] = sessionPda(user, args.merchant, args.mint)
    const userEata = associatedTokenAddress(args.mint, user)
    return {
      user,
      signer: this.requireSigner().publicKey,
      userMint,
      session,
      merchant: args.merchant,
      mint: args.mint,
      userEata,
    }
  }

  /** Creates the User PDA on the base cluster and funds it with lamports. */
  async initUser(lamports: bigint | number): Promise<Payment> {
    const units = BigInt(lamports)
    if (units <= 0n) throw new HyperPayError('Payment amount must be greater than zero')
    const authority = this.requireSigner().publicKey
    const [user] = userPda(authority)
    return this.submit(
      initUserIx(user, authority, units),
      this.rpcUrl,
      'base',
      authority.toBase58(),
      units,
      lamportToken(),
    )
  }

  /** Delegates the User PDA to the ephemeral rollup (MagicBlock CPI on base). */
  async delegateUser(opts: { validator?: string } = {}): Promise<Payment> {
    const authority = this.requireSigner().publicKey
    const [user] = userPda(authority)
    const validator = opts.validator ? new PublicKey(opts.validator) : LOCAL_ER_VALIDATOR
    return this.submit(
      delegateUserIx(user, authority, validator),
      this.rpcUrl,
      'base',
      user.toBase58(),
      0n,
      lamportToken(),
    )
  }

  /**
   * Deposits tokens from the signer's Tokenkeg ATA into the User eATA (base),
   * then creates the ephemeral UserMint if it is missing. `reserved` stays 0
   * until `openSession` / `deposit`. Requires `initUser` + `delegateUser`.
   */
  async topUp(amount: string | number | bigint, opts: SessionOptions = {}): Promise<Payment> {
    const { token, units } = await this.resolveAmount(amount, opts.token)
    const authority = this.walletAuthority(opts)
    this.policy.check({ to: authority.toBase58(), token, units })
    const signer = this.requireSigner().publicKey
    const mint = new PublicKey(token.mint)
    const [user] = userPda(authority)
    const [userMint] = userMintPda(user, mint)
    const [eata] = eataPda(user, mint)
    const skipPreflight = { skipPreflight: true as const }
    await this.submit(
      [initGlobalVaultIx(signer, mint), initEphemeralAtaIx(signer, user, mint)],
      this.rpcUrl,
      'base',
      authority.toBase58(),
      0n,
      token,
      skipPreflight,
    )
    const payment = await this.submit(
      depositSplIx(signer, user, mint, units),
      this.rpcUrl,
      'base',
      authority.toBase58(),
      units,
      token,
      skipPreflight,
    )
    if (!(await getAccountData(this.rpcUrl, delegationRecordPda(eata)))) {
      await this.submit(
        delegateEphemeralAtaIx(signer, user, mint),
        this.rpcUrl,
        'base',
        authority.toBase58(),
        0n,
        token,
        skipPreflight,
      )
    }
    await this.submit(
      ensureUserMintIx(user, signer, userMint, mint, optionalPubkey(opts.sessionToken)),
      this.ephemeralRpcUrl,
      'ephemeral',
      authority.toBase58(),
      0n,
      token,
    )
    return payment
  }

  /** Opens a session with `merchant`. Amount may be 0. */
  async openSession(
    merchant: string,
    amount: string | number | bigint = 0,
    opts: SessionOptions = {},
  ): Promise<Payment> {
    const { token, units } = await this.resolveAmount(amount, opts.token, { allowZero: true })
    if (units > 0n) this.policy.check({ to: merchant, token, units })
    const accounts = this.sessionAccounts({
      authority: this.walletAuthority(opts),
      merchant: new PublicKey(merchant),
      mint: new PublicKey(token.mint),
    })
    return this.submit(
      openSessionIx(accounts, units, optionalPubkey(opts.sessionToken)),
      this.ephemeralRpcUrl,
      'ephemeral',
      merchant,
      units,
      token,
    )
  }

  /** Reserves more of the user eATA into an existing session. */
  async deposit(
    merchant: string,
    amount: string | number | bigint,
    opts: SessionOptions = {},
  ): Promise<Payment> {
    const { token, units } = await this.resolveAmount(amount, opts.token)
    this.policy.check({ to: merchant, token, units })
    const accounts = this.sessionAccounts({
      authority: this.walletAuthority(opts),
      merchant: new PublicKey(merchant),
      mint: new PublicKey(token.mint),
    })
    return this.submit(
      depositIx(accounts, units, optionalPubkey(opts.sessionToken)),
      this.ephemeralRpcUrl,
      'ephemeral',
      merchant,
      units,
      token,
    )
  }

  /**
   * Debit the user's ER session. Signs with the merchant key.
   *
   * The merchant must omit the session token — do not give a user's session
   * key to a merchant. The user must `openSession` first.
   */
  async charge(user: string, amount: string | number | bigint, opts: { token?: string } = {}): Promise<Payment> {
    const { token, units } = await this.resolveAmount(amount, opts.token)
    const merchant = this.requireSigner().publicKey
    this.policy.check({ to: merchant.toBase58(), token, units })
    const mint = new PublicKey(token.mint)
    const accounts = this.sessionAccounts({
      authority: new PublicKey(user),
      merchant,
      mint,
    })
    const merchantEata = associatedTokenAddress(mint, merchant)
    return this.submit(
      chargeIx(accounts, merchantEata, units),
      this.ephemeralRpcUrl,
      'ephemeral',
      merchant.toBase58(),
      units,
      token,
    )
  }

  /** Unreserves remaining and closes the session. User-only. */
  async closeSession(merchant: string, opts: SessionOptions = {}): Promise<Payment> {
    const token = await this.tokens.resolve(opts.token ?? this.defaultToken)
    const accounts = this.sessionAccounts({
      authority: this.walletAuthority(opts),
      merchant: new PublicKey(merchant),
      mint: new PublicKey(token.mint),
    })
    return this.submit(
      closeSessionIx(accounts, optionalPubkey(opts.sessionToken)),
      this.ephemeralRpcUrl,
      'ephemeral',
      merchant,
      0n,
      token,
    )
  }

  /** Moves unreserved eATA tokens to `destination`'s eATA (defaults to the signer). */
  async withdraw(
    amount: string | number | bigint,
    opts: SessionOptions & { destination?: string } = {},
  ): Promise<Payment> {
    const { token, units } = await this.resolveAmount(amount, opts.token)
    const signer = this.requireSigner().publicKey
    const destOwner = opts.destination ? new PublicKey(opts.destination) : signer
    this.policy.check({ to: destOwner.toBase58(), token, units })
    const mint = new PublicKey(token.mint)
    const [user] = userPda(this.walletAuthority(opts))
    const [userMint] = userMintPda(user, mint)
    const userEata = associatedTokenAddress(mint, user)
    const destination = associatedTokenAddress(mint, destOwner)
    return this.submit(
      withdrawIx(
        { user, signer, userMint, mint, userEata, destination },
        units,
        optionalPubkey(opts.sessionToken),
      ),
      this.ephemeralRpcUrl,
      'ephemeral',
      destOwner.toBase58(),
      units,
      token,
    )
  }

  /** Remaining units on the ER session between `user` (wallet) and this merchant. */
  async sessionBalance(user: string): Promise<Balances> {
    const token = await this.tokens.resolve(this.defaultToken)
    const merchant = this.requireSigner().publicKey
    const userWallet = new PublicKey(user)
    const mint = new PublicKey(token.mint)
    const [userAccount] = userPda(userWallet)
    const [session] = sessionPda(userAccount, merchant, mint)
    const data = await getAccountData(this.ephemeralRpcUrl, session)
    const units = (data && remainingFromSessionData(data)) ?? 0n
    return {
      address: user,
      token,
      base: fromBaseUnits(units, token.decimals),
      baseUnits: units.toString(),
    }
  }

  /** Policy-check and resolve an amount without submitting. */
  async quote(
    merchant: string,
    amount: string | number | bigint,
    opts: { token?: string } = {},
  ): Promise<Quote> {
    const { token, units } = await this.resolveAmount(amount, opts.token)
    this.policy.check({ to: merchant, token, units })
    return {
      to: merchant,
      amount: formatAmount(units, token),
      units: units.toString(),
      token,
      settlesOn: 'ephemeral',
    }
  }

  /** Base-layer ATA balance for a wallet. */
  async balance(opts: { token?: string; address?: string } = {}): Promise<Balances> {
    const address = opts.address ?? this.requireSigner().publicKey.toBase58()
    const token = await this.tokens.resolve(opts.token ?? this.defaultToken)
    const ata = associatedTokenAddress(new PublicKey(token.mint), new PublicKey(address))
    const connection = new Connection(this.rpcUrl, 'confirmed')
    try {
      const bal = await connection.getTokenAccountBalance(ata)
      return {
        address,
        token,
        base: fromBaseUnits(BigInt(bal.value.amount), token.decimals),
        baseUnits: bal.value.amount,
      }
    } catch {
      return { address, token, base: '0', baseUnits: '0' }
    }
  }

  explorerUrl(signature: string): string {
    const suffix = tokenFamily(this.cluster) === 'devnet' ? '?cluster=devnet' : ''
    return `https://explorer.solana.com/tx/${signature}${suffix}`
  }

  private walletAuthority(opts: { authority?: string | PublicKey } = {}): PublicKey {
    if (opts.authority instanceof PublicKey) return opts.authority
    if (typeof opts.authority === 'string') return new PublicKey(opts.authority)
    return this.requireSigner().publicKey
  }

  private async submit(
    ix: TransactionInstruction | TransactionInstruction[],
    rpcUrl: string,
    settledOn: 'base' | 'ephemeral',
    to: string,
    units: bigint,
    token: TokenInfo,
    opts?: { skipPreflight?: boolean },
  ): Promise<Payment> {
    const result = await signAndSubmit(ix, this.requireSigner(), rpcUrl, settledOn, opts)
    if (units > 0n) this.policy.record({ to, token, units })
    return this.receipt(to, token, units, result)
  }

  private receipt(to: string, token: TokenInfo, units: bigint, result: SubmitResult): Payment {
    return {
      signature: result.signature,
      to,
      amount: token.symbol === 'SOL' && token.mint.startsWith('So111') ? `${units} lamports` : formatAmount(units, token),
      units: units.toString(),
      token,
      settledOn: result.settledOn,
      rpcUrl: result.rpcUrl,
      explorerUrl: result.settledOn === 'base' ? this.explorerUrl(result.signature) : undefined,
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

function lamportToken(): TokenInfo {
  return { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 }
}

function optionalPubkey(value?: string): PublicKey | undefined {
  return value ? new PublicKey(value) : undefined
}

/**
 * Parses `HYPERPAY_TOKENS="TEST:<mint>:6,FOO:<mint>:9"`.
 *
 * Lives here rather than in the CLI so that every entry point — SDK, CLI, MCP —
 * honours the same variable.
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
