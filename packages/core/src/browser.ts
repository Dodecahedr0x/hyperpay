export * from './exports.js'
export { keypairSigner } from '@magicblock-labs/hyperpay-solana'
export type { HyperPaySigner } from '@magicblock-labs/hyperpay-solana'

export function loadKeypair(_source: string): never {
  throw new Error(
    'loadKeypair is not available in the browser. Pass { signer } — use walletAdapterSigner() from @magicblock-labs/hyperpay-react.',
  )
}

export function signerFromEnv(): undefined {
  return undefined
}
