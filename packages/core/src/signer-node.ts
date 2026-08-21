import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { SignerError } from '@magicblock-labs/hyperpay-types'
import { keypairSigner, type HyperPaySigner } from '@magicblock-labs/hyperpay-solana'

/**
 * Loads a keypair from a base58 secret key, a JSON byte array, or a path to a
 * Solana CLI keypair file. Accepting all three means users rarely have to think
 * about which format they have.
 */
export function loadKeypair(source: string): Keypair {
  const value = source.trim()

  if (value.startsWith('[')) return fromBytes(JSON.parse(value) as number[], 'JSON array')

  // Anything with a path separator or .json suffix is a file, not a key.
  if (value.includes('/') || value.endsWith('.json')) {
    let contents: string
    try {
      contents = readFileSync(value, 'utf8')
    } catch (cause) {
      throw new SignerError(`Could not read keypair file "${value}"`, cause)
    }
    return fromBytes(JSON.parse(contents) as number[], `file ${value}`)
  }

  try {
    return fromBytes(Array.from(bs58.decode(value)), 'base58 secret key')
  } catch (cause) {
    if (cause instanceof SignerError) throw cause
    throw new SignerError(
      'Could not parse HYPERPAY_KEY — expected a base58 secret key, a JSON byte array, or a path to a keypair file',
      cause,
    )
  }
}

function fromBytes(bytes: number[], origin: string): Keypair {
  if (bytes.length !== 64) {
    throw new SignerError(`Expected a 64-byte secret key from ${origin}, got ${bytes.length} bytes`)
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes))
}

/** Reads `HYPERPAY_KEY` (or an explicit source) into a signer. */
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env, explicit?: string): HyperPaySigner | undefined {
  const source = explicit ?? env.HYPERPAY_KEY
  return source ? keypairSigner(loadKeypair(source)) : undefined
}
