import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { nodeEval, nodeImport, root, treeShakeSkipReason } from './helpers.ts'

/**
 * Dist-based tree-shake. Unlike `test/unit/tree-shake.test.ts`, this job
 * resolves workspace packages through their published `exports` / `dist`
 * files — no source aliases. `tsconfigRaw` is required so esbuild does
 * not follow the repo's `compilerOptions.paths` back to `src/`.
 */
async function bundle(source: string): Promise<string> {
  const result = await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'esm',
    // `browser` + `import` hit the tree-shakeable umbrella entry
    // (`dist/index.js`), not the Node side-effect entry (`dist/node.js`).
    platform: 'browser',
    treeShaking: true,
    conditions: ['import', 'browser'],
    tsconfigRaw: { compilerOptions: {} },
    external: [
      '@solana/web3.js',
      'bs58',
      'tweetnacl',
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@modelcontextprotocol/sdk',
      'zod',
      'node:fs',
      'node:os',
      'node:path',
      'node:crypto',
      'node:url',
    ],
  })
  return result.outputFiles[0]!.text
}

describe('dist tree-shake', () => {
  const browserSkip = treeShakeSkipReason('browser')
  const nodeSkip = treeShakeSkipReason('node')

  if (browserSkip) {
    it.skip(browserSkip, () => {})
  } else {
    it('import { toBaseUnits } from the umbrella does not pull HyperPay, React, or x402', async () => {
      const js = await bundle(
        `import { toBaseUnits } from '@magicblock-labs/hyperpay'\nexport const n = toBaseUnits('1', 6)\n`,
      )
      expect(js).toMatch(/toBaseUnits/)
      expect(js).not.toMatch(/class HyperPay/)
      expect(js).not.toMatch(/fromEnv/)
      expect(js).not.toMatch(/PayButton/)
      expect(js).not.toMatch(/PayModal/)
      expect(js).not.toMatch(/createPortal/)
      expect(js).not.toMatch(/react-dom/)
      expect(js).not.toMatch(/expressPaywall/)
      expect(js).not.toMatch(/payingFetch/)
      expect(js).not.toMatch(/x402/)
    })

    it('import { PayButton } drops PayModal / createPortal when tree-shaking works', async () => {
      const js = await bundle(
        `import { PayButton } from '@magicblock-labs/hyperpay-react'\nexport { PayButton }\n`,
      )
      expect(js).toMatch(/PayButton/)
      expect(js).not.toMatch(/PayModal/)
      expect(js).not.toMatch(/createPortal/)
    })
  }

  if (nodeSkip) {
    it.skip(nodeSkip, () => {})
    return
  }

  it('documents that Node ESM still evaluates live umbrella exports', () => {
    // Node's `exports` map picks the `node` condition → dist/node.js, which
    // side-effect-imports `@magicblock-labs/hyperpay-core` and `export *`s the
    // full index. ESM instantiates every live `export { … } from`, so
    // `import { toBaseUnits }` still evaluates HyperPay / policy / signer.
    const { url, keys } = nodeImport('@magicblock-labs/hyperpay')
    expect(url).toMatch(/\/dist\/node\.js$/)
    expect(url).not.toMatch(/\/src\//)

    const nodeSource = readFileSync(fileURLToPath(url), 'utf8')
    expect(nodeSource).toMatch(/@magicblock-labs\/hyperpay-core/)
    expect(nodeSource).toMatch(/export \* from ['"]\.\/index\.js['"]/)

    const namedOnly = nodeEval(`
      const { toBaseUnits } = await import('@magicblock-labs/hyperpay')
      if (typeof toBaseUnits !== 'function') throw new Error('toBaseUnits missing')
      const ns = await import('@magicblock-labs/hyperpay')
      console.log('HP_EXPORTS_RESULT:' + JSON.stringify({
        hasHyperPay: typeof ns.HyperPay === 'function',
      }))
    `)
    expect(namedOnly).toMatch(/"hasHyperPay":true/)
    expect(keys).toContain('toBaseUnits')
    expect(keys).toContain('HyperPay')
  })
})
