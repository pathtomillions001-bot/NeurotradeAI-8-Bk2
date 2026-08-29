---
name: Deriv API migration — URL + app_id + symbol discovery
description: Documents the Deriv WebSocket URL change, deprecated app_id=1089, active_symbols discovery pattern, and the clean TickManager rewrite.
---

## Rule
Always use `wss://ws.derivws.com/websockets/v3?app_id={id}` — NOT the old `binaryws.com` domain.

**Why:** Deriv migrated their WebSocket endpoint from `binaryws.com` to `derivws.com` in October 2023. The old domain still accepts connections but rejects all synthetic index symbol subscriptions with `InvalidSymbol`.

## app_id=1089 is deprecated
app_id=1089 (old binary.com tester) returns 0 active symbols and all tick subscriptions fail with `InvalidSymbol` on the new endpoint. Users must register their own app at https://app.deriv.com/account/api-token and set the `DERIV_APP_ID` environment variable.

## Symbol discovery pattern
On connect, send `{ active_symbols: "brief" }` (no product_type filter — "basic" is no longer a valid enum value in the new API). Filter `DERIV_MARKETS` to only subscribe to confirmed symbols. If active_symbols returns 0, log a clear warning and attempt subscription anyway (individual symbols will self-report as invalid).

## InvalidSymbol handling
Mark symbols permanently invalid (`invalidSymbols.add(sym)`) on first `InvalidSymbol` response and never retry them. The old code retried every 5s forever creating a log storm. New code: one WARN then silence.

**How to apply:** Any time DERIV_APP_ID changes or symbols are added, the `confirmedSymbols` set resets on reconnect so discovery runs fresh.
