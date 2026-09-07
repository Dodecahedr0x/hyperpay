# npm workspace + crates/hyperpay
set dotenv-load := true

crate := "crates/hyperpay"

# List recipes
default:
    @just --list

# JS unit tests (no network)
test:
    npm test

# Rust unit tests
test-rs:
    cargo test --manifest-path {{crate}}/Cargo.toml

# Anchor program unit tests (reservation math)
test-program:
    cargo test -p hyperpay-program

# Build the Anchor program
build-program:
    cargo build -p hyperpay-program

# JS + Rust unit tests
test-all: test test-rs

# Dist-build smoke tests
test-dist:
    npm run test:dist

# MCP live tests (stdio)
test-live:
    npm run test:live

# Real payments on live devnet
test-e2e:
    npm run test:e2e

# rustfmt (write)
fmt:
    cargo fmt --manifest-path {{crate}}/Cargo.toml --all

# rustfmt --check
fmt-check:
    cargo fmt --manifest-path {{crate}}/Cargo.toml --all -- --check

# clippy, warnings as errors
clippy:
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
    npm publish --access public --dry-run \
      -w @magicblock-labs/hyperpay-types \
      -w @magicblock-labs/hyperpay-solana \
      -w @magicblock-labs/hyperpay-core \
      -w @magicblock-labs/hyperpay-x402 \
      -w @magicblock-labs/hyperpay-react \
      -w @magicblock-labs/hyperpay

# Check versions, then dry-run crate and npm publish. Optional tag or "release: vX.Y.Z" title.
publish-dry tag="":
    just version-check {{quote(tag)}}
    just publish-dry-crate
    just publish-dry-npm

# Local gate: typecheck, unit tests, fmt, clippy
check: typecheck test-all lint
