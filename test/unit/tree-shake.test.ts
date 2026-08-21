import { build } from 'esbuild'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

async function bundle(source: string): Promise<string> {
  const result = await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    treeShaking: true,
    alias: {
      '@magicblock-labs/hyperpay': resolve(root, 'packages/hyperpay/src/index.ts'),
      '@magicblock-labs/hyperpay-types': resolve(root, 'packages/types/src/index.ts'),
      '@magicblock-labs/hyperpay-types/amounts': resolve(root, 'packages/types/src/amounts.ts'),
      '@magicblock-labs/hyperpay-core': resolve(root, 'packages/core/src/index.ts'),
      '@magicblock-labs/hyperpay-core/client': resolve(root, 'packages/core/src/client.ts'),
      '@magicblock-labs/hyperpay-core/policy': resolve(root, 'packages/core/src/policy.ts'),
      '@magicblock-labs/hyperpay-core/signer': resolve(root, 'packages/core/src/signer-node.ts'),
      '@magicblock-labs/hyperpay-solana': resolve(root, 'packages/solana/src/index.ts'),
      '@magicblock-labs/hyperpay-solana/signer': resolve(root, 'packages/solana/src/signer.ts'),
      '@magicblock-labs/hyperpay-react': resolve(root, 'packages/react/src/index.ts'),
      '@magicblock-labs/hyperpay-x402': resolve(root, 'packages/x402/src/index.ts'),
    },
    external: [
      '@solana/web3.js',
      'bs58',
      'tweetnacl',
      'react',
      'react-dom',
      'react/jsx-runtime',
      'node:fs',
      'node:os',
      'node:path',
    ],
  })
  return result.outputFiles[0]!.text
}

describe('tree-shaking', () => {
  it('keeps an amounts-only import free of the payment client', async () => {
    const js = await bundle(`import { toBaseUnits } from '@magicblock-labs/hyperpay-types/amounts'\nexport const n = toBaseUnits('1', 6)\n`)
    expect(js).toMatch(/toBaseUnits/)
    expect(js).not.toMatch(/class HyperPay/)
    expect(js).not.toMatch(/PolicyError/)
    expect(js).not.toMatch(/PayButton/)
  })

  it('drops unused umbrella re-exports when only amounts are imported', async () => {
    const js = await bundle(`import { toBaseUnits } from '@magicblock-labs/hyperpay'\nexport const n = toBaseUnits('1', 6)\n`)
    expect(js).toMatch(/toBaseUnits/)
    expect(js).not.toMatch(/class HyperPay/)
    expect(js).not.toMatch(/PayButton/)
    expect(js).not.toMatch(/expressPaywall/)
    expect(js).not.toMatch(/node-install/)
  })
})
