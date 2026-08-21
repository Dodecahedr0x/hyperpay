import { describe, it, expect } from 'vitest'
import {
  toBaseUnits,
  fromBaseUnits,
  parseMoney,
  formatAmount,
  lookupKnownToken,
} from '@magicblock-labs/hyperpay-types'

describe('toBaseUnits', () => {
  it('converts whole numbers', () => {
    expect(toBaseUnits('10', 6)).toBe(10_000_000n)
    expect(toBaseUnits('0', 6)).toBe(0n)
  })

  it('converts fractional amounts without float error', () => {
    expect(toBaseUnits('0.1', 6)).toBe(100_000n)
    expect(toBaseUnits('1.5', 6)).toBe(1_500_000n)
    expect(toBaseUnits('0.000001', 6)).toBe(1n)
    // 0.1 + 0.2 style drift must not appear: this is exact string math
    expect(toBaseUnits('0.3', 9)).toBe(300_000_000n)
  })

  it('handles amounts too large for a JS number exactly', () => {
    expect(toBaseUnits('9007199254.740993', 9)).toBe(9_007_199_254_740_993_000n)
  })

  it('strips thousands separators and surrounding space', () => {
    expect(toBaseUnits(' 1,000.5 ', 6)).toBe(1_000_500_000n)
  })

  it('rejects more precision than the mint supports', () => {
    expect(() => toBaseUnits('0.0000001', 6)).toThrow(/precision|decimals/i)
  })

  it('rejects negative, empty and non-numeric input', () => {
    expect(() => toBaseUnits('-1', 6)).toThrow()
    expect(() => toBaseUnits('', 6)).toThrow()
    expect(() => toBaseUnits('abc', 6)).toThrow()
    expect(() => toBaseUnits('1.2.3', 6)).toThrow()
  })
})

describe('fromBaseUnits', () => {
  it('round-trips and trims trailing zeros', () => {
    expect(fromBaseUnits(10_000_000n, 6)).toBe('10')
    expect(fromBaseUnits(1_500_000n, 6)).toBe('1.5')
    expect(fromBaseUnits(1n, 6)).toBe('0.000001')
    expect(fromBaseUnits(0n, 6)).toBe('0')
  })

  it('pads sub-unit values correctly', () => {
    expect(fromBaseUnits(123n, 9)).toBe('0.000000123')
  })
})

describe('parseMoney', () => {
  it('splits value and symbol', () => {
    expect(parseMoney('10 USDC')).toEqual({ value: '10', symbol: 'USDC' })
    expect(parseMoney('10USDC')).toEqual({ value: '10', symbol: 'USDC' })
    expect(parseMoney('0.25 usdc')).toEqual({ value: '0.25', symbol: 'USDC' })
  })

  it('accepts a bare value with no symbol', () => {
    expect(parseMoney('10')).toEqual({ value: '10' })
    expect(parseMoney(10)).toEqual({ value: '10' })
  })

  it('rejects a bare symbol or garbage', () => {
    expect(() => parseMoney('USDC')).toThrow()
    expect(() => parseMoney('')).toThrow()
  })
})

describe('lookupKnownToken', () => {
  it('resolves USDC per cluster to different mints', () => {
    const main = lookupKnownToken('USDC', 'mainnet')
    const dev = lookupKnownToken('USDC', 'devnet')
    expect(main?.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    expect(dev?.mint).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
    expect(main?.decimals).toBe(6)
  })

  it('is case-insensitive and returns undefined for unknown symbols', () => {
    expect(lookupKnownToken('usdc', 'mainnet')?.symbol).toBe('USDC')
    expect(lookupKnownToken('NOPE', 'mainnet')).toBeUndefined()
  })
})

describe('formatAmount', () => {
  it('renders a human string', () => {
    expect(formatAmount(10_000_000n, { mint: 'x', symbol: 'USDC', decimals: 6 })).toBe('10 USDC')
  })
})
