---
name: Cross-contract recovery logic
description: How the AI engine handles loss recovery — stake sizing and consecutive loss tracking
---

## Recovery Stake Policy (current — 1.14× geometric)

ALL contract families use a 1.14× geometric multiplier per consecutive recovery loss.
- `recoveryLossCount = 0` on first recovery trade → stake × 1.14^1 = +14%
- `recoveryLossCount = 1` on second consecutive recovery loss → stake × 1.14^2 = +30%
- Hard cap: 4× base stake (Deriv maxTradeStake also applies)

**Why:** The old code tried to recover `globalRecovery.unrecoveredAmount` (all accumulated losses
from ALL contract families) in ONE trade. This caused exponential stake growth:
a $14 base stake reached $298 after 2 recovery losses because prior OVER/UNDER losses
were included in the unrecoveredAmount. 1.14× geometric is controlled and predictable.

**For EVEN/ODD and RISE/FALL:** payout ~1.95× (95% profit). 1.14 × stake × 0.95 ≈ 1.08× —
covers the loss with a small buffer. No attempt to cover other families' losses.

**For OVER/UNDER:** barrier already switches to OVER 4/UNDER 5 in recovery (higher payout).
Same 1.14× geometric applies. The better barrier handles recovery naturally.

## Consecutive Loss Counter Alignment

There are two loss counters — they MUST stay in sync:
- `sessionLossCount` in ai.ts: resets to 0 on each win, resets on cooldown expiry. **This is displayed in the UI.**
- `daily.consecutiveLosses` in DB context: counted from DB scan of today's trades.

**Bug fixed:** The autonomous loop now passes `sessionLossCount` (not the DB-derived count)
to `buildDailyStats()`. This makes the risk-manager and recovery-intelligence agents see the
SAME value the UI shows. Previously the DB count could be 5 (from pre-restart losses) while
the UI showed 2, causing premature hard-stops.

## Recovery-Intelligence Agent Thresholds

`recovery-intelligence.ts` now uses `ctx.settings.consecutiveLossLimit` (user-configured)
instead of hardcoded `3` for its cooldown trigger. Soft thresholds scale proportionally:
- Cooldown: `consecutiveLosses >= limit`
- Recovery mode: `consecutiveLosses >= ceil(limit × 0.6)`
- Conservative mode: `consecutiveLosses >= ceil(limit × 0.2)`

**Why:** With hardcoded 3, a user who set limit=5 would see the recovery-intelligence agent
enter "no-trade" cooldown at 3 consecutive losses — well before the intended trigger of 5.

## Global Recovery State

`globalRecovery` in ai.ts tracks:
- `isActive`: true after any loss; false after full recovery
- `unrecoveredAmount`: sum of all losses since recovery started (all families)
- `recoveryLossCount`: consecutive losses DURING recovery (increments on loss, resets on win)
- `activeFamilies` / `recoveredFamilies`: which contract families are in recovery

Recovery ends when `unrecoveredAmount <= 0` (profit from wins covered all losses).

## OVER/UNDER Barrier Switch

When `globalRecovery.isActive`:
- OVER/UNDER uses OVER 4 / UNDER 5 barriers (better payout, easier recovery)
- Normal mode: OVER 2 / UNDER 7

The barrier switch is applied in `digit-probability.ts` via `buildBarrierOptions(analysis, inRecovery)`.
