/**
 * Local MagicBlock stack: boots `mb-stack`, deploys hyperpay, then exercises
 * the TypeScript SDK, x402 paywall, and Rust SDK against those nodes.
 *
 * Token balances live in eSPL eATAs (deposited + delegated on the base
 * validator) so charge/withdraw can write them on the ER. Ephemeral submits
 * skip preflight — local ER simulation rejects writable JIT clones.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess, execFile as execFileCb } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AddressInfo } from 'node:net'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { HyperPay, PROGRAM_ID, userPda, initEphemeralAtaIx, delegateEphemeralAtaIx } from '@magicblock-labs/hyperpay-core'
import { Paywall, payingFetch, challengeBody, PAYMENT_HEADER } from '@magicblock-labs/hyperpay-x402'
import {
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAtaIdempotentIx,
  keypairSigner,
} from '@magicblock-labs/hyperpay-solana'

const execFile = promisify(execFileCb)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BASE_RPC = process.env.HYPERPAY_RPC ?? 'http://127.0.0.1:8899'
const ER_RPC = process.env.HYPERPAY_EPHEMERAL_RPC ?? 'http://127.0.0.1:7799'
const PROGRAM_SO = resolve(root, 'target/deploy/hyperpay.so')
const hasMbStack = existsSync('/opt/homebrew/bin/mb-stack') || Boolean(process.env.MB_STACK)

describe.skipIf(!hasMbStack)('mb-stack payment sessions', () => {
  let stack: ChildProcess | undefined
  let startedStack = false
  let userKey: Keypair
  let merchantKey: Keypair
  let rustUserKey: Keypair
  let mint: PublicKey
  let userHp: HyperPay
  let merchantHp: HyperPay
  const token = { symbol: 'TEST', mint: '', decimals: 6 }

  beforeAll(async () => {
    await ensureProgramSo()
    const started = await ensureStack()
    startedStack = started !== undefined
    stack = started
    const connection = new Connection(BASE_RPC, 'confirmed')
    userKey = Keypair.generate()
    merchantKey = Keypair.generate()
    rustUserKey = Keypair.generate()
    await airdrop(connection, [userKey.publicKey, merchantKey.publicKey, rustUserKey.publicKey])
    mint = await createMint(connection, userKey)
    token.mint = mint.toBase58()

    userHp = new HyperPay({
      signer: keypairSigner(userKey),
      cluster: 'devnet',
      rpcUrl: BASE_RPC,
      ephemeralRpcUrl: ER_RPC,
      tokens: [token],
      defaultToken: 'TEST',
    })
    merchantHp = new HyperPay({
      signer: keypairSigner(merchantKey),
      cluster: 'devnet',
      rpcUrl: BASE_RPC,
      ephemeralRpcUrl: ER_RPC,
      tokens: [token],
      defaultToken: 'TEST',
    })

    await userHp.initUser(15_000_000n)
    await userHp.delegateUser()
    // Local ER needs a beat to clone the delegated User PDA (MagicBlock docs: 2–3s).
    await new Promise((r) => setTimeout(r, 3_000))
    const [user] = userPda(userKey.publicKey)
    await send(connection, userKey, [
      createAtaIdempotentIx(userKey.publicKey, user, mint),
      createAtaIdempotentIx(userKey.publicKey, userKey.publicKey, mint),
      createAtaIdempotentIx(userKey.publicKey, merchantKey.publicKey, mint),
    ])
    await send(connection, userKey, [
      mintToIx(mint, associatedTokenAddress(mint, userKey.publicKey), userKey.publicKey, 10_000_000n),
    ])
    await userHp.topUp('10')
    await send(connection, userKey, [
      initEphemeralAtaIx(userKey.publicKey, userKey.publicKey, mint),
      initEphemeralAtaIx(userKey.publicKey, merchantKey.publicKey, mint),
    ])
    await send(connection, userKey, [
      delegateEphemeralAtaIx(userKey.publicKey, userKey.publicKey, mint),
      delegateEphemeralAtaIx(userKey.publicKey, merchantKey.publicKey, mint),
    ])
  }, 180_000)

  afterAll(async () => {
    if (startedStack && stack?.pid) {
      stack.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 500))
    }
  })

  it('opens a session, charges from TypeScript, x402, then Rust', async () => {
    const opened = await userHp.openSession(merchantKey.publicKey.toBase58(), '5')
    expect(opened.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
    expect(opened.settledOn).toBe('ephemeral')

    const before = await merchantHp.sessionBalance(userKey.publicKey.toBase58())
    expect(before.baseUnits).toBe('5000000')

    const charged = await merchantHp.charge(userKey.publicKey.toBase58(), '1')
    expect(charged.settledOn).toBe('ephemeral')
    expect((await merchantHp.sessionBalance(userKey.publicKey.toBase58())).baseUnits).toBe('4000000')

    const paywall = new Paywall({
      hp: merchantHp,
      price: '1 TEST',
      to: merchantKey.publicKey.toBase58(),
    })
    const server = createServer(async (req, res) => {
      const result = await paywall.verify(req.headers[PAYMENT_HEADER] as string | undefined)
      if (!result.ok) {
        const requirement = await paywall.challenge()
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...challengeBody(requirement), reason: result.reason }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, strength: result.strength }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/data`
    try {
      const unpaid = await fetch(url)
      expect(unpaid.status).toBe(402)
      const paid = await payingFetch({ hp: userHp, maxPrice: '2 TEST' })(url)
      if (paid.status !== 200) {
        throw new Error(`x402 retry: ${paid.status} ${await paid.text()}`)
      }
      expect((await paid.json() as { strength: string }).strength).toBe('settled')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }

    const mid = await merchantHp.sessionBalance(userKey.publicKey.toBase58())
    expect(mid.baseUnits).toBe('3000000')

    await writeKeypair(rustUserKey, 'rust-user.json')
    await writeKeypair(merchantKey, 'rust-merchant.json')
    const { stdout } = await execFile(
      'cargo',
      ['test', '-p', 'hyperpay', '--test', 'mb_stack', '--', '--ignored', '--nocapture'],
      {
        cwd: root,
        env: {
          ...process.env,
          HYPERPAY_RPC: BASE_RPC,
          HYPERPAY_EPHEMERAL_RPC: ER_RPC,
          HYPERPAY_KEY: resolve(root, 'test/.artifacts/rust-merchant.json'),
          HYPERPAY_USER_KEY: resolve(root, 'test/.artifacts/rust-user.json'),
          E2E_USER: userKey.publicKey.toBase58(),
          E2E_MINT: mint.toBase58(),
        },
      },
    )
    expect(stdout).toMatch(/test rust_sdk_charges_an_open_session ... ok/)
    expect(stdout).toMatch(/test rust_sdk_inits_and_delegates_user ... ok/)

    const afterRust = await merchantHp.sessionBalance(userKey.publicKey.toBase58())
    expect(afterRust.baseUnits).toBe('2000000')

    await userHp.deposit(merchantKey.publicKey.toBase58(), '1')
    const deposited = await merchantHp.sessionBalance(userKey.publicKey.toBase58())
    expect(deposited.baseUnits).toBe('3000000')

    await userHp.closeSession(merchantKey.publicKey.toBase58())
    const closed = await merchantHp.sessionBalance(userKey.publicKey.toBase58())
    expect(closed.baseUnits).toBe('0')

    const withdrew = await userHp.withdraw('1')
    expect(withdrew.settledOn).toBe('ephemeral')
  }, 180_000)
})

async function ensureProgramSo() {
  if (existsSync(PROGRAM_SO)) return
  await execFile('cargo-build-sbf', ['--manifest-path', resolve(root, 'programs/hyperpay/Cargo.toml')], {
    cwd: root,
  })
}

async function ensureStack(): Promise<ChildProcess | undefined> {
  await killPort(8899)
  await killPort(7799)
  await killPort(6699)
  await killPort(9900)
  await new Promise((r) => setTimeout(r, 1000))
  const ledger = resolve(root, 'test/.artifacts/mb-ledger')
  const child = spawn(
    'mb-stack',
    ['--reset', '--ledger', ledger, '--bpf-program', PROGRAM_ID.toBase58(), PROGRAM_SO],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const logs: string[] = []
  child.stdout?.on('data', (d) => logs.push(String(d)))
  child.stderr?.on('data', (d) => logs.push(String(d)))
  try {
    await Promise.all([waitForRpc(BASE_RPC, 90_000), waitForRpc(ER_RPC, 90_000)])
  } catch (error) {
    child.kill('SIGTERM')
    throw new Error(`${error instanceof Error ? error.message : error}\n${logs.join('')}`)
  }
  return child
}

async function killPort(port: number) {
  try {
    const { stdout } = await execFile('lsof', ['-ti', `tcp:${port}`])
    for (const pid of stdout.trim().split('\n').filter(Boolean)) {
      process.kill(Number(pid), 'SIGTERM')
    }
    await new Promise((r) => setTimeout(r, 300))
  } catch {
    // nothing listening
  }
}

async function rpcReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForRpc(url: string, timeoutMs: number) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await rpcReady(url)) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`RPC ${url} was not ready after ${timeoutMs}ms`)
}

async function airdrop(connection: Connection, keys: PublicKey[]) {
  for (const key of keys) {
    const sig = await connection.requestAirdrop(key, 2_000_000_000)
    await connection.confirmTransaction(sig, 'confirmed')
  }
}

async function createMint(connection: Connection, payer: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate()
  const rent = await connection.getMinimumBalanceForRentExemption(82)
  const data = Buffer.alloc(67)
  data[0] = 20
  data[1] = 6
  data.set(payer.publicKey.toBytes(), 2)
  data[34] = 0
  await send(
    connection,
    payer,
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: 82,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
        data,
      }),
    ],
    [mint],
  )
  return mint.publicKey
}

function mintToIx(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9)
  data[0] = 7
  data.writeBigUInt64LE(amount, 1)
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  })
}

async function send(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  extra: Keypair[] = [],
  skipPreflight = true,
) {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = payer.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
  tx.sign(payer, ...extra)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight })
  try {
    await connection.confirmTransaction(sig, 'confirmed')
  } catch (error) {
    const logs = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })
    throw new Error(`${error instanceof Error ? error.message : error}\n${JSON.stringify(logs?.meta?.logMessages)}`)
  }
}

async function writeKeypair(keypair: Keypair, name: string) {
  const dir = resolve(root, 'test/.artifacts')
  await mkdir(dir, { recursive: true })
  await writeFile(resolve(dir, name), JSON.stringify([...keypair.secretKey]))
}
