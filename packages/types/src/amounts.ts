import { ResolutionError } from './errors.js'

export type Cluster = 'mainnet' | 'devnet' | 'mainnet-private' | 'devnet-private' | (string & {})

export interface TokenInfo {
  mint: string
  symbol: string
  decimals: number
}

/**
 * Tokens we can resolve from a symbol alone. Anything not listed here still
 * works — you pass the mint address and decimals are read from the chain.
 */
const KNOWN_TOKENS: Record<'mainnet' | 'devnet', TokenInfo[]> = {
  mainnet: [
    { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
    { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  ],
  devnet: [
    { symbol: 'USDC', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 },
    { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  ],
}

/** `mainnet-private` and a raw RPC URL both live on the mainnet token set. */
export function tokenFamily(cluster: Cluster): 'mainnet' | 'devnet' {
  return String(cluster).includes('devnet') ? 'devnet' : 'mainnet'
}

export function lookupKnownToken(spec: string, cluster: Cluster): TokenInfo | undefined {
  const want = spec.trim()
  const wantUpper = want.toUpperCase()
  return KNOWN_TOKENS[tokenFamily(cluster)].find((t) => t.symbol === wantUpper || t.mint === want)
}

const NUMERIC = /^[0-9][0-9,]*(?:\.[0-9]+)?$/
const MONEY = /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([A-Za-z][A-Za-z0-9]*)?\s*$/

/**
 * Decimal string → base units, using exact integer math.
 *
 * Never routes through `Number`: `0.1 + 0.2` problems are unacceptable when the
 * result is how much money moves, and amounts routinely exceed 2^53.
 */
export function toBaseUnits(value: string, decimals: number): bigint {
  const raw = String(value).trim().replace(/,/g, '')
  if (!NUMERIC.test(raw)) {
    throw new ResolutionError(`"${value}" is not a valid amount`)
  }
  const [whole = '0', frac = ''] = raw.split('.')
  if (frac.length > decimals) {
    throw new ResolutionError(
      `"${value}" has ${frac.length} decimal places but this mint supports ${decimals} — precision would be silently lost`,
    )
  }
  return BigInt(whole + frac.padEnd(decimals, '0'))
}

/** Base units → decimal string, trailing zeros trimmed. Inverse of `toBaseUnits`. */
export function fromBaseUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString()
  const padded = units.toString().padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const frac = padded.slice(-decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** Splits `"10 USDC"` into its value and (optional) symbol. */
export function parseMoney(input: string | number | bigint): { value: string; symbol?: string } {
  if (typeof input === 'bigint') return { value: input.toString() }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new ResolutionError(`"${input}" is not a valid amount`)
    }
    return { value: String(input) }
  }
  const match = MONEY.exec(input ?? '')
  if (!match?.[1]) throw new ResolutionError(`"${input}" is not a valid amount — expected e.g. "10 USDC"`)
  const symbol = match[2]
  return symbol ? { value: match[1], symbol: symbol.toUpperCase() } : { value: match[1] }
}

/** Renders base units as a human string, e.g. `"10 USDC"`. */
export function formatAmount<T extends { symbol: string; decimals: number }>(
  units: bigint,
  token: T,
): string {
  return `${fromBaseUnits(units, token.decimals)} ${token.symbol}`
}
