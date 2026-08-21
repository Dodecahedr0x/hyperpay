import { PolicyError, formatAmount, parseMoney, toBaseUnits, type TokenInfo } from '@magicblock-labs/hyperpay-types'

export interface PolicyConfig {
  /** Per-transaction ceiling, e.g. `"25 USDC"` or `"25 USDC, 10 USDT"`. */
  maxPerTx?: string
  /** Rolling UTC-day ceiling, same format as `maxPerTx`. */
  dailyCap?: string
  /** If set, only these recipients are payable. Supports `*` wildcards. */
  allow?: string[]
  /** Always rejected, even if allowed. Checked first. */
  deny?: string[]
}

export interface PaymentIntent {
  to: string
  token: TokenInfo
  units: bigint
}

export type Journal = Record<string, Record<string, string>>

export interface JournalStore {
  read(): Journal
  write(journal: Journal): void
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const memoryByPath = new Map<string, Journal>()

export function memoryJournal(initial: Journal = {}): JournalStore {
  let data = initial
  return {
    read: () => data,
    write: (journal) => {
      data = journal
    },
  }
}

/** In-process store keyed by path so two Policy instances share spend without fs. */
function pathMemory(path: string): JournalStore {
  return {
    read: () => memoryByPath.get(path) ?? {},
    write: (journal) => {
      memoryByPath.set(path, journal)
    },
  }
}

let fileJournalFactory: ((path: string) => JournalStore) | undefined
let defaultJournalPathFn: () => string = () => ':memory:'

export function setFileJournal(factory: (path: string) => JournalStore): void {
  fileJournalFactory = factory
}

export function setDefaultJournalPath(fn: () => string): void {
  defaultJournalPathFn = fn
}

export function defaultJournalPath(): string {
  return defaultJournalPathFn()
}

/** Node default after `node-install`; `:memory:` in the browser. */
export const DEFAULT_JOURNAL = ':memory:'

/**
 * A pattern is treated as a literal pubkey (exact, case-sensitive) when it
 * looks like one. Base58 is case-significant — lowercasing a pubkey produces a
 * *different* address, so glob-style case folding would be a real footgun here.
 */
export function matchesPattern(value: string, pattern: string): boolean {
  if (BASE58.test(pattern) && !pattern.includes('*')) return value === pattern
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

/** `"25 USDC, 10 USDT"` → `{ USDC: "25", USDT: "10" }` */
function parseCaps(spec: string): Record<string, string> {
  const caps: Record<string, string> = {}
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const { value, symbol } = parseMoney(part)
    if (!symbol) {
      throw new PolicyError(`Spend cap "${part}" must name a token, e.g. "25 USDC"`)
    }
    caps[symbol] = value
  }
  return caps
}

function storeFrom(journal?: string | JournalStore): JournalStore {
  if (journal && typeof journal === 'object') return journal
  const path = typeof journal === 'string' ? journal : defaultJournalPathFn()
  if (path === ':memory:') return memoryJournal()
  return fileJournalFactory ? fileJournalFactory(path) : pathMemory(path)
}

/**
 * Client-side spend rules for agent wallets.
 *
 * These are a blast-radius limiter, not a security boundary: any process
 * holding the key can sign without consulting this class. The real containment
 * is that a session key only ever holds what you deposited into it.
 */
export class Policy {
  private readonly maxPerTx?: Record<string, string>
  private readonly dailyCap?: Record<string, string>
  private readonly store: JournalStore

  constructor(
    private readonly config: PolicyConfig = {},
    journal: string | JournalStore = defaultJournalPathFn(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.maxPerTx = config.maxPerTx ? parseCaps(config.maxPerTx) : undefined
    this.dailyCap = config.dailyCap ? parseCaps(config.dailyCap) : undefined
    this.store = storeFrom(journal)
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    journal?: string | JournalStore,
  ): Policy {
    const list = (v?: string) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
    return new Policy(
      {
        maxPerTx: env.HYPERPAY_MAX_PER_TX,
        dailyCap: env.HYPERPAY_DAILY_CAP,
        allow: list(env.HYPERPAY_ALLOW),
        deny: list(env.HYPERPAY_DENY),
      },
      journal ?? env.HYPERPAY_JOURNAL ?? defaultJournalPathFn(),
    )
  }

  /** Throws `PolicyError` if this payment breaks a rule. Call before signing. */
  check(intent: PaymentIntent): void {
    const { to, token, units } = intent

    for (const pattern of this.config.deny ?? []) {
      if (matchesPattern(to, pattern)) {
        throw new PolicyError(`Recipient "${to}" is on the deny list (matched "${pattern}")`)
      }
    }

    const allow = this.config.allow
    if (allow?.length && !allow.some((p) => matchesPattern(to, p))) {
      throw new PolicyError(`Recipient "${to}" is not on the allow list (${allow.join(', ')})`)
    }

    if (this.maxPerTx) {
      const cap = this.capFor(this.maxPerTx, token, 'per-transaction')
      if (units > cap) {
        throw new PolicyError(
          `Payment of ${formatAmount(units, token)} exceeds the per-transaction cap of ${formatAmount(cap, token)}`,
        )
      }
    }

    if (this.dailyCap) {
      const cap = this.capFor(this.dailyCap, token, 'daily')
      const spent = this.spentToday(token.symbol)
      if (spent + units > cap) {
        throw new PolicyError(
          `Payment of ${formatAmount(units, token)} would exceed the daily cap of ` +
            `${formatAmount(cap, token)} (${formatAmount(spent, token)} already spent today)`,
        )
      }
    }
  }

  /** Records settled spend against the daily cap. Call only after a payment lands. */
  record(intent: PaymentIntent): void {
    if (!this.dailyCap) return
    const journal = this.store.read()
    const day = this.today()
    const bucket = (journal[day] ??= {})
    bucket[intent.token.symbol] = (BigInt(bucket[intent.token.symbol] ?? '0') + intent.units).toString()
    this.store.write(this.prune(journal))
  }

  spentToday(symbol: string): bigint {
    return BigInt(this.store.read()[this.today()]?.[symbol] ?? '0')
  }

  /**
   * Fails closed: if any cap is configured but none covers this token, the
   * payment is rejected. An agent that could route around a USDC cap by paying
   * in some other mint would make the cap decorative.
   */
  private capFor(caps: Record<string, string>, token: TokenInfo, kind: string): bigint {
    const cap = caps[token.symbol]
    if (cap === undefined) {
      throw new PolicyError(
        `No ${kind} cap configured for ${token.symbol} — refusing to pay in an uncapped token. ` +
          `Add one (e.g. "10 ${token.symbol}") or clear the ${kind} cap entirely.`,
      )
    }
    return toBaseUnits(cap, token.decimals)
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10)
  }

  /** Keeps the journal from growing without bound; only recent days matter. */
  private prune(journal: Journal): Journal {
    const days = Object.keys(journal).sort().slice(-30)
    return Object.fromEntries(days.map((d) => [d, journal[d]!]))
  }
}
