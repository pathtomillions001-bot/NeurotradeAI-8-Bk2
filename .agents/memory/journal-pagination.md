---
name: Deriv journal pagination
description: JournalManager paginates profit_table — Deriv max 500/request, offset loop gets all trades
---

# Deriv journal pagination

## Rule
`DerivJournalManager` paginates `profit_table` using offset: each 500-record response triggers another fetch at `offset = accumulator.length` until a batch < 500 arrives, then commits all to cache.

**Why:** Deriv hard-limits `profit_table` to 500 records per request (limit > 500 → InputValidationFailed). Users with 500+ trades had analytics stop recording — the journal only ever saw the first page. Pagination fetches all pages before caching.

**How to apply:** `fetchAccumulator` accumulates batches. The message handler checks `batch.length >= JOURNAL_FETCH_LIMIT` to decide whether to fetch the next offset. On error mid-pagination, commits whatever was accumulated (partial is better than nothing). `clearCredentials()` and any fresh-fetch trigger must reset `fetchAccumulator = []`.

**Verified:** User had 3500+ trades; pagination successfully fetched 500→1000→1500→2000→2500→3000→3500+ in one startup cycle.
