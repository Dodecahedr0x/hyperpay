import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const script = join(repo, 'scripts/docs.mjs')

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('scripts/docs.mjs', () => {
  it('extracts the live program id, CLI, MCP tools, and HyperPay methods', () => {
    const result = run(['json'])
    expect(result.status).toBe(0)
    const surface = JSON.parse(result.stdout)
    expect(surface.programId).toBe('Adyo1eYuP8deoLxwgkvaomUYvAUKUGryh4RGpdTR9YhU')
    expect(surface.instructions).toEqual(expect.arrayContaining(['init_user', 'open_session', 'charge']))
    expect(surface.cliCommands).toEqual(expect.arrayContaining(['open-session', 'charge', 'mcp']))
    expect(surface.mcpTools).toEqual(
      expect.arrayContaining(['open_session', 'charge', 'policy', 'session_balance']),
    )
    expect(surface.tsMethods.map((m: { name: string }) => m.name)).toEqual(
      expect.arrayContaining(['initUser', 'openSession', 'charge', 'topUp']),
    )
    expect(surface.fromEnvVars).toEqual(
      expect.arrayContaining(['HYPERPAY_KEY', 'HYPERPAY_CLUSTER', 'HYPERPAY_DENY']),
    )
  })

  it('passes check when the generated reference matches source', () => {
    const result = run(['check'])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('fails check when the generated reference is stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperpay-docs-'))
    dirs.push(dir)
    const stale = join(dir, 'reference.md')
    writeFileSync(stale, '# stale\n')
    const result = run(['check'], { HYPERPAY_DOCS_OUT: stale })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/stale/)
  })

  it('write then check against that path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperpay-docs-'))
    dirs.push(dir)
    const out = join(dir, 'reference.md')
    expect(run(['write'], { HYPERPAY_DOCS_OUT: out }).status).toBe(0)
    const result = run(['check'], { HYPERPAY_DOCS_OUT: out })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
