# Charge API probe

**Date:** 2026-09-04
**Host:** `https://payments.magicblock.app`
**Goal:** Record the live payments API surface before later tasks add `charge` and `session_balance` client methods.

This file records live HTTP results only. It does not add an ER program. It does not change the Rust or TypeScript client.

## Planned contract

Later tasks keep these names unless this probe finds different live names:

| Method | Path | Signer | Job |
| --- | --- | --- | --- |
| GET | `/v1/spl/session-balance?user&merchant&mint&cluster` | none | Remaining units on the ER session |
| POST | `/v1/spl/charge` | merchant | Build a merchant-signed debit from the session to the merchant |

JSON bodies use camelCase, same as the existing `TransferRequest`.

## Probe results

All calls use the hosted host on 2026-09-04.

| Probe | Method | Path | HTTP status | Body excerpt |
| --- | --- | --- | --- | --- |
| OpenAPI | GET | `/openapi.json` | 404 | `{"error":{"code":"NOT_FOUND","message":"Route not found"}}` |
| Charge | POST | `/v1/spl/charge` | 404 | `{"error":{"code":"NOT_FOUND","message":"Route not found"}}` |
| Session balance | GET | `/v1/spl/session-balance?user=1&merchant=1&mint=1&cluster=devnet` | 404 | `{"error":{"code":"NOT_FOUND","message":"Route not found"}}` |
| Balance (extra) | GET | `/v1/spl/balance?user=1&mint=1&cluster=devnet` | 422 | `{"error":{"code":"VALIDATION_ERROR","message":"Missing required fields: address",...}}` |
| Transfer empty (extra) | POST | `/v1/spl/transfer` body `{}` | 422 | `{"error":{"code":"VALIDATION_ERROR","message":"Missing required fields: from, to, mint, amount",...}}` |
| Private balance (extra) | GET | `/v1/spl/private-balance?address=1&mint=1&cluster=devnet` | 422 | `{"error":{"code":"VALIDATION_ERROR","message":"Request validation failed",...}}` |
| MCP tools (extra) | POST | `/mcp` `tools/list` | 200 | Tools: `spl.deposit`, `spl.withdraw`, `spl.transfer`, `spl.getBalance`, `spl.getPrivateBalance` |

The host returns `NOT_FOUND` for missing routes. The host returns `VALIDATION_ERROR` with HTTP 422 for routes that exist when the request fails validation.

## Does a charge or session route exist?

No. `POST /v1/spl/charge` does not exist. `GET /v1/spl/session-balance` does not exist.

The OpenAPI document does not exist. This probe cannot list other `/v1/spl/*` routes from a spec.

The MCP tool list has no `charge` tool. The MCP tool list has no `session-balance` tool. The MCP tools match the existing client: deposit, withdraw, transfer, getBalance, getPrivateBalance.

`GET /v1/spl/balance` exists. That route requires `address`, not `user`. `GET /v1/spl/private-balance` exists. `POST /v1/spl/transfer` exists. None of these routes is a merchant charge or an ER session-balance read.

## Live names for later tasks

The live host does not expose different names for charge or session-balance. Later tasks keep the planned paths:

- `GET /v1/spl/session-balance?user&merchant&mint&cluster`
- `POST /v1/spl/charge`

The live client already speaks camelCase JSON. Later tasks keep that field style.
