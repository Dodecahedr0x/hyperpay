# HyperPay — design

> **Superseded (2026-09-07).** This document describes the hosted Payments API
> client (`pay()`, stealth handles, `visibility`). HyperPay is now a payment-session
> program plus a client that builds `initUser` / `openSession` / `charge`. See
> [`2026-09-07-payment-sessions-design.md`](2026-09-07-payment-sessions-design.md).

**Date:** 2026-08-11
**Goal:** the easiest payment system on Solana, built on private ephemeral rollups and eSPL. Agent-ready, one-line integration.

## What already exists (verified 2026-08-11)

MagicBlock ships a hosted Private Payments API. These facts were confirmed by live calls, not from docs:

| Fact | Evidence |
|---|---|
| Base URL `https://payments.magicblock.app` | live |
| MCP endpoint `POST /mcp`, JSON-RPC, no auth | `tools/list` returned 5 tools |
| Tools: `spl.deposit`, `spl.withdraw`, `spl.transfer`, `spl.getBalance`, `spl.getPrivateBalance` | `tools/list` |
| `GET /v1/spl/balance?address&mint&cluster` works on mainnet **and** devnet | returned real balances |
| `POST /v1/spl/transfer` `visibility:"private"` routes to `sendTo:"ephemeral"`, `sendRpcEndpoint:"https://devnet.magicblock.app"` | live build |
| `POST /v1/spl/deposit` builds a 24-account delegation tx | live build |
| `/v1/health` does **not** exist (404 `Route not found`) | live |

The API returns **unsigned** transactions. Everything between "I want to pay Alice" and "Alice has the money" is still the integrator's problem.

## The actual gap

To make one payment today you must:

1. Know the mint's decimals and convert `10 USDC` → `10000000`.
2. Know whether funds live on `base` or `ephemeral`, and deposit (delegate) first if not.
3. Call the right builder endpoint with ~8 correct optional flags (`initIfMissing`, `initVaultIfMissing`, `initAtasIfMissing`, `idempotent`…).
4. Decode base64, detect `legacy` vs `v0`, sign with the right signers.
5. Route to `sendTo` — base RPC or the *ephemeral* RPC from `sendRpcEndpoint`. These are different clusters.
6. Confirm against the correct RPC, with the right blockhash/`lastValidBlockHeight`.
7. For private balances: `GET /v1/spl/challenge` → sign → `POST /v1/spl/login` → bearer token.

That is the entire surface HyperPay collapses:

```ts
await hp.pay('alice@magicblock.id', '10 USDC')
```

**Non-goal:** HyperPay does not reimplement rollups, delegation, or cryptography. It is a client-side ergonomics + safety layer over a working API. If MagicBlock ships a better primitive, HyperPay gets thinner, not thicker.

## Architecture

One core, four surfaces. Everything is the same `PaymentEngine`.

```
                     ┌───────────────────────────┐
  SDK    hp.pay() ──▶│                           │
  CLI    npx hyperpay pay ─▶  PaymentEngine      │──▶ payments.magicblock.app
  MCP    spl.transfer  ──▶│   resolve → policy   │        (builds unsigned tx)
  x402   auto-pay 402 ──▶ │   → sign → route     │
                     │    → confirm              │──▶ base RPC | ephemeral RPC
                     └───────────────────────────┘
```

### The `pay()` pipeline

```
resolve   parse "10 USDC" → { mint, baseUnits } using cached mint decimals
          resolve recipient: pubkey | stealth handle (alice@magicblock.id)
policy    per-tx cap, daily cap, recipient allowlist   ← throws BEFORE signing
fund      if ephemeral balance < amount → auto-deposit and wait for replication
build     POST /v1/spl/transfer  (visibility: private by default)
sign      decode base64 → legacy | v0 → sign with configured signer
route     sendTo === 'ephemeral' ? sendRpcEndpoint : base RPC
confirm   poll the SAME rpc the tx was sent to, bounded by lastValidBlockHeight
```

Two decisions carry the "easiest" claim:

- **Private by default.** `visibility` defaults to private, matching the API default. Public is opt-in (`{ visibility: 'public' }`). Privacy you have to ask for is privacy nobody uses.
- **One call, one transaction.** A private transfer with the default `base → base` balances builds as a *single* transaction that the API bundles itself.

### Corrections found by building it

The plan above was wrong in three places. Recording them, because each one is a trap the next
person will hit:

1. **Auto-deposit was designed, then deleted.** The plan assumed `pay()` had to orchestrate
   `deposit → transfer`. It does not: a private `base → base` transfer builds as one transaction
   (3 instructions, v0) that handles delegation internally. An entire subsystem turned out to be
   unnecessary. `deposit()`/`withdraw()` remain for explicitly managing rollup balances.

2. **`initVaultIfMissing` must not be set on transfers.** Setting all three `init*` flags
   produces a 1426-byte transaction against a 1232-byte limit. Vault setup belongs to
   `initializeMint()` / `deposit()`. Transfers set only `initIfMissing` + `initAtasIfMissing`.

3. **`initAtasIfMissing` creates the *sender's* token account, not the recipient's.** So a
   *public* transfer to a wallet that has never held the token fails with `InvalidAccountData`.
   HyperPay prepends an idempotent `CreateAssociatedTokenAccount` for the recipient
   (`src/ata.ts`). Private transfers are unaffected — the rollup creates the destination itself.

Two smaller API constraints, both undocumented in the pages we read: `clientRefId` must be a
**non-negative integer string** (not free text), and `minDelayMs`/`maxDelayMs` must be **strings**
(not numbers). Both are enforced by the API's validator and produce a `VALIDATION_ERROR`.

Finally: private transfers settle through a **queue**, so a transfer can land seconds after
`pay()` returns. A test measuring a balance delta against a reused recipient is racy for this
reason.

### Policy engine (the agent-safety layer)

Agents get a **session keypair**, never the main wallet. Caps are enforced client-side before signing:

```
HYPERPAY_KEY          session keypair (base58 or path)
HYPERPAY_MAX_PER_TX   25 USDC
HYPERPAY_DAILY_CAP    200 USDC
HYPERPAY_ALLOW        alice@magicblock.id,*.vendor.id
```

Client-side caps are **not** a security boundary against a compromised host — anything holding the key can sign. They are a blast-radius limiter against the realistic failure mode: a prompt-injected agent that tries to pay an attacker. The real boundary is that the session key only ever holds what you deposited into it. The README must say this plainly rather than implying caps are enforcement.

Daily spend is journaled to `~/.hyperpay/spend.json` so caps survive process restarts.

### x402 — why this is the agent unlock

An agent hitting a paid API gets `HTTP 402` with a quote, pays, and retries — no human, no API key, no signup:

```
agent ──GET /data──▶ server
      ◀──402 { accepts: [{ to, amount, mint, refId }] }──
      ── hp.pay(...) ──▶ ephemeral rollup   (~50ms, private)
      ──GET /data + X-Payment: <sig>──▶ server (verifies refId) ──▶ 200
```

`clientRefId` is the join key: the server mints it in the 402, the agent echoes it, the server verifies the settled transfer carries it. Ephemeral-rollup latency is what makes per-request payments viable — a base-layer confirmation per API call would not be.

## Package layout

Single npm package, subpath exports. A monorepo would be more machinery than this earns.

```
hyperpay/
  src/
    amounts.ts   "10 USDC" ⇄ base units, decimal cache
    policy.ts    caps, allowlist, spend journal
    api.ts       typed client for payments.magicblock.app
    signer.ts    keypair from env/file + external-signer interface
    engine.ts    resolve→policy→fund→build→sign→route→confirm
    client.ts    HyperPay class (pay, balance, deposit, withdraw, charge)
    cli.ts       npx hyperpay …
    mcp.ts       stdio MCP server (policy-wrapped)
    x402/        server middleware + auto-paying fetch
  crates/hyperpay/   Rust: pay() / balance()
  examples/
```

Published as **`@magicblock-labs/hyperpay`**. Exports: the package root, `/x402`, and `/mcp`.

The unscoped `hyperpay` on npm is a squatted `0.0.0` placeholder, so the scope also sidesteps a
name dispute. Two consequences: scoped packages publish as `restricted` unless
`publishConfig.access` is `public`, and `npx hyperpay` would resolve to the *squatted* package —
`npx` invocations must carry the scope. The CLI binary itself stays `hyperpay`.

## Testing

- **Pure units** (vitest, no network): amount parsing, policy caps, allowlist globs, spend journal rollover.
- **Live devnet integration**: build-only assertions against the real API — private transfers must route to `ephemeral`.
- **True end-to-end**: own devnet SPL mint, funded keypairs, `deposit → private transfer → balance delta`. This is the only test that proves the thing works. Command output is the evidence; nothing is claimed working without it.

Mocked-only tests are excluded deliberately — they would pass against an API that had changed shape.

## Risks

| Risk | Mitigation |
|---|---|
| Hosted API is a single point of failure and trust | `cluster` accepts a custom RPC; API base URL is configurable. Document the dependency honestly. |
| Auto-deposit surprises users by moving funds | On by default for `pay()`, logged, disableable. CLI prints the deposit before doing it. |
| Privacy is oversold | Docs repeat MagicBlock's own caveat: reduces **linkability**, not observability. Amounts/timing may leak at network level. |
| Private transfer fees (0.1% + 0.2 USDC relay if gasless) | `pay()` surfaces the `fees` object from the build response rather than hiding it. |
| SDK version drift (v0.14.3 legacy-vault vs v0.15.3 idempotent-shuttle) | HyperPay talks to the REST API, not the on-chain SDK, so it is insulated from this split. |
