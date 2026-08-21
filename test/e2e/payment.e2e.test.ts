import { describe, it, expect, beforeAll } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { HyperPay, loadKeypair } from '@magicblock-labs/hyperpay-core'

/**
 * True end-to-end against live devnet. Nothing is mocked: this builds, signs,
 * submits and confirms real transactions on Solana devnet and the MagicBlock
 * ephemeral rollup.
 *
 * Requires:
 *   E2E_PAYER_KEY  path to a funded devnet keypair
 *   E2E_PAYEE      recipient pubkey
 *   E2E_MINT       an SPL mint the payer holds
 */
const { E2E_PAYER_KEY, E2E_PAYEE, E2E_MINT } = process.env
const configured = Boolean(E2E_PAYER_KEY && E2E_PAYEE && E2E_MINT)

describe.skipIf(!configured)('live devnet payment', () => {
  let hp: HyperPay
  let payer: string

  beforeAll(() => {
    payer = loadKeypair(E2E_PAYER_KEY!).publicKey.toBase58()
    hp = new HyperPay({
      key: E2E_PAYER_KEY,
      cluster: 'devnet',
      tokens: [{ mint: E2E_MINT!, symbol: 'TEST', decimals: 6 }],
      defaultToken: 'TEST',
      policy: { maxPerTx: '5 TEST', dailyCap: '50 TEST' },
    })
  })

  it('registers the mint with the ephemeral validator', async () => {
    const result = await hp.initializeMint()
    expect(result.mint).toBe(E2E_MINT)
    const status = await hp.api.isMintInitialized(E2E_MINT!, 'devnet')
    expect(status.initialized).toBe(true)
  })

  it('reads a real base-layer balance', async () => {
    const balances = await hp.balance()
    expect(balances.address).toBe(payer)
    expect(BigInt(balances.baseUnits)).toBeGreaterThan(0n)
  })

  it('quotes a private payment without sending it', async () => {
    const quote = await hp.quote(E2E_PAYEE!, '1')
    expect(quote.visibility).toBe('private')
    expect(quote.units).toBe('1000000')
    expect(quote.instructionCount).toBeGreaterThan(0)
  })

  it('settles a private payment and moves real balance', async () => {
    const before = await hp.balance()
    const payment = await hp.pay(E2E_PAYEE!, '1')

    expect(payment.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
    expect(payment.visibility).toBe('private')
    expect(payment.refId).toMatch(/^\d+$/)

    const after = await hp.balance()
    const spent = BigInt(before.baseUnits) - BigInt(after.baseUnits)
    // 1 token moved, plus the 0.1% privacy fee.
    expect(spent).toBeGreaterThanOrEqual(1_000_000n)
  })

  /**
   * Uses a brand-new recipient rather than the shared payee. Private transfers
   * settle through a queue, so an earlier private payment can land in the
   * middle of this test and corrupt a delta measured against a reused account.
   * A fresh key also proves the first-ever payment to an unknown wallet works —
   * HyperPay creates the recipient's token account as part of the transfer.
   */
  it('settles a public payment to a brand-new recipient', async () => {
    const stranger = Keypair.generate().publicKey.toBase58()
    expect((await hp.balance({ address: stranger })).baseUnits).toBe('0')

    const payment = await hp.pay(stranger, '1', { visibility: 'public' })
    expect(payment.settledOn).toBe('base')
    expect(payment.explorerUrl).toContain('cluster=devnet')

    const after = await hp.balance({ address: stranger })
    expect(BigInt(after.baseUnits)).toBe(1_000_000n)
  })

  it('refuses a payment over the per-transaction cap before signing', async () => {
    await expect(hp.pay(E2E_PAYEE!, '10')).rejects.toThrow(/per-transaction cap/)
  })
})
