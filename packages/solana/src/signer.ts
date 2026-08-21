import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import nacl from 'tweetnacl'

export type AnyTransaction = Transaction | VersionedTransaction

/**
 * Anything that can authorise a payment.
 *
 * Implement this to keep keys out of HyperPay entirely — wallet adapters,
 * Turnkey, Privy, or a KMS all fit.
 */
export interface HyperPaySigner {
  publicKey: PublicKey
  signTransaction<T extends AnyTransaction>(tx: T): Promise<T>
  /** Needed only for authenticated reads (private balance). */
  signMessage?(message: Uint8Array): Promise<Uint8Array>
}

export function isVersioned(tx: AnyTransaction): tx is VersionedTransaction {
  return 'version' in tx
}

export function keypairSigner(keypair: Keypair): HyperPaySigner {
  return {
    publicKey: keypair.publicKey,
    async signTransaction<T extends AnyTransaction>(tx: T): Promise<T> {
      if (isVersioned(tx)) tx.sign([keypair])
      else tx.partialSign(keypair)
      return tx
    },
    async signMessage(message: Uint8Array): Promise<Uint8Array> {
      return nacl.sign.detached(message, keypair.secretKey)
    },
  }
}
