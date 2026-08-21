import type { Cluster } from './amounts.js'

/** Every transaction-building endpoint returns this shape. */
export interface BuildResponse {
  kind: 'deposit' | 'withdraw' | 'transfer' | 'initializeMint'
  version: 'legacy' | 'v0'
  transactionBase64: string
  /** Which network to submit to. `ephemeral` means use `sendRpcEndpoint`. */
  sendTo: 'base' | 'ephemeral'
  sendRpcEndpoint?: string
  from?: 'base' | 'ephemeral'
  recentBlockhash: string
  lastValidBlockHeight: number
  instructionCount: number
  requiredSigners: string[]
  validator?: string
  fees?: { lamports: string; tokens: string }
}

export interface TransferRequest {
  from: string
  /** Recipient pubkey or stealth handle (`alice@magicblock.id`). */
  to: string
  mint: string
  amount: number
  cluster?: Cluster
  visibility?: 'public' | 'private'
  fromBalance?: 'base' | 'ephemeral'
  toBalance?: 'base' | 'ephemeral'
  initIfMissing?: boolean
  initAtasIfMissing?: boolean
  memo?: string
  /** Milliseconds, as a *string* — the API rejects numbers here. */
  minDelayMs?: string
  maxDelayMs?: string
  /** Must be a non-negative bigint **string**, not free text. See `newRefId()`. */
  clientRefId?: string
  /** Fan the transfer across 1–15 queue entries to weaken amount correlation. */
  split?: number
  exactOut?: boolean
  gasless?: boolean
}

export interface DepositRequest {
  owner: string
  amount: number
  mint?: string
  cluster?: Cluster
  initIfMissing?: boolean
  initVaultIfMissing?: boolean
  initAtasIfMissing?: boolean
}

export interface WithdrawRequest {
  owner: string
  mint: string
  amount: number
  cluster?: Cluster
  initIfMissing?: boolean
  initAtasIfMissing?: boolean
}

export interface BalanceResponse {
  address: string
  mint: string
  ata: string
  location: 'base' | 'ephemeral'
  balance: string
}

export interface MintStatusResponse {
  mint: string
  validator: string
  transferQueue: string
  initialized: boolean
}

export interface ApiOptions {
  baseUrl?: string
  /** Bearer token from `login()`; required for private balance reads. */
  authToken?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}
