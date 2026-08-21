import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Policy, matchesPattern } from '@magicblock-labs/hyperpay-core'
import { PolicyError } from '@magicblock-labs/hyperpay-types'

const USDC = { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 }
const USDT = { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 }

const pay = (units: bigint, token = USDC, to = 'alice@magicblock.id') => ({ to, token, units })

let journal: string
beforeEach(() => {
  journal = join(mkdtempSync(join(tmpdir(), 'hyperpay-test-')), 'spend.json')
})

describe('matchesPattern', () => {
  it('matches exact handles and pubkeys', () => {
    expect(matchesPattern('alice@magicblock.id', 'alice@magicblock.id')).toBe(true)
    expect(matchesPattern('bob@magicblock.id', 'alice@magicblock.id')).toBe(false)
  })

  it('supports * wildcards without crossing the @ boundary implicitly', () => {
    expect(matchesPattern('bob.vendor.id', '*.vendor.id')).toBe(true)
    expect(matchesPattern('bob@evil.id', '*.vendor.id')).toBe(false)
    expect(matchesPattern('anything', '*')).toBe(true)
  })

  it('treats regex metacharacters in the pattern as literals', () => {
    expect(matchesPattern('aXc.id', 'a.c.id')).toBe(false)
    expect(matchesPattern('a.c.id', 'a.c.id')).toBe(true)
  })

  it('is case-insensitive for handles but exact for base58 pubkeys', () => {
    expect(matchesPattern('ALICE@magicblock.id', 'alice@magicblock.id')).toBe(true)
    const pk = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
    expect(matchesPattern(pk, pk)).toBe(true)
    expect(matchesPattern(pk.toLowerCase(), pk)).toBe(false)
  })
})

describe('Policy — no config', () => {
  it('allows anything when unconfigured', () => {
    const p = new Policy({}, journal)
    expect(() => p.check(pay(1_000_000_000n))).not.toThrow()
  })
})

describe('Policy — per-tx cap', () => {
  it('allows at the cap and rejects above it', () => {
    const p = new Policy({ maxPerTx: '25 USDC' }, journal)
    expect(() => p.check(pay(25_000_000n))).not.toThrow()
    expect(() => p.check(pay(25_000_001n))).toThrow(PolicyError)
  })

  it('names the cap and the attempted amount in the error', () => {
    const p = new Policy({ maxPerTx: '25 USDC' }, journal)
    expect(() => p.check(pay(30_000_000n))).toThrow(/30 USDC.*25 USDC|25 USDC.*30 USDC/)
  })

  it('fails closed for a token with no configured cap', () => {
    const p = new Policy({ maxPerTx: '25 USDC' }, journal)
    expect(() => p.check(pay(1_000_000n, USDT))).toThrow(PolicyError)
  })

  it('supports per-token caps', () => {
    const p = new Policy({ maxPerTx: '25 USDC, 10 USDT' }, journal)
    expect(() => p.check(pay(20_000_000n, USDC))).not.toThrow()
    expect(() => p.check(pay(20_000_000n, USDT))).toThrow(PolicyError)
  })
})

describe('Policy — daily cap', () => {
  it('accumulates recorded spend and rejects once exceeded', () => {
    const p = new Policy({ dailyCap: '100 USDC' }, journal)
    p.check(pay(60_000_000n))
    p.record(pay(60_000_000n))
    expect(() => p.check(pay(30_000_000n))).not.toThrow()
    expect(() => p.check(pay(41_000_000n))).toThrow(/daily/i)
  })

  it('persists spend across instances sharing a journal', () => {
    new Policy({ dailyCap: '100 USDC' }, journal).record(pay(90_000_000n))
    const fresh = new Policy({ dailyCap: '100 USDC' }, journal)
    expect(() => fresh.check(pay(20_000_000n))).toThrow(/daily/i)
  })

  it('scopes spend to a UTC day', () => {
    const p = new Policy({ dailyCap: '100 USDC' }, journal, () => new Date('2026-08-11T23:59:00Z'))
    p.record(pay(90_000_000n))
    const nextDay = new Policy({ dailyCap: '100 USDC' }, journal, () => new Date('2026-08-12T00:01:00Z'))
    expect(() => nextDay.check(pay(90_000_000n))).not.toThrow()
  })

  it('tracks each token independently', () => {
    const p = new Policy({ dailyCap: '100 USDC, 100 USDT' }, journal)
    p.record(pay(95_000_000n, USDC))
    expect(() => p.check(pay(50_000_000n, USDT))).not.toThrow()
    expect(() => p.check(pay(50_000_000n, USDC))).toThrow(/daily/i)
  })
})

describe('Policy — recipient rules', () => {
  it('allows only listed recipients when an allowlist is set', () => {
    const p = new Policy({ allow: ['alice@magicblock.id', '*.vendor.id'] }, journal)
    expect(() => p.check(pay(1n, USDC, 'alice@magicblock.id'))).not.toThrow()
    expect(() => p.check(pay(1n, USDC, 'acme.vendor.id'))).not.toThrow()
    expect(() => p.check(pay(1n, USDC, 'mallory@evil.id'))).toThrow(/allow/i)
  })

  it('denylist overrides allowlist', () => {
    const p = new Policy({ allow: ['*'], deny: ['mallory@evil.id'] }, journal)
    expect(() => p.check(pay(1n, USDC, 'anyone@x.id'))).not.toThrow()
    expect(() => p.check(pay(1n, USDC, 'mallory@evil.id'))).toThrow(/deny/i)
  })
})

describe('Policy.fromEnv', () => {
  it('reads caps and lists from environment variables', () => {
    const p = Policy.fromEnv(
      {
        HYPERPAY_MAX_PER_TX: '25 USDC',
        HYPERPAY_DAILY_CAP: '200 USDC',
        HYPERPAY_ALLOW: 'alice@magicblock.id,*.vendor.id',
      },
      journal,
    )
    expect(() => p.check(pay(30_000_000n))).toThrow(PolicyError)
    expect(() => p.check(pay(1n, USDC, 'mallory@evil.id'))).toThrow(PolicyError)
    expect(() => p.check(pay(1n, USDC, 'alice@magicblock.id'))).not.toThrow()
  })
})
