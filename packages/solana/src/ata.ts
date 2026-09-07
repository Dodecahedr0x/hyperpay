import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function associatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0]
}

/** `CreateIdempotent` — a no-op when the account already exists. */
export function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(mint, owner, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  })
}

/**
 * Guarantees a *public* transfer can reach a recipient who has never held this
 * token.
 *
 * The API's `initAtasIfMissing` creates the **sender's** associated token
 * account, not the recipient's, so a public transfer to a fresh wallet fails
 * with `InvalidAccountData`. Private transfers do not have this problem — they
 * settle through the rollup, which creates the destination itself.
 *
 * Prepending the idempotent create costs one instruction and nothing when the
 * account already exists, which is cheaper than an RPC round-trip to check.
 */
export function ensureRecipientAta(
  tx: Transaction,
  payer: PublicKey,
  recipient: string,
  mint: string,
): Transaction {
  if (!BASE58.test(recipient)) return tx // not a pubkey — cannot derive an ATA

  const tokenProgram =
    tx.instructions.find((ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID))
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID

  const owner = new PublicKey(recipient)
  const ata = associatedTokenAddress(new PublicKey(mint), owner, tokenProgram)

  // Already handled by the built transaction — don't add a duplicate.
  const alreadyCreated = tx.instructions.some(
    (ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[1]?.pubkey.equals(ata),
  )
  if (alreadyCreated) return tx

  tx.instructions.unshift(createAtaIdempotentIx(payer, owner, new PublicKey(mint), tokenProgram))
  return tx
}
