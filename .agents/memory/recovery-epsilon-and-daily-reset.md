---
name: Recovery epsilon clearing + dashboard/journal daily reset
description: Why the recovery card could get stuck just above $0 forever, and how Dashboard/Journal vs Analytics scope their stats differently.
---

## Recovery card stuck near $0

`recordOutcome()` in recovery-engine.ts used an exact float comparison
(`recovered >= state.unrecoveredAmount`) to decide when a win fully clears the debt.
Across many partial recovery steps, float drift can leave a few-tenths-of-a-cent
residue that displays as "$0.00" (rounded for the UI) but is still > 0 internally,
so `inRecovery` never flips back to false — the card looks "stuck" even though the
user visibly recovered the full amount, regardless of whether the clearing trade was
manual or AI-engine-executed (both paths call the same `recordOutcome()`).

**Fix:** treat `unrecoveredAmount - recovered <= 0.005` (half a cent) as fully
recovered and reset to `freshState()`, instead of requiring an exact/greater-than
comparison.

**How to apply:** any time you see a financial counter that should hit exactly zero
but is compared with float equality/inequality across many incremental updates, use
a small epsilon rather than exact comparison.

## Dashboard/Journal vs Analytics stats scope

Dashboard and Journal headline stats (win rate, streak, total trades, today's
profit) are intentionally scoped to **today only** and reset at midnight — a fresh
slate each day, consistent with `recoveryEngine`'s own daily reset. Analytics keeps
full all-time history/detail for users who want it.

Implementation: `computeJournalStats()` in `trades.ts` returns both the all-time
shape (top-level fields, still used by `analytics.tsx`) and a `todayStats` nested
object (used by `dashboard.tsx` and `trades.tsx` header cards) computed via a shared
`computeStatsCore()` helper. The Journal's raw trade list itself is NOT filtered to
today — only the summary cards are — so full trade history remains visible/scrollable.
