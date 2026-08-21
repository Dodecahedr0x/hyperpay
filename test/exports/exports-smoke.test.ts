import { describe, it, expect } from 'vitest'
import { distMissingReason, nodeImport, workspacePackages } from './helpers.ts'

/**
 * Imports every public `exports` path from built `dist` using Node's real
 * package resolver (no vitest source aliases). A broken map or missing
 * Node target fails; a package that has not been built is skipped.
 *
 * Browser-only condition files are not required here — this job is Node.
 * Type-only modules (no runtime bindings) are allowed if they resolve.
 */
describe('exports smoke (dist, no aliases)', () => {
  const packages = workspacePackages()
  expect(packages.length).toBeGreaterThan(0)

  for (const pkg of packages) {
    describe(pkg.name, () => {
      const skip = distMissingReason(pkg.dir)
      if (skip) {
        it.skip(skip, () => {})
        return
      }

      if (pkg.specs.length === 0) {
        it('has no exports map entries', () => {
          expect(pkg.specs, `${pkg.name} package.json has no "exports"`).not.toHaveLength(0)
        })
        return
      }

      for (const { spec } of pkg.specs) {
        it(`resolves ${spec} from dist`, () => {
          const { url, keys } = nodeImport(spec)
          expect(url, `${spec} resolved outside dist:\n${url}`).toMatch(/\/dist\//)
          expect(url, `${spec} resolved to source:\n${url}`).not.toMatch(/\/src\//)
          expect(Array.isArray(keys), `${spec} did not produce a module namespace`).toBe(true)
        })
      }
    })
  }
})
