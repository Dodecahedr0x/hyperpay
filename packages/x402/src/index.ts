import { HyperPay } from '@magicblock-labs/hyperpay-core/client'
import { formatAmount, HyperPayError, type Cluster, type TokenInfo } from '@magicblock-labs/hyperpay-types'

export const PAYMENT_HEADER = 'x-payment'

/** What a server tells a client it must pay. Serialised into the 402 body. */
export interface PaymentRequirement {
  scheme: 'hyperpay'
  network: Cluster
  to: string
  mint: string
  /** Base units, as a string. */
  amount: string
  /** Human form, e.g. `"0.01 USDC"`. */
  display: string
  token: TokenInfo
  refId: string
  description?: string
  expiresAt: string
}

/** What a client puts in the `X-Payment` header (base64 JSON). */
export interface PaymentProof {
  refId: string
  /** User wallet that already opened a session with the merchant. */
  user: string
  network: Cluster
}

export interface VerifyResult {
  ok: boolean
  reason?: string
  strength?: 'settled' | 'accepted'
  proof?: PaymentProof
}

export interface PaywallOptions {
  hp: HyperPay
  /** Price per request, e.g. `"0.01 USDC"`. */
  price: string
  /** Who gets paid. Defaults to the configured wallet. */
  to?: string
  description?: string
  /** How long a quote stays valid. Default 5 minutes. */
  ttlMs?: number
  /** Replace the in-memory challenge store to survive restarts or scale out. */
  store?: ChallengeStore
}

export interface ChallengeStore {
  put(refId: string, requirement: PaymentRequirement): Promise<void> | void
  take(refId: string): Promise<PaymentRequirement | undefined> | PaymentRequirement | undefined
}

/**
 * Single-use, in-memory challenge store.
 *
 * `take` removes the entry, so a proof cannot be replayed against a second
 * request. Swap in Redis for multi-process deployments — an in-memory store
 * would let a replay succeed against a different instance.
 */
export class MemoryChallengeStore implements ChallengeStore {
  private readonly entries = new Map<string, PaymentRequirement>()

  put(refId: string, requirement: PaymentRequirement): void {
    this.entries.set(refId, requirement)
    this.sweep()
  }

  take(refId: string): PaymentRequirement | undefined {
    const found = this.entries.get(refId)
    this.entries.delete(refId)
    if (!found) return undefined
    return Date.parse(found.expiresAt) < Date.now() ? undefined : found
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, req] of this.entries) {
      if (Date.parse(req.expiresAt) < now) this.entries.delete(id)
    }
  }
}

/**
 * The merchant half of HTTP 402: issues payment challenges and verifies proofs
 * by charging a session the user already opened with `openSession`.
 */
export class Paywall {
  private readonly store: ChallengeStore

  constructor(private readonly options: PaywallOptions) {
    this.store = options.store ?? new MemoryChallengeStore()
  }

  /** Builds the requirement a client must satisfy. */
  async challenge(): Promise<PaymentRequirement> {
    const { hp, price, to, description, ttlMs = 5 * 60_000 } = this.options
    const { token, units } = await hp.resolveAmount(price)
    const recipient = to ?? hp.signer?.publicKey.toBase58()
    if (!recipient) {
      throw new HyperPayError('Paywall needs a recipient: pass `to`, or configure a signer.')
    }

    const requirement: PaymentRequirement = {
      scheme: 'hyperpay',
      network: hp.cluster,
      to: recipient,
      mint: token.mint,
      amount: units.toString(),
      display: formatAmount(units, token),
      token,
      refId: newRefId(),
      description,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    }
    await this.store.put(requirement.refId, requirement)
    return requirement
  }

  /**
   * Verifies an `X-Payment` header, then merchant-`charge`s the user's session.
   * The user must have `openSession` first.
   */
  async verify(header: string | null | undefined): Promise<VerifyResult> {
    if (!header) return { ok: false, reason: 'Missing X-Payment header' }

    let proof: PaymentProof
    try {
      proof = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentProof
    } catch {
      return { ok: false, reason: 'X-Payment header is not base64-encoded JSON' }
    }
    if (!proof.refId || !proof.user) {
      return { ok: false, reason: 'Payment proof must carry refId and user' }
    }

    const requirement = await this.store.take(proof.refId)
    if (!requirement) {
      return { ok: false, reason: 'Unknown, expired, or already-used payment reference' }
    }

    try {
      await this.options.hp.charge(proof.user, requirement.display, { token: requirement.token.mint })
      return { ok: true, strength: 'settled', proof }
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        proof,
      }
    }
  }
}

/** Body of the 402 response. */
export function challengeBody(requirement: PaymentRequirement) {
  return {
    error: 'payment_required',
    message: `This resource costs ${requirement.display}. Open a session with the merchant first, then retry.`,
    accepts: [requirement],
  }
}

/**
 * Express-style middleware. Requests without a valid payment get a 402
 * describing exactly what to pay; requests with one continue to the handler.
 */
export function expressPaywall(options: PaywallOptions) {
  const paywall = new Paywall(options)

  return async function paywallMiddleware(req: any, res: any, next: any): Promise<void> {
    try {
      const header = req.headers?.[PAYMENT_HEADER] ?? req.get?.(PAYMENT_HEADER)
      const result = await paywall.verify(header)
      if (result.ok) {
        req.payment = result
        return next()
      }
      const requirement = await paywall.challenge()
      res.status(402).json({ ...challengeBody(requirement), reason: result.reason })
    } catch (error) {
      next(error)
    }
  }
}

export interface PayingFetchOptions {
  hp: HyperPay
  /** Refuse to pay more than this per request. Belt and braces over Policy. */
  maxPrice?: string
  /** Called before identifying the user to the merchant. Return false to abort. */
  approve?: (requirement: PaymentRequirement) => boolean | Promise<boolean>
}

/**
 * The agent half of HTTP 402: a `fetch` that identifies the user so the
 * merchant can `charge` a session the user already opened.
 *
 * Call `hp.openSession(merchant, amount)` before using this. There is no
 * transfer-API fallback.
 *
 * ```ts
 * await hp.openSession(merchant, '1 USDC')
 * const pay = payingFetch({ hp, maxPrice: '0.05 USDC' })
 * const res = await pay('https://api.example.com/data')
 * ```
 */
export function payingFetch(options: PayingFetchOptions): typeof globalThis.fetch {
  const { hp, maxPrice, approve } = options

  return async function fetchWithPayment(input: any, init?: RequestInit): Promise<Response> {
    const first = await fetch(input, init)
    if (first.status !== 402) return first

    const body = (await first.clone().json().catch(() => null)) as
      | { accepts?: PaymentRequirement[] }
      | null
    const requirement = body?.accepts?.find((a) => a.scheme === 'hyperpay')
    if (!requirement) return first

    if (maxPrice) {
      const { units: limit } = await hp.resolveAmount(maxPrice, requirement.token.mint)
      if (BigInt(requirement.amount) > limit) {
        throw new HyperPayError(
          `Server asked for ${requirement.display}, which is above the ${maxPrice} limit for this request`,
        )
      }
    }

    if (approve && !(await approve(requirement))) {
      throw new HyperPayError(`Payment of ${requirement.display} was declined`)
    }

    const user = hp.signer?.publicKey.toBase58()
    if (!user) {
      throw new HyperPayError('payingFetch needs a signer so the merchant can charge your session.')
    }

    const proof: PaymentProof = {
      refId: requirement.refId,
      user,
      network: requirement.network,
    }

    const headers = new Headers(init?.headers)
    headers.set(PAYMENT_HEADER, Buffer.from(JSON.stringify(proof)).toString('base64'))
    return fetch(input, { ...init, headers })
  } as typeof globalThis.fetch
}

function newRefId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v.toString()
}
