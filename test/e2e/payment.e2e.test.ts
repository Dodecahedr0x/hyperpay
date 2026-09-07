import { describe, it, expect, beforeAll } from 'vitest'
import { HyperPay, loadKeypair } from '@magicblock-labs/hyperpay-core'

/**
 * True end-to-end against live devnet / the ephemeral rollup.
 *
 * Requires:
 *   E2E_PAYER_KEY  path to a funded devnet keypair
 *   E2E_PAYEE      merchant pubkey
 *   E2E_MINT       an SPL mint the payer holds
 */
const { E2E_PAYER_KEY, E2E_PAYEE, E2E_MINT } = process.env
const configured = Boolean(E2E_PAYER_KEY && E2E_PAYEE && E2E_MINT)

describe.skipIf(!configured)('live payment session', () => {
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

  it('reads a real base-layer ATA balance', async () => {
    const balances = await hp.balance()
    expect(balances.address).toBe(payer)
    expect(BigInt(balances.baseUnits)).toBeGreaterThanOrEqual(0n)
  })

  it('quotes a session deposit without sending it', async () => {
    const quote = await hp.quote(E2E_PAYEE!, '1')
    expect(quote.units).toBe('1000000')
    expect(quote.settlesOn).toBe('ephemeral')
    expect(quote.to).toBe(E2E_PAYEE)
  })

  it('opens a session with the merchant', async () => {
    const payment = await hp.openSession(E2E_PAYEE!, '1')
    expect(payment.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
    expect(payment.settledOn).toBe('ephemeral')
  })

  it('refuses a deposit over the per-transaction cap before signing', async () => {
    await expect(hp.openSession(E2E_PAYEE!, '10')).rejects.toThrow(/per-transaction cap/)
  })
})
