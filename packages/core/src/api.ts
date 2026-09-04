import { ApiError, type ApiOptions, type BalanceResponse, type BuildResponse, type ChargeRequest, type Cluster, type DepositRequest, type MintStatusResponse, type SessionBalanceResponse, type TransferRequest, type WithdrawRequest } from '@magicblock-labs/hyperpay-types'

export const DEFAULT_API_URL = 'https://payments.magicblock.app'

export type {
  ApiOptions,
  BalanceResponse,
  BuildResponse,
  ChargeRequest,
  DepositRequest,
  MintStatusResponse,
  SessionBalanceResponse,
  TransferRequest,
  WithdrawRequest,
}

/**
 * Thin typed client over the MagicBlock payments API.
 *
 * Deliberately dumb: it does not sign, route or retry. It maps endpoints to
 * methods and turns error envelopes into `ApiError`. All the judgement lives in
 * `engine.ts`.
 */
export class PaymentsApi {
  readonly baseUrl: string
  authToken?: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(opts: ApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/$/, '')
    this.authToken = opts.authToken
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  transfer = (req: TransferRequest) => this.post<BuildResponse>('/v1/spl/transfer', req)
  deposit = (req: DepositRequest) => this.post<BuildResponse>('/v1/spl/deposit', req)
  withdraw = (req: WithdrawRequest) => this.post<BuildResponse>('/v1/spl/withdraw', req)
  initializeMint = (req: { mint: string; cluster?: Cluster; payer?: string }) =>
    this.post<BuildResponse>('/v1/spl/initialize-mint', req)

  balance = (address: string, mint: string, cluster?: Cluster) =>
    this.get<BalanceResponse>('/v1/spl/balance', { address, mint, cluster })

  /** Remaining units on the ER session. */
  sessionBalance = (user: string, merchant: string, mint: string, cluster?: Cluster) =>
    this.get<SessionBalanceResponse>('/v1/spl/session-balance', { user, merchant, mint, cluster })

  /** Builds a merchant-signed debit of the user's ER session. */
  charge = (req: ChargeRequest) => this.post<BuildResponse>('/v1/spl/charge', req)

  /** Requires `authToken`. Reads the ephemeral-rollup balance. */
  privateBalance = (address: string, mint: string, cluster?: Cluster) =>
    this.get<BalanceResponse>('/v1/spl/private-balance', { address, mint, cluster })

  isMintInitialized = (mint: string, cluster?: Cluster) =>
    this.get<MintStatusResponse>('/v1/spl/is-mint-initialized', { mint, cluster })

  challenge = (pubkey: string) =>
    this.get<{ challenge: string }>('/v1/spl/challenge', { pubkey })

  login = (pubkey: string, challenge: string, signature: string) =>
    this.post<{ token: string }>('/v1/spl/login', { pubkey, challenge, signature })

  private async get<T>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
    return this.request<T>(url.toString(), { method: 'GET' }, path)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(
      this.baseUrl + path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(prune(body)),
      },
      path,
    )
  }

  private async request<T>(url: string, init: RequestInit, path: string): Promise<T> {
    const headers = new Headers(init.headers)
    if (this.authToken) headers.set('authorization', `Bearer ${this.authToken}`)

    const signal = AbortSignal.timeout(this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(url, { ...init, headers, signal })
    } catch (cause) {
      throw new ApiError(`Request to ${path} failed: ${(cause as Error).message}`, 0, 'NETWORK', path)
    }

    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      throw new ApiError(`${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status, 'BAD_JSON', path)
    }

    const err = (body as { error?: { code?: string; message?: string; issues?: unknown } }).error
    if (err || !res.ok) {
      const issues = err?.issues ? ` ${JSON.stringify(err.issues)}` : ''
      throw new ApiError(
        `${path}: ${err?.message ?? res.statusText}${issues}`,
        res.status,
        err?.code,
        path,
      )
    }
    return body as T
  }
}

/** Drops undefined keys so we never send `"foo": null` to a strict validator. */
function prune(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
}

/**
 * The API requires `clientRefId` to be a non-negative bigint string, so a
 * random 64-bit integer is the widest usable id space.
 */
export function newRefId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v.toString()
}
