import { defineConfig } from 'vitest/config'

/**
 * Dist / published-exports job. Intentionally has no workspace source
 * aliases — packages must resolve through package.json `exports` → `dist`.
 *
 *   npm run build && npx vitest run --config vitest.dist.config.ts
 *
 * Tests skip with a clear message when `dist/` is missing so this job
 * does not flake while other packages are mid-edit.
 */
export default defineConfig({
  test: {
    include: ['test/exports/**/*.test.ts'],
    fileParallelism: false,
    environment: 'node',
  },
})
