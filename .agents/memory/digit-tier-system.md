---
name: Digit barrier tier system
description: Corrected tier definitions and hard-block rules for OVER/UNDER digit barrier selection
---

## Tier Definitions (corrected per user specification)

**Tier 1 — Normal / safe compounding:**
- OVER 1, 2, 3 → 80%, 70%, 60% win probability
- UNDER 6, 7, 8 → 60%, 70%, 80% win probability

**Tier 2 — Recovery mode (after a loss):**
- OVER 4, 5, 6 → 50%, 40%, 30% win probability
- UNDER 3, 4, 5 → 30%, 40%, 50% win probability

**Hard-blocked (NEVER select):**
- OVER 7, OVER 8 → 20%/10% win — explicitly blocked via `HARD_BLOCKED_OVER = {7, 8}`
- UNDER 1, UNDER 2 → 10%/20% win — explicitly blocked via `HARD_BLOCKED_UNDER = {1, 2}`

**Tier 0 (not hard-blocked):**
- OVER 0 (90% win, 1.05x payout) and UNDER 9 (90% win, 1.05x payout) — ultra-safe but very low payout; not hard-blocked, just never boosted so tier-1/2 always score higher.

## Hard-block mechanism
- In `scoreAllBarriers()`: hard-blocked options get `adjustedEvScore = -Infinity`
- In `analyzeDigitEdge()`: `topOptions` filters out hard-blocked barriers so EV calculator never receives them
- Filter uses `isHardBlockedOption()` helper checking `HARD_BLOCKED_OVER`/`HARD_BLOCKED_UNDER` sets explicitly by barrier value (not by tier)

## Recovery tracking
- `updateDigitRecovery(symbol, contractType, won, profit, stake)` tracks `unrecoveredLoss` per symbol
- `isInDigitRecovery(symbol)` returns true when unrecoveredLoss > 0
- Coordinator passes `inDigitRecovery` to `runDigitAgent()` which selects preferred tier accordingly

**Why:** Old code used `tier === 0` to block, which also blocked OVER 0 (ultra-safe) and UNDER 9 (ultra-safe). Now we block by exact barrier value so OVER 0/UNDER 9 remain as fallbacks.
