---
name: Deriv app ID vs API token
description: Deriv app IDs are numeric; alphanumeric strings are API tokens and must not be used as app_id in the WebSocket URL.
---

## Rule
`DERIV_APP_ID` must be a numeric string (e.g. `36544`). Alphanumeric values (e.g. `33TQEuMW21nTbCZ7Hfb0q`) are Deriv API tokens — they belong in the OAuth/authorize flow, not in the WebSocket URL.

**Why:** Using a token as `app_id` in `wss://ws.derivws.com/websockets/v3?app_id=<value>` returns HTTP 401 immediately. Tested directly.

**How to apply:**
- The numeric guard in `artifacts/api-server/src/lib/deriv.ts` (`/^\d+$/.test(rawAppId)`) must stay.
- Users find their numeric app ID at **app.deriv.com/apps** (the Applications page), not the API Token page.
- If the user provides a non-numeric value, explain the distinction and ask for the numeric ID.
