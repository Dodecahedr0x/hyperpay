# npm workspace + Rust workspace (SDK + program)
set dotenv-load := true

crate := "crates/hyperpay"

# List recipes
default:
    @just --list

# JS unit tests (no network)
test:
    npm test

# Rust SDK unit tests
test-rs:
    cargo test -p hyperpay

# Anchor program unit tests (reservation math)
test-program:
    cargo test -p hyperpay-program

# Build the Anchor program
build-program:
    cargo build -p hyperpay-program

# Build the SBF .so that LiteSVM integration tests load
build-sbf:
    cargo-build-sbf --manifest-path programs/hyperpay/Cargo.toml

# JS + Rust unit tests (SDK + program)
test-all: test test-rs test-program

# Dist-build smoke tests
test-dist:
    npm run test:dist

# MCP live tests (stdio)
test-live:
    npm run test:live

# Real payments on live devnet
test-e2e:
    npm run test:e2e

# Local MagicBlock stack (spins up mb-stack, deploys hyperpay, hits TS + Rust SDKs)
test-e2e-local:
    npm run test:e2e:local

# rustfmt (write)
fmt:
    cargo fmt --all

# rustfmt --check
fmt-check:
    cargo fmt --all -- --check

# clippy, warnings as errors. SDK keeps its existing invocation (pre-existing
# dead_code / await_holding_lock). Program is denied separately.
clippy:
    cargo clippy -p hyperpay-program --all-targets -- -D warnings
    cargo clippy --manifest-path {{crate}}/Cargo.toml --all-targets --all-features -- -D warnings

# rustfmt --check + clippy
lint: fmt-check clippy

# Typecheck the JS workspace
typecheck:
    npm run typecheck

# Build all JS packages
build:
    npm run build

# Build the Rust crate
build-rs:
    cargo build --manifest-path {{crate}}/Cargo.toml

# Install JS deps
install:
    npm install

# Copy the root package.json version onto workspace packages, the crate, and lockfiles
version-align:
    node scripts/version.mjs align

# Fail if any package/crate version drifted from the root.
# Release tags like v0.1.0 and PR titles like "release: v0.1.0" match version 0.1.0.
version-check tag="":
    node scripts/version.mjs check {{quote(tag)}}

# Dry-run crates.io publish (no upload)
publish-dry-crate:
    cargo publish --dry-run --locked --manifest-path {{crate}}/Cargo.toml

# Dry-run npm workspace publish (no upload). Public packages only — the
# example workspace has no version and crashes `npm publish -ws`.
publish-dry-npm:
    npm run build
    npm run publish:packages -- --dry-run

# Publish public npm workspaces (used by .github/workflows/npm-release.yml)
publish-npm:
    npm run build
    npm run publish:packages

# Check versions, then dry-run crate and npm publish. Optional tag or "release: vX.Y.Z" title.
publish-dry tag="":
    just version-check {{quote(tag)}}
    just publish-dry-crate
    just publish-dry-npm

# Local gate: typecheck, unit tests, fmt, clippy, docs freshness
check: typecheck test-all lint docs-check

# Regenerate docs/reference.md from program / SDK / CLI / MCP source
docs:
    node scripts/docs.mjs write

# Fail if docs/reference.md is stale or hand-written docs drifted
docs-check:
    node scripts/docs.mjs check
