---
name: Deriv new API migration
description: Complete migration from legacy WS API to new Deriv Developer Platform — URLs, auth, and trading flow changes.
---

# Deriv New API Migration

## The Core Problem
The legacy `wss://ws.derivws.com/websockets/v3?app_id=<NUMERIC_ID>` endpoint returns 401 for new alphanumeric App IDs. The new API is a completely different architecture.

## New Architecture

| Surface | URL | Auth |
|---|---|---|
| Public market data | `wss://api.derivws.com/trading/v1/options/ws/public` | None |
| Trading WS | OTP URL from POST `/trading/v1/options/accounts/{id}/otp` | Bearer + OTP |
| REST | `https://api.derivws.com` | Bearer token |
| OAuth | `https://auth.deriv.com/oauth2/auth` | PKCE |

## Critical Field Changes
- `active_symbols` response: field is `underlying_symbol` (not `symbol`)
- proposal/buy WS messages: `underlying_symbol` (not `symbol`)
- `ticks` subscription: still uses `ticks: "R_100"` (unchanged)
- OTP buy format: `{ buy: proposalId, price: askPrice }` (not `{ buy: 1, price, parameters: {...} }`)

## Auth Flow
1. Frontend generates PKCE (code_verifier + code_challenge)
2. GET `/api/auth/oauth/initiate` → stores verifier server-side by state, returns auth.deriv.com URL
3. User redirects to Deriv, returns with `?code=...&state=...`
4. POST `/api/auth/oauth/callback` → exchanges code for Bearer token → GET /accounts → store
5. `setDerivCredentials(bearerToken, accountId)` → journalManager + module cache updated

## DB Schema Changes (added 2026-07-24)
Table: `accounts`
- Added `bearer_token` (text, nullable) — OAuth Bearer access token
- Added `refresh_token` (text, nullable) — OAuth refresh token  
- Added `deriv_account_id` (text, nullable) — account_id from GET /accounts
- `token` column made nullable (was NOT NULL) — kept for legacy PAT fallback

## OTP URL Behavior
- One-time use for establishing the WebSocket connection
- The connection itself stays alive for multiple messages
- On every reconnect, must fetch a NEW OTP URL via REST
- JournalManager fetches fresh OTP URL on each `connect()` call

## No `authorize` WS Message
The new public and trading WS endpoints do NOT accept `authorize` messages. The public WS is anonymous; the trading WS authenticates via the OTP URL itself. Any code sending `{ authorize: token }` to these endpoints will fail or be ignored.

**Why:** Deriv redesigned their API to separate market data (public) from trading (authenticated via REST-issued OTP URLs). The old pattern of mixing auth into the WebSocket is deprecated.

## PAT Token Path
- PATs are only valid for bulk-purchase REST endpoint (`POST /trading/v1/options/contracts/bulk-purchase/{real,demo}`)
- PATs cannot be used as Bearer tokens for the OTP endpoint (unverified but assumed)
- Fallback: app tries PAT as Bearer token in `authorizeWithDeriv()` → if GET /accounts succeeds, stores as full credentials
- Without accountId, live trading is unavailable (market data still works via public WS)

## Files Changed
- `lib/db/src/schema/accounts.ts` — new columns
- `artifacts/api-server/src/lib/deriv.ts` — full migration
- `artifacts/api-server/src/routes/auth.ts` — OAuth endpoints added
- `artifacts/api-server/src/app.ts` — bootstrapDb detects new bearer_token column
- `artifacts/trading-platform/src/pages/connect.tsx` — PKCE OAuth flow
