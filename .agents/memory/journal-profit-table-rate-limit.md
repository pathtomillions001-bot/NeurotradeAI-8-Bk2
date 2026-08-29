---
name: journal-profit-table-rate-limit
description: Deriv profit_table WS rate limit — root causes and fixes applied to DerivJournalManager
---

# Deriv profit_table Rate Limit

## The rule
Deriv enforces a per-account rate limit on `profit_table` WS messages of roughly **1 request every 3-5 seconds**. The limit is per-account, not per-connection — it persists across reconnects and server restarts.

**Why:** With 5000+ trades, a full paginated fetch requires 10+ sequential `profit_table` messages. Without throttling, pages arrive back-to-back and hit the limit by page 3-4. The error code Deriv returns is `msg.error.code === "RateLimit"` with message `"You have reached the rate limit for profit_table."`.

## The cascade that caused trading to stop
1. Fast trades (SpeedAI every 1-2 s) each triggered `scheduleTransactionRefresh()` → `forceRefresh()`
2. No guard existed: `forceRefresh()` mid-pagination reset `fetchAccumulator` and started a new 10-page chain
3. Concurrent overlapping chains generated 10+ profit_table messages per second → RateLimit
4. Deriv dropped the WS → JournalManager reconnected immediately (3s base delay) → new OTP REST call → more rate limit
5. Journal cache stale → showing 24th date; FAB blocked (live trade execution also rate-limited)

## Fixes applied to DerivJournalManager (lib/deriv.ts)
- **`isFetchingPages` flag**: blocks new forceRefresh calls while a pagination chain is in progress
- **5-second inter-page delay**: `setTimeout(..., 5_000)` between consecutive page requests
- **5-second startup delay**: wait 5s after `ws.on("open")` before sending the first profit_table (lets Deriv's account-level limit cool down after a rate-limited session)
- **10s minimum interval guard** (`MIN_REFRESH_INTERVAL_MS = 10_000`): `forceRefresh()` skips if called within 10s of the last send
- **RateLimit error recovery**: on `msg.error.code === "RateLimit"`, reset `lastRefreshSentMs = Date.now()` and schedule a retry via `forceRefresh()` after 15s
- **Reconnect base delay increased**: 3_000 → 10_000ms to slow down OTP REST calls on reconnect
- **4s portfolio poll** in `waitForContractResult`: was 1s, cut to 4s to reduce WS message rate during live trade settlement

## How to apply
Any time `forceRefresh()` is called externally (ai.ts, trades.ts), it goes through all three guards automatically: `isFetchingPages`, `MIN_REFRESH_INTERVAL_MS`, and WS open check. Do not bypass by calling `ws.send()` directly.

Do NOT remove the `isFetchingPages` guard — it is the primary defence against concurrent pagination cascades.
