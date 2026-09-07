import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js'

export const PROGRAM_ID = new PublicKey('Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU')
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const ESPL_TOKEN_PROGRAM_ID = new PublicKey('SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2')
export const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111')
export const EPHEMERAL_VAULT_ID = new PublicKey('MagicVau1t999999999999999999999999999999999')

export const USER_SEED = Buffer.from('user')
export const USER_MINT_SEED = Buffer.from('user_mint')
export const SESSION_SEED = Buffer.from('session')

/** `Session.remaining` is a little-endian `u64` after the discriminator and three pubkeys. */
export const SESSION_REMAINING_OFFSET = 8 + 32 + 32 + 32

const DISCRIMINATORS: Record<string, readonly number[]> = {
  init_user: [14, 51, 68, 159, 237, 78, 158, 102],
  fund_user: [36, 127, 154, 74, 24, 176, 49, 159],
  open_session: [130, 54, 124, 7, 236, 20, 104, 104],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  charge: [26, 55, 197, 209, 93, 77, 242, 15],
  close_session: [68, 114, 178, 140, 222, 38, 248, 211],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
}

export function userPda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([USER_SEED, wallet.toBuffer()], PROGRAM_ID)
}

export function userMintPda(user: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([USER_MINT_SEED, user.toBuffer(), mint.toBuffer()], PROGRAM_ID)
}

export function sessionPda(user: PublicKey, merchant: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SESSION_SEED, user.toBuffer(), merchant.toBuffer(), mint.toBuffer()],
    PROGRAM_ID,
  )
}

/** eSPL eATA: `[owner, mint]` on the eSPL token program. */
export function eataPda(owner: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), mint.toBuffer()], ESPL_TOKEN_PROGRAM_ID)
}

export interface SessionAccounts {
  user: PublicKey
  signer: PublicKey
  userMint: PublicKey
  session: PublicKey
  merchant: PublicKey
  mint: PublicKey
  userEata: PublicKey
}

export interface WithdrawAccounts {
  user: PublicKey
  signer: PublicKey
  userMint: PublicKey
  mint: PublicKey
  userEata: PublicKey
  destination: PublicKey
}

/** Anchor `Option<Account<_>>`: omit the account by passing the program id. */
function sessionTokenMeta(sessionToken?: PublicKey): AccountMeta {
  return { pubkey: sessionToken ?? PROGRAM_ID, isSigner: false, isWritable: false }
}

function ixData(name: string, amount?: bigint): Buffer {
  const disc = DISCRIMINATORS[name]
  if (!disc) throw new Error(`unknown hyperpay instruction "${name}"`)
  if (amount === undefined) return Buffer.from(disc)
  const data = Buffer.alloc(16)
  data.set(disc, 0)
  data.writeBigUInt64LE(amount, 8)
  return data
}

export function initUserIx(user: PublicKey, authority: PublicKey, lamports: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData('init_user', lamports),
  })
}

export function fundUserIx(
  user: PublicKey,
  signer: PublicKey,
  lamports: bigint,
  sessionToken?: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      sessionTokenMeta(sessionToken),
    ],
    data: ixData('fund_user', lamports),
  })
}

export function depositIx(
  accounts: SessionAccounts,
  amount: bigint,
  sessionToken?: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.user, isSigner: false, isWritable: false },
      { pubkey: accounts.signer, isSigner: true, isWritable: false },
      { pubkey: accounts.userMint, isSigner: false, isWritable: true },
      { pubkey: accounts.session, isSigner: false, isWritable: true },
      { pubkey: accounts.merchant, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.userEata, isSigner: false, isWritable: false },
      sessionTokenMeta(sessionToken),
    ],
    data: ixData('deposit', amount),
  })
}

export function openSessionIx(
  accounts: SessionAccounts,
  amount: bigint,
  sessionToken?: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.user, isSigner: false, isWritable: true },
      { pubkey: accounts.signer, isSigner: true, isWritable: false },
      { pubkey: accounts.session, isSigner: false, isWritable: true },
      { pubkey: accounts.userMint, isSigner: false, isWritable: true },
      { pubkey: accounts.merchant, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.userEata, isSigner: false, isWritable: false },
      sessionTokenMeta(sessionToken),
      { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: ixData('open_session', amount),
  })
}

export function chargeIx(
  accounts: SessionAccounts,
  merchantEata: PublicKey,
  amount: bigint,
  sessionToken?: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.user, isSigner: false, isWritable: false },
      { pubkey: accounts.signer, isSigner: true, isWritable: false },
      { pubkey: accounts.userMint, isSigner: false, isWritable: true },
      { pubkey: accounts.session, isSigner: false, isWritable: true },
      { pubkey: accounts.merchant, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.userEata, isSigner: false, isWritable: true },
      { pubkey: merchantEata, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      sessionTokenMeta(sessionToken),
    ],
    data: ixData('charge', amount),
  })
}

export function closeSessionIx(accounts: SessionAccounts, sessionToken?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.user, isSigner: false, isWritable: true },
      { pubkey: accounts.signer, isSigner: true, isWritable: false },
      { pubkey: accounts.session, isSigner: false, isWritable: true },
      { pubkey: accounts.userMint, isSigner: false, isWritable: true },
      { pubkey: accounts.merchant, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      sessionTokenMeta(sessionToken),
      { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: ixData('close_session'),
  })
}

export function withdrawIx(
  accounts: WithdrawAccounts,
  amount: bigint,
  sessionToken?: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.user, isSigner: false, isWritable: false },
      { pubkey: accounts.signer, isSigner: true, isWritable: false },
      { pubkey: accounts.userMint, isSigner: false, isWritable: false },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.userEata, isSigner: false, isWritable: true },
      { pubkey: accounts.destination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      sessionTokenMeta(sessionToken),
    ],
    data: ixData('withdraw', amount),
  })
}

export function remainingFromSessionData(data: Uint8Array): bigint | undefined {
  const end = SESSION_REMAINING_OFFSET + 8
  if (data.length < end) return undefined
  return Buffer.from(data.subarray(SESSION_REMAINING_OFFSET, end)).readBigUInt64LE()
}
