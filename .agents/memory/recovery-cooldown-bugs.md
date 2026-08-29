---
name: Recovery & cooldown root cause bugs
description: Two bugs that prevented recovery stakes from increasing and cooldown from triggering, and the fix applied.
---

## Bug 1 — Recovery stake neutralized by risk manager

**Rule:** When `ctx.inRecovery` is true, skip the consecutive-loss stake reduction in `risk-manager.ts`.

**Why:** The risk manager reduces `recommendedStake` by 0.5× when `consecutiveLosses === consecutiveLossLimit - 1`. Recovery then multiplies by 1.2×. Net effect: `base × 0.5 × 1.2 = base × 0.6` — stake actually goes DOWN. With `consecutiveLossLimit = 2` and 1 loss already, every recovery trade used 60% of base stake instead of 120%.

**How to apply:** The `inRecovery` guard is in `risk-manager.ts` lines 78–81. Keep it gated behind `if (!ctx.inRecovery)`. Do not remove or move the guard.

---

## Bug 2 — Cooldown not triggering (stale Deriv journal)

**Rule:** For consecutive-loss counting, ALWAYS use the local DB. Use Deriv journal only for daily P&L.

**Why:** The Deriv profit_table (journalManager) can lag 15–60 s after `forceRefresh`. The autonomous loop runs 15 s after each trade. If the journal hasn't refreshed, `journalConsecutiveLosses` = 0, so the limit check `consecutiveLosses >= limit` never fires. The local DB is written the moment trades settle (before `scheduleNext`), so it is always current.

**How to apply:** In `ai.ts`, the consecutive-loss counting block uses `closedToday` (local DB, sorted DESC) with `status === "lost"`. The Deriv-journal block only computes `resolvedDailyProfit`.

---

## Related fix — manual trade failure status

**Rule:** When `executeLiveTrade` or `waitForContractResult` throws in `routes/trades.ts`, mark the record `status: "error"` (not `"lost"`), `profit: "0"`.

**Why:** Local DB is now the source of truth for consecutive-loss counting. A failed-execution record marked `"lost"` would pollute the streak counter and trigger false cooldowns on the next loop iteration.
