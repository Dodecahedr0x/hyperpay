import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  HyperPay,
  PROGRAM_ID,
  SESSION_REMAINING_OFFSET,
  chargeIx,
  delegateBufferPda,
  delegateUserIx,
  delegationMetadataPda,
  delegationRecordPda,
  ensureUserMintIx,
  depositSplIx,
  openSessionIx,
  sessionPda,
  userMintPda,
  userPda,
  DELEGATION_PROGRAM_ID,
  LOCAL_ER_VALIDATOR,
} from '@magicblock-labs/hyperpay-core'
import { PolicyError } from '@magicblock-labs/hyperpay-types'
import type { HyperPaySigner } from '@magicblock-labs/hyperpay-solana'

const USER_WALLET = new PublicKey('8fRp9fpqfXEMp2WGdsZa6rAuBvc1YayprRp6ZzMDLhHR')
const MERCHANT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const DEVNET_USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const SESSION_KEY = new PublicKey('97RmZAHQXThHyEn9BtFmAGtbVTRF4TBXKp4uv6rYoDkt')

function sighash(name: string): Uint8Array {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
}

function merchantSigner(): HyperPaySigner {
  return {
    publicKey: MERCHANT,
    signTransaction: async (tx) => tx,
  }
}

describe('program PDAs', () => {
  it('userPda matches [user, wallet] on the hyperpay program', () => {
    const [pda, bump] = userPda(USER_WALLET)
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('user'), USER_WALLET.toBuffer()],
      PROGRAM_ID,
    )
    expect(pda.equals(expected)).toBe(true)
    expect(bump).toBe(expectedBump)
    expect(PROGRAM_ID.toBase58()).toBe('Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU')
  })

  it('sessionPda matches [session, user, merchant, mint]', () => {
    const [user] = userPda(USER_WALLET)
    const [pda, bump] = sessionPda(user, MERCHANT, DEVNET_USDC)
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('session'), user.toBuffer(), MERCHANT.toBuffer(), DEVNET_USDC.toBuffer()],
      PROGRAM_ID,
    )
    expect(pda.equals(expected)).toBe(true)
    expect(bump).toBe(expectedBump)
  })

  it('userMintPda matches [user_mint, user, mint]', () => {
    const [user] = userPda(USER_WALLET)
    const [pda, bump] = userMintPda(user, DEVNET_USDC)
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_mint'), user.toBuffer(), DEVNET_USDC.toBuffer()],
      PROGRAM_ID,
    )
    expect(pda.equals(expected)).toBe(true)
    expect(bump).toBe(expectedBump)
  })
})

describe('HyperPay public surface', () => {
  it('has no PaymentsApi and no pay', async () => {
    const core = await import('@magicblock-labs/hyperpay-core')
    expect(core).not.toHaveProperty('PaymentsApi')
    expect(core).not.toHaveProperty('DEFAULT_API_URL')
    expect(HyperPay.prototype).not.toHaveProperty('pay')
    const hp = new HyperPay({ cluster: 'devnet', signer: merchantSigner() })
    expect(hp).not.toHaveProperty('api')
    expect((hp as { pay?: unknown }).pay).toBeUndefined()
  })
})

describe('instruction builders', () => {
  it('chargeIx omits the session token by passing the program id', () => {
    const [user] = userPda(USER_WALLET)
    const [userMint] = userMintPda(user, DEVNET_USDC)
    const [session] = sessionPda(user, MERCHANT, DEVNET_USDC)
    const ix = chargeIx(
      {
        user,
        signer: MERCHANT,
        userMint,
        session,
        merchant: MERCHANT,
        mint: DEVNET_USDC,
        userEata: Keypair.generate().publicKey,
      },
      Keypair.generate().publicKey,
      20n,
    )
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true)
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(sighash('charge')))
    const amount = Buffer.alloc(8)
    amount.writeBigUInt64LE(20n)
    expect(Buffer.from(ix.data.subarray(8))).toEqual(amount)
    const token = ix.keys.at(-1)!
    expect(token.pubkey.equals(PROGRAM_ID)).toBe(true)
    expect(token.isSigner).toBe(false)
    expect(ix.keys[1]!.pubkey.equals(MERCHANT)).toBe(true)
    expect(ix.keys[1]!.isSigner).toBe(true)
  })

  it('delegateUserIx CPI accounts target the local ER validator', () => {
    const [user] = userPda(USER_WALLET)
    const ix = delegateUserIx(user, USER_WALLET, LOCAL_ER_VALIDATOR)
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true)
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(sighash('delegate_user')))
    expect(ix.keys[0]!.pubkey.equals(USER_WALLET)).toBe(true)
    expect(ix.keys[0]!.isSigner).toBe(true)
    expect(ix.keys[1]!.pubkey.equals(delegateBufferPda(user))).toBe(true)
    expect(ix.keys[2]!.pubkey.equals(delegationRecordPda(user))).toBe(true)
    expect(ix.keys[3]!.pubkey.equals(delegationMetadataPda(user))).toBe(true)
    expect(ix.keys[4]!.pubkey.equals(user)).toBe(true)
    expect(ix.keys[5]!.pubkey.equals(PROGRAM_ID)).toBe(true)
    expect(ix.keys[6]!.pubkey.equals(DELEGATION_PROGRAM_ID)).toBe(true)
    expect(ix.keys.at(-1)!.pubkey.equals(LOCAL_ER_VALIDATOR)).toBe(true)
  })

  it('ensureUserMintIx creates the ephemeral UserMint with vault + magic program', () => {
    const [user] = userPda(USER_WALLET)
    const [userMint] = userMintPda(user, DEVNET_USDC)
    const ix = ensureUserMintIx(user, USER_WALLET, userMint, DEVNET_USDC)
    expect(Buffer.from(ix.data)).toEqual(Buffer.from(sighash('ensure_user_mint')))
    expect(ix.keys[0]!.pubkey.equals(user)).toBe(true)
    expect(ix.keys[0]!.isWritable).toBe(true)
    expect(ix.keys[1]!.pubkey.equals(USER_WALLET)).toBe(true)
    expect(ix.keys[1]!.isSigner).toBe(true)
    expect(ix.keys[2]!.pubkey.equals(userMint)).toBe(true)
    expect(ix.keys[2]!.isWritable).toBe(true)
    expect(ix.keys[3]!.pubkey.equals(DEVNET_USDC)).toBe(true)
    expect(ix.keys[4]!.pubkey.equals(PROGRAM_ID)).toBe(true)
    expect(ix.keys[5]!.pubkey.toBase58()).toBe('MagicVau1t999999999999999999999999999999999')
    expect(ix.keys[5]!.isWritable).toBe(true)
    expect(ix.keys[6]!.pubkey.toBase58()).toBe('Magic11111111111111111111111111111111111111')
  })

  it('depositSplIx credits the User eATA from the wallet ATA', () => {
    const [user] = userPda(USER_WALLET)
    const ix = depositSplIx(USER_WALLET, user, DEVNET_USDC, 1_000_000n)
    expect(ix.programId.toBase58()).toBe('SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2')
    expect(ix.data[0]).toBe(2)
    expect(ix.keys[5]!.pubkey.equals(USER_WALLET)).toBe(true)
    expect(ix.keys[5]!.isSigner).toBe(true)
  })
  it('openSessionIx allows amount 0', () => {
    const [user] = userPda(USER_WALLET)
    const ix = openSessionIx(
      {
        user,
        signer: USER_WALLET,
        userMint: Keypair.generate().publicKey,
        session: Keypair.generate().publicKey,
        merchant: MERCHANT,
        mint: DEVNET_USDC,
        userEata: Keypair.generate().publicKey,
      },
      0n,
    )
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(sighash('open_session')))
    expect(Buffer.from(ix.data.subarray(8))).toEqual(Buffer.from(new Uint8Array(8)))
  })

  it('does not derive userPda from a session-key signer', () => {
    const [fromWallet] = userPda(USER_WALLET)
    const [fromSessionKey] = userPda(SESSION_KEY)
    expect(fromWallet.equals(fromSessionKey)).toBe(false)
    const hp = new HyperPay({
      cluster: 'devnet',
      signer: { publicKey: SESSION_KEY, signTransaction: async (tx) => tx },
    })
    const accounts = hp.sessionAccounts({
      authority: USER_WALLET,
      merchant: MERCHANT,
      mint: DEVNET_USDC,
    })
    expect(accounts.user.equals(fromWallet)).toBe(true)
    expect(accounts.user.equals(fromSessionKey)).toBe(false)
    expect(accounts.signer.equals(SESSION_KEY)).toBe(true)
    expect(accounts.userEata.toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [fromWallet.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), DEVNET_USDC.toBuffer()],
        new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      )[0].toBase58(),
    )
  })
})

describe('HyperPay.charge', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('topUp checks policy against the user wallet before it signs', async () => {
    const fetch = async () => {
      throw new Error('policy must run before any RPC')
    }
    globalThis.fetch = fetch as typeof globalThis.fetch

    const hp = new HyperPay({
      signer: {
        publicKey: USER_WALLET,
        signTransaction: async (tx) => tx,
      },
      cluster: 'devnet',
      policy: { deny: [USER_WALLET.toBase58()] },
    })

    await expect(hp.topUp('1 USDC')).rejects.toBeInstanceOf(PolicyError)
  })

  it('checks policy against the merchant before it signs', async () => {
    const fetch = async () => {
      throw new Error('policy must run before any RPC')
    }
    globalThis.fetch = fetch as typeof globalThis.fetch

    const hp = new HyperPay({
      signer: merchantSigner(),
      cluster: 'devnet',
      policy: { deny: [MERCHANT.toBase58()] },
    })

    await expect(hp.charge(USER_WALLET.toBase58(), '0.01 USDC')).rejects.toBeInstanceOf(PolicyError)
  })
})

describe('HyperPay.sessionBalance', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reads remaining units from the session PDA on the ephemeral RPC', async () => {
    const [user] = userPda(USER_WALLET)
    const [session] = sessionPda(user, MERCHANT, DEVNET_USDC)
    const data = Buffer.alloc(SESSION_REMAINING_OFFSET + 8)
    data.writeBigUInt64LE(42_000n, SESSION_REMAINING_OFFSET)

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string
        params: [string, { encoding: string }]
      }
      expect(String(input)).toBe('https://ephemeral.test')
      expect(body.method).toBe('getAccountInfo')
      expect(body.params[0]).toBe(session.toBase58())
      expect(body.params[1]).toEqual({ encoding: 'base64' })
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { value: { data: [data.toString('base64'), 'base64'] } },
      })
    }) as typeof globalThis.fetch

    const hp = new HyperPay({
      signer: merchantSigner(),
      cluster: 'devnet',
      ephemeralRpcUrl: 'https://ephemeral.test',
    })
    const bal = await hp.sessionBalance(USER_WALLET.toBase58())

    expect(bal.address).toBe(USER_WALLET.toBase58())
    expect(bal.baseUnits).toBe('42000')
    expect(bal.base).toBe('0.042')
    expect(bal.token.mint).toBe(DEVNET_USDC.toBase58())
  })
})

describe('HyperPay.openSession', () => {
  it('resolves a zero amount instead of rejecting it', async () => {
    const hp = new HyperPay({
      signer: { publicKey: USER_WALLET, signTransaction: async (tx) => tx },
      cluster: 'devnet',
    })
    const resolved = await hp.resolveAmount(0, 'USDC', { allowZero: true })
    expect(resolved.units).toBe(0n)
    expect(resolved.token.mint).toBe(DEVNET_USDC.toBase58())
    await expect(hp.resolveAmount(0, 'USDC')).rejects.toThrow(/greater than zero/)
  })
})
