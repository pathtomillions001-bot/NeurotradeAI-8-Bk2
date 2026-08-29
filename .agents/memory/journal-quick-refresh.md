---
name: Journal Quick Refresh
description: forceQuickRefresh() for near-live journal updates — design, rate limits, and merge strategy.
---

## Rule
After a Deriv `sell` transaction event, `forceQuickRefresh()` fires immediately (no debounce) to fetch `limit: 10` trades and merge them into the existing cache within ~1-2 seconds. A full `forceRefresh()` (paginated) is still scheduled 5s later for accuracy.

## Where it lives
- `artifacts/api-server/src/lib/deriv.ts` — `DerivJournalManager.forceQuickRefresh()` method
- Frontend: `artifacts/trading-platform/src/pages/trades.tsx` — 3s polling, 50ms debounce on `journal_refreshed` SSE

## Design decisions

**Why passthrough:{quick:true}?**
Deriv echoes back the `passthrough` field in the `profit_table` response. This is the only way to distinguish a quick (limit:10) response from a full paginated response without adding server-side state tracking. The message handler checks `msg.passthrough?.quick === true` to route to merge vs replace logic.

**Merge strategy:**
Quick refresh response: prepend the 10 fresh trades to the existing cache, deduplicating by `transaction_id`. The full cache is NOT replaced — pagination history is preserved.

Full refresh response: full replace as before (existing `fetchAccumulator` / `isFetchingPages` flow unchanged).

**Rate limits:**
- Quick refresh: 3s minimum interval (`MIN_QUICK_REFRESH_MS = 3_000`)
- Full refresh: 10s minimum interval (`MIN_REFRESH_INTERVAL_MS = 10_000`) — unchanged
- Quick refresh does NOT check or set `isFetchingPages` — it runs independently of pagination

**Transaction handler change:**
Old: 300ms debounce → `forceRefresh()` (full, paginated)
New: immediate `forceQuickRefresh()` + 5s debounced `forceRefresh()` (full, for accuracy)

**Frontend:**
- `refetchInterval: 3000` (was 5000) — matches quick refresh rate
- `staleTime: 2000` (was 3000)
- `journal_refreshed` SSE: 50ms debounce (was shared 400ms with trade_completed)
- `trade_completed` SSE: unchanged (scheduleInvalidate with the shared debounce)

**Why:** The old path had a 10s rate limit on forceRefresh which meant a sell event could lag up to 10s before the journal showed the settled trade, plus pagination for 3500+ trades added another 35s. Quick refresh bypasses both.
