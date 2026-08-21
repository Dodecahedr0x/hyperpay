import { SignerError } from '@magicblock-labs/hyperpay-types'
import type { HyperPaySigner } from '@magicblock-labs/hyperpay-solana'

type Env = NodeJS.ProcessEnv

export let loadKey: (source: string) => HyperPaySigner = () => {
  throw new SignerError(
    'Cannot load a keypair in this environment. Pass { signer } instead — use walletAdapterSigner() in React.',
  )
}

export let envSigner: (env?: Env, explicit?: string) => HyperPaySigner | undefined = () => undefined

export function setKeyLoader(loader: typeof loadKey): void {
  loadKey = loader
}

export function setEnvSigner(loader: typeof envSigner): void {
  envSigner = loader
}
