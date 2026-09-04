import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const script = join(repo, 'scripts/version.mjs')

function run(args: string[], cwd = repo) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HYPERPAY_ROOT: cwd },
  })
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hyperpay-version-'))
  mkdirSync(join(dir, 'packages/core'), { recursive: true })
  mkdirSync(join(dir, 'crates/hyperpay'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ version: '1.2.3' }, null, 2)}\n`)
  writeFileSync(
    join(dir, 'packages/core/package.json'),
    `${JSON.stringify({ name: '@magicblock-labs/hyperpay-core', version: '0.0.1' }, null, 2)}\n`,
  )
  writeFileSync(
    join(dir, 'crates/hyperpay/Cargo.toml'),
    `[package]\nname = "hyperpay"\nversion = "0.0.1"\nedition = "2021"\n`,
  )
  writeFileSync(
    join(dir, 'crates/hyperpay/Cargo.lock'),
    `[[package]]\nname = "hyperpay"\nversion = "0.0.1"\n`,
  )
  writeFileSync(
    join(dir, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'hyperpay-monorepo',
        version: '0.0.1',
        lockfileVersion: 3,
        packages: {
          'packages/core': { name: '@magicblock-labs/hyperpay-core', version: '0.0.1' },
        },
      },
      null,
      2,
    )}\n`,
  )
  return dir
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('scripts/version.mjs', () => {
  it('passes check when this repo is aligned to the root version', () => {
    const result = run(['check'])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('fails check when a workspace package or the crate has drifted', () => {
    const dir = fixture()
    dirs.push(dir)
    const result = run(['check'], dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/0\.0\.1/)
  })

  it('aligns every package and the crate to the root version', () => {
    const dir = fixture()
    dirs.push(dir)
    expect(run(['align'], dir).status).toBe(0)
    expect(run(['check'], dir).status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'packages/core/package.json'), 'utf8')).version).toBe('1.2.3')
    expect(readFileSync(join(dir, 'crates/hyperpay/Cargo.toml'), 'utf8')).toMatch(/version = "1\.2\.3"/)
    expect(readFileSync(join(dir, 'crates/hyperpay/Cargo.lock'), 'utf8')).toMatch(/version = "1\.2\.3"/)
    expect(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).version).toBe('1.2.3')
  })

  it('requires an optional release tag to match the root version', () => {
    const dir = fixture()
    dirs.push(dir)
    expect(run(['align'], dir).status).toBe(0)
    expect(run(['check', 'v1.2.3'], dir).status).toBe(0)
    const mismatch = run(['check', 'v9.9.9'], dir)
    expect(mismatch.status).not.toBe(0)
    expect(mismatch.stderr).toMatch(/1\.2\.3/)
  })
})
