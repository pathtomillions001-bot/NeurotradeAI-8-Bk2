---
name: Recovery state single source of truth
description: recordOutcome() (in-memory, synchronous, DB-persisted) is the only writer of recovery state — never re-derive it from the Deriv journal cache.
---

## The bug

`ai.ts` had a `syncRecoveryStateFromDerivJournal()` step that ran at the start of every
autonomous loop iteration, re-deriving recovery state from `journalManager.getCached()`
(a Deriv profit_table cache refreshed only every ~60s). This created a race: after a
recovery-clearing win, `recoveryEngine.recordOutcome()` resets state to "Normal" instantly
in-memory, but the next loop iteration's journal-based resync could still see the stale
(pre-win) cached journal and flip recovery state back on — so the dashboard Recovery card
would revert to showing an unrecovered amount even though recovery had actually cleared.

## The fix

Removed the journal-resync mechanism entirely from `ai.ts` (`normaliseDerivEntry`,
`normaliseDbTrade`, `applyJournalSync`, `syncRecoveryStateFromDerivJournal`, and its call
site in the loop). `recoveryEngine.recordOutcome()` — called synchronously on every trade
settlement in both `trades.ts` (manual) and `ai.ts` (autonomous), persisted to DB via
`recoveryStateJson`, reloaded on startup via `loadRecoveryStateFromDb()` — is now the sole
writer of recovery state.

**Why:** Any code path that re-derives recovery state from an async/cached secondary source
(Deriv journal, DB scan, etc.) can race against the synchronous in-memory update and
resurrect stale state. The journal/DB should only ever be used for display (P&L, trade
history) — never as an alternate writer of live engine state that already has a
synchronous authoritative source.

**How to apply:** If recovery (or any other live engine state) ever looks like it "reverts"
or "flickers" after being resolved, check for a competing resync-from-cache path before
assuming the primary update logic is wrong.
