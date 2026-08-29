---
name: Continuous trading gate settings
description: Why the autonomous engine was freezing after 2 trades and how the gates were fixed
---

## Root cause
Default settings + gate logic caused ALL markets to return shouldTrade=false after a few trades:

1. `preferredContractTypes` defaulted to `"CALL,PUT,RISE,FALL"` only — no digit types. Direction EV on synthetic random indices ≈ -4.5% (50/50 win rate, 1.91x payout). Old `MIN_POSITIVE_EV = -0.005` meant EV of -4.5% was not "near-breakeven" → `bestEVResult = null` → Gate 2 blocked with "No EV calculation available".

2. Even with positive EV, timing gate (threshold 48/55) and consensus gate (55) blocked most subsequent trades.

3. Drifting gate was a hard stop after 10+ trades with slight drift.

## Fixes applied

### ev-calculator.ts
- `MIN_POSITIVE_EV = -0.05` (from -0.005) — direction trades at ~50% probability are now "near-breakeven" and returned as candidates
- `evForDigitProducts` now includes ALL barriers (not just positive EV ones) sorted by EV
- `bestEVResult` fallback chain: `strictPositiveEV[0] ?? nearBreakevenAny[0] ?? anySorted[0] ?? null` — never returns null when there are candidates

### master-decision.ts
- **Gate 2 (EV)**: Only blocks when EV < -0.06 (genuinely terrible) OR no EV data. Near-breakeven trades always pass.
- **Gate 3 (Timing)**: Advisory only — only hard-blocks on extreme z-score outlier tick (prevents chasing price spikes). `isGoodTiming` score contributes to consensus but doesn't hard-block.
- **Gate 4 (Consensus)**: `Math.min(settings.minConfidenceThreshold, 50)` — caps at 50 max.
- **Gate 5 (Drifting)**: Removed as hard gate; now advisory warning only.

### execution-timing.ts
- Direction threshold: 38 (from 48)
- Digit threshold: 45 (from 55)

### Settings defaults (schema + DB row updated)
- `preferredContractTypes`: `"CALL,PUT,DIGITOVER,DIGITUNDER,DIGITEVEN,DIGITODD"` — all families enabled
- `requirePositiveEv`: `false` (now advisory only)
- `minConfidenceThreshold`: `50` (from 55)

## Hard stops (preserved, intentional)
- Daily loss limit reached → stop engine
- Daily profit target reached → stop engine
- Session consecutive loss limit reached → cooldown then resume

**Why:** User expectation is continuous trading; only hard stops are risk limits. The engine should always find the best available opportunity and trade it, not freeze because EV is slightly negative.
