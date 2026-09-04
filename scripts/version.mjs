#!/usr/bin/env node
/**
 * Keep workspace package.json files, the Rust crate, and lockfiles on the
 * version in the repo-root package.json.
 *
 *   node scripts/version.mjs check [tag]
 *   node scripts/version.mjs align
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = process.env.HYPERPAY_ROOT ?? join(scriptDir, '..')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function rootVersion() {
  const version = readJson(join(root, 'package.json')).version
  if (typeof version !== 'string' || !version) {
    throw new Error('Root package.json has no version')
  }
  return version
}

function workspacePackageJsons() {
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) return []
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, 'package.json'))
    .filter((path) => existsSync(path) && typeof readJson(path).version === 'string')
}

function cargoToml() {
  return join(root, 'crates/hyperpay/Cargo.toml')
}

function cargoLock() {
  return join(root, 'crates/hyperpay/Cargo.lock')
}

function packageLock() {
  return join(root, 'package-lock.json')
}

function cargoPackageVersion(text) {
  const match = /^version = "([^"]+)"/m.exec(text)
  return match?.[1]
}

function setCargoPackageVersion(text, version) {
  return text.replace(/^version = "[^"]+"/m, `version = "${version}"`)
}

function cargoLockVersion(text) {
  const match = /name = "hyperpay"\nversion = "([^"]+)"/.exec(text)
  return match?.[1]
}

function setCargoLockVersion(text, version) {
  return text.replace(/(name = "hyperpay"\n)version = "[^"]+"/, `$1version = "${version}"`)
}

function sites() {
  const found = []
  for (const path of workspacePackageJsons()) {
    found.push({ path, version: readJson(path).version })
  }
  if (existsSync(cargoToml())) {
    found.push({ path: cargoToml(), version: cargoPackageVersion(readFileSync(cargoToml(), 'utf8')) })
  }
  if (existsSync(cargoLock())) {
    found.push({ path: cargoLock(), version: cargoLockVersion(readFileSync(cargoLock(), 'utf8')) })
  }
  const lockPath = packageLock()
  if (existsSync(lockPath)) {
    const lock = readJson(lockPath)
    if (typeof lock.version === 'string') {
      found.push({ path: `${lockPath}#version`, version: lock.version })
    }
    for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
      if (key.startsWith('packages/') && typeof pkg.version === 'string') {
        found.push({ path: `${lockPath}#${key}`, version: pkg.version })
      }
    }
  }
  return found
}

function stripTag(tag) {
  return tag.replace(/^v/, '')
}

function check(tag) {
  const expected = rootVersion()
  const problems = []
  if (tag) {
    const stripped = stripTag(tag)
    if (stripped !== expected) {
      problems.push(`release tag '${tag}' does not match root version '${expected}'`)
    }
  }
  for (const site of sites()) {
    if (site.version !== expected) {
      problems.push(`${site.path} is '${site.version}', expected '${expected}'`)
    }
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
}

function setReactPeer(pkg, version) {
  const reactPeer = pkg.peerDependencies?.['@magicblock-labs/hyperpay-react']
  if (typeof reactPeer === 'string' && reactPeer.startsWith('>=') && reactPeer !== `>=${version}`) {
    pkg.peerDependencies['@magicblock-labs/hyperpay-react'] = `>=${version}`
    return true
  }
  return false
}

function align() {
  const version = rootVersion()
  for (const path of workspacePackageJsons()) {
    const pkg = readJson(path)
    let dirty = pkg.version !== version
    if (dirty) pkg.version = version
    if (setReactPeer(pkg, version)) dirty = true
    if (dirty) writeJson(path, pkg)
  }
  if (existsSync(cargoToml())) {
    const text = readFileSync(cargoToml(), 'utf8')
    const next = setCargoPackageVersion(text, version)
    if (next !== text) writeFileSync(cargoToml(), next)
  }
  if (existsSync(cargoLock())) {
    const text = readFileSync(cargoLock(), 'utf8')
    const next = setCargoLockVersion(text, version)
    if (next !== text) writeFileSync(cargoLock(), next)
  }
  const lockPath = packageLock()
  if (existsSync(lockPath)) {
    const lock = readJson(lockPath)
    let dirty = false
    if (lock.version !== version) {
      lock.version = version
      dirty = true
    }
    for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
      if (key.startsWith('packages/') && typeof pkg.version === 'string' && pkg.version !== version) {
        pkg.version = version
        dirty = true
      }
      if (setReactPeer(pkg, version)) dirty = true
    }
    if (dirty) writeJson(lockPath, lock)
  }
}

const [command, tag] = process.argv.slice(2)
if (command === 'check') {
  check(tag)
} else if (command === 'align') {
  align()
} else {
  console.error('usage: node scripts/version.mjs check [tag]\n       node scripts/version.mjs align')
  process.exit(2)
}
