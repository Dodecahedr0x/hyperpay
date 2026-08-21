import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

const RESULT_PREFIX = 'HP_EXPORTS_RESULT:'

export type ExportSpec = {
  spec: string
  subpath: string
}

export type WorkspacePackage = {
  dir: string
  name: string
  exports: Record<string, unknown>
  specs: ExportSpec[]
}

type ExportTarget = string | string[] | { [condition: string]: ExportTarget } | null | undefined

export function workspacePackages(): WorkspacePackage[] {
  const packagesRoot = join(root, 'packages')
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string
        exports?: Record<string, unknown>
      }
      const exports = pkg.exports ?? {}
      const specs: ExportSpec[] = Object.keys(exports).map((subpath) => ({
        spec: subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`,
        subpath,
      }))
      return { dir, name: pkg.name, exports, specs }
    })
}

export function pickExportFile(target: ExportTarget, conditions: string[]): string | null {
  if (!target) return null
  if (typeof target === 'string') return target
  if (Array.isArray(target)) {
    for (const entry of target) {
      const hit = pickExportFile(entry, conditions)
      if (hit) return hit
    }
    return null
  }
  for (const condition of conditions) {
    if (target[condition] !== undefined) {
      const hit = pickExportFile(target[condition], conditions)
      if (hit) return hit
    }
  }
  if (target.default !== undefined) {
    const hit = pickExportFile(target.default, conditions)
    if (hit) return hit
  }
  return null
}

export function resolvedExportFile(
  pkg: WorkspacePackage,
  subpath: string,
  conditions: string[],
): string | null {
  return pickExportFile(pkg.exports[subpath] as ExportTarget, conditions)
}

export function distMissingReason(pkgDir: string): string | null {
  if (existsSync(join(pkgDir, 'dist'))) return null
  const { name } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string }
  return `${name} has no dist/ — run \`npm run build\` first`
}

export function missingResolvedFile(
  pkg: WorkspacePackage,
  subpath: string,
  conditions: string[],
): string | null {
  const rel = resolvedExportFile(pkg, subpath, conditions)
  if (!rel) return `${pkg.name} export ${subpath} has no JS target for [${conditions.join(', ')}]`
  if (existsSync(join(pkg.dir, rel))) return null
  return `${pkg.name} ${rel} missing — run \`npm run build\` first`
}

export function treeShakeSkipReason(kind: 'browser' | 'node'): string | null {
  const packages = workspacePackages()
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const conditions = kind === 'browser' ? ['import', 'browser'] : ['import', 'node']
  const needed: [string, string][] = [
    ['@magicblock-labs/hyperpay', '.'],
    ['@magicblock-labs/hyperpay-types', '.'],
    ['@magicblock-labs/hyperpay-core', '.'],
    ['@magicblock-labs/hyperpay-core', './client'],
    ['@magicblock-labs/hyperpay-core', './signer'],
    ['@magicblock-labs/hyperpay-core', './policy'],
  ]
  if (kind === 'browser') needed.push(['@magicblock-labs/hyperpay-react', '.'])

  const missing: string[] = []
  for (const [name, subpath] of needed) {
    const pkg = byName.get(name)
    if (!pkg) {
      missing.push(`${name} (package not in workspace)`)
      continue
    }
    if (!existsSync(join(pkg.dir, 'dist'))) {
      missing.push(`${name} dist/`)
      continue
    }
    if (!(subpath in pkg.exports)) continue
    const reason = missingResolvedFile(pkg, subpath, conditions)
    if (reason) missing.push(reason)
  }
  if (missing.length === 0) return null
  return `dist missing (${missing.join('; ')}) — run \`npm run build\` first`
}

export function nodeEval(source: string): string {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `node exited ${result.status}`)
  }
  return result.stdout
}

export function nodeImport(spec: string): { url: string; keys: string[] } {
  const stdout = nodeEval(`
    const spec = ${JSON.stringify(spec)}
    const url = import.meta.resolve(spec)
    const mod = await import(spec)
    console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({
      url,
      keys: Object.keys(mod).sort(),
    }))
  `)
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(RESULT_PREFIX))
  if (!line) {
    throw new Error(`no result line from import ${spec}\n${stdout}`)
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as { url: string; keys: string[] }
}
