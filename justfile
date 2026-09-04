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
# Release tags like v0.1.0 match versions like 0.1.0.
version-check tag="":
    node scripts/version.mjs check {{quote(tag)}}

# Local gate: typecheck, unit tests, fmt, clippy
check: typecheck test-all lint
