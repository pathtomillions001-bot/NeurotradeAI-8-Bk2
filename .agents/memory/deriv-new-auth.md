---
name: Deriv new auth format
description: Deriv now uses alphanumeric app IDs and PAT tokens; numeric-only guard removed from deriv.ts
---

# Deriv New Authentication Format

## The Rule
Deriv migrated from numeric app IDs (e.g. `1089`) to alphanumeric app IDs (e.g. `33TQEuMW21nTbCZ7Hfb0q`). API tokens are now Personal Access Tokens (PAT) with the prefix `pat_`. The numeric-only validation guard (`/^\d+$/.test(rawAppId)`) has been removed from `deriv.ts`.

**Why:** Old numeric app IDs and old short API keys are deprecated and no longer work. The Deriv WebSocket API still uses the same endpoint and protocol — only the credential formats changed.

**How to apply:**
- `DERIV_APP_ID` env var must be set to the new alphanumeric app ID from app.deriv.com/apps — never validate as numeric
- Users connect with PAT tokens (format: `pat_xxxxxxxx…`) created at app.deriv.com/account/api-token
- The WS URL is still `wss://ws.derivws.com/websockets/v3?app_id=<alphanumeric-id>`
- The `authorize` WebSocket call is unchanged: `{ authorize: "<PAT_token>" }`
- OAuth tokens returned by Deriv's OAuth flow also work with `{ authorize: token }`
- If `DERIV_APP_ID` is unset, the server falls back to `app_id=1089` in the WS URL (which returns no symbols), triggering simulation mode — always warn clearly in logs
- `auth.ts` logs a warning if a submitted token looks too short to be a PAT (< 30 chars, no `pat_` prefix)
- `VITE_DERIV_APP_ID` must match `DERIV_APP_ID` — it's the same alphanumeric value exposed to the frontend for OAuth redirects
