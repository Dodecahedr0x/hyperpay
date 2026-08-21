import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

function src(rel: string) {
  return join(root, rel)
}

export default defineConfig({
  resolve: {
    // Vite/rollup prefix-matches string aliases. A root entry such as
    // `@magicblock-labs/hyperpay-core` would rewrite
    // `@magicblock-labs/hyperpay-core/client` → `…/index.ts/client`.
    // More specific subpaths MUST come first.
    alias: [
      { find: '@magicblock-labs/hyperpay-core/client', replacement: src('packages/core/src/client.ts') },
      { find: '@magicblock-labs/hyperpay-core/policy', replacement: src('packages/core/src/policy.ts') },
      { find: '@magicblock-labs/hyperpay-core/signer', replacement: src('packages/core/src/signer-node.ts') },
      { find: '@magicblock-labs/hyperpay-core/api', replacement: src('packages/core/src/api.ts') },
      { find: '@magicblock-labs/hyperpay-core', replacement: src('packages/core/src/index.ts') },

      { find: '@magicblock-labs/hyperpay-types/amounts', replacement: src('packages/types/src/amounts.ts') },
      { find: '@magicblock-labs/hyperpay-types/errors', replacement: src('packages/types/src/errors.ts') },
      { find: '@magicblock-labs/hyperpay-types/api', replacement: src('packages/types/src/api.ts') },
      { find: '@magicblock-labs/hyperpay-types', replacement: src('packages/types/src/index.ts') },

      { find: '@magicblock-labs/hyperpay-solana/signer', replacement: src('packages/solana/src/signer.ts') },
      { find: '@magicblock-labs/hyperpay-solana/engine', replacement: src('packages/solana/src/engine.ts') },
      { find: '@magicblock-labs/hyperpay-solana/ata', replacement: src('packages/solana/src/ata.ts') },
      { find: '@magicblock-labs/hyperpay-solana', replacement: src('packages/solana/src/index.ts') },

      { find: '@magicblock-labs/hyperpay-react/components/PayButton', replacement: src('packages/react/src/components/PayButton.tsx') },
      { find: '@magicblock-labs/hyperpay-react/components/PayModal', replacement: src('packages/react/src/components/PayModal.tsx') },
      { find: '@magicblock-labs/hyperpay-react/components/PaymentStatus', replacement: src('packages/react/src/components/PaymentStatus.tsx') },
      { find: '@magicblock-labs/hyperpay-react/components', replacement: src('packages/react/src/components/index.ts') },
      { find: '@magicblock-labs/hyperpay-react/provider', replacement: src('packages/react/src/provider.tsx') },
      { find: '@magicblock-labs/hyperpay-react/hooks', replacement: src('packages/react/src/hooks.ts') },
      { find: '@magicblock-labs/hyperpay-react/wallet', replacement: src('packages/react/src/wallet.ts') },
      { find: '@magicblock-labs/hyperpay-react/styles', replacement: src('packages/react/src/styles.ts') },
      { find: '@magicblock-labs/hyperpay-react', replacement: src('packages/react/src/index.ts') },

      { find: '@magicblock-labs/hyperpay-x402', replacement: src('packages/x402/src/index.ts') },

      { find: '@magicblock-labs/hyperpay/types', replacement: src('packages/hyperpay/src/types.ts') },
      { find: '@magicblock-labs/hyperpay/solana', replacement: src('packages/hyperpay/src/solana.ts') },
      { find: '@magicblock-labs/hyperpay/core', replacement: src('packages/hyperpay/src/core.ts') },
      { find: '@magicblock-labs/hyperpay/x402', replacement: src('packages/hyperpay/src/x402.ts') },
      { find: '@magicblock-labs/hyperpay/react', replacement: src('packages/hyperpay/src/react.ts') },
      { find: '@magicblock-labs/hyperpay/mcp', replacement: src('packages/hyperpay/src/mcp.ts') },
      { find: '@magicblock-labs/hyperpay', replacement: src('packages/hyperpay/src/index.ts') },
    ],
  },
  test: {
    fileParallelism: false,
    environmentMatchGlobs: [['packages/react/**', 'jsdom']],
    // Dist/exports smoke lives in test/exports and uses vitest.dist.config.ts
    // so a bare `vitest run` cannot pass via these source aliases.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/exports/**'],
  },
})
