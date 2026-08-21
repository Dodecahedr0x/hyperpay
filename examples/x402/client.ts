/**
 * Buys the paid snapshot. Same wallet as the server in this demo (self-pay).
 * Production uses two wallets — the client is the buyer, not the merchant.
 *
 *   export HYPERPAY_KEY=~/.config/solana/id.json
 *   export HYPERPAY_CLUSTER=devnet
 *   npx vite-node examples/x402/client.ts
 */
import { HyperPay } from '@magicblock-labs/hyperpay'
import { payingFetch } from '@magicblock-labs/hyperpay/x402'

const url = process.argv[2] ?? 'http://127.0.0.1:4021/snapshot'
const hp = HyperPay.fromEnv()

const fetchAndPay = payingFetch({
  hp,
  maxPrice: '0.05 USDC',
  visibility: 'private',
})

console.log('paying from', hp.signer?.publicKey.toBase58())
const res = await fetchAndPay(url)
console.log(`${res.status} ${res.statusText}`)
console.log(await res.json())
