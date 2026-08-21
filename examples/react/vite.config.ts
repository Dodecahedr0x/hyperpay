import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../..', import.meta.url))
const src = (pkg: string, file: string) => path.join(root, 'packages', pkg, 'src', file)

export default defineConfig({
  plugins: [react()],
  // ponytail: workspace source so `npm run dev` works without a package build
  resolve: {
    alias: {
      '@magicblock-labs/hyperpay-core/client': src('core', 'client.ts'),
      '@magicblock-labs/hyperpay-react': src('react', 'index.ts'),
      '@magicblock-labs/hyperpay-solana': src('solana', 'index.ts'),
      '@magicblock-labs/hyperpay-types': src('types', 'index.ts'),
    },
  },
  optimizeDeps: {
    exclude: [
      '@magicblock-labs/hyperpay-react',
      '@magicblock-labs/hyperpay-core',
      '@magicblock-labs/hyperpay-solana',
      '@magicblock-labs/hyperpay-types',
    ],
  },
})
