---
name: AI engine quality improvements
description: Payout-calibrated recovery staking, expanded digit tick selection, structural loss pattern detection — all shipped together.
---

## Payout-calibrated split cap (`recovery-engine.ts`)

**Rule:** `computeDynamicStake` now auto-derives the minimum sufficient split cap from the live barrier payout before applying the user's `recoveryMultiplier`.

```
payoutImpliedMinMult = (1 / netPayout) × 1.05
baseEffectiveMult    = max(recoveryMultiplier, payoutImpliedMinMult)
progressiveMult      = max(1.1, baseEffectiveMult + stepOffset)
splitCap             = baseStake × progressiveMult
```

**Why:** A user-configured `recoveryMultiplier=1.62` is only correct for barriers with ~1.62× payout. OVER 3 (payout 1.37×, netPayout 0.37) needs a 2.84× cap to recover one base loss — at 1.62× the engine only wins back 0.60× base and leaves permanent partial debt. OVER 5 (payout 1.96×) naturally needs only 1.09× so `minRecovery` governs and stake is minimised.

**How to apply:** Fires automatically in split mode and low-payout instant mode. The user's `recoveryMultiplier` setting still acts as a floor for progressive steps.

## Digit tick-duration expansion (`duration-optimizer.ts`)

**Rule:** `DIGIT_CANDIDATE_DURATIONS` expanded from `[3, 5]` to `[1, 3, 5]`. EVEN/ODD stays at `[5]` (Deriv minimum). MATCH/DIFF in `ai.ts` changed from hardcoded `5` to `Math.max(1, Math.min(5, rawDuration))`.

Scoring added for 1-tick digits:
- vol > 0.010 (extreme): +16 for 1t, −10 for 5t
- vol > 0.006 (high): +10 for 1t, +8 for 3t
- vol < 0.002 (low): −8 for 1t, +8 for 5t
- volatile/choppy regime: +6 for 1t, −5 for 5t

**Why:** In high/extreme volatility the digit distribution can shift meaningfully across 3–5 ticks. 1-tick contracts settle on the very next tick, minimising time-exposure. This is especially valuable during recovery where you want the tightest possible entry.

## Structural loss pattern detection (`recovery-intelligence.ts`, `confidence-fusion.ts`, `ai.ts`)

**Rule:** A session-scoped `lossPatternStore` (Map keyed by symbol) records `{contractType, regime, timestamp}` for each loss. `getStructuralLossPattern(symbol)` returns the blocked combo when ≥2 of the last 4 losses within 30 minutes share the same contractType+regime pair. `confidence-fusion.ts` adds a hard blocker when the current candidate matches the pattern AND `sessionLosses >= 2`. A win on any contract type on that symbol calls `clearLossPattern` to reset.

**Why:** The old system raised the bar globally after consecutive losses ("be more cautious everywhere") but didn't prevent re-entering the exact same setup that just lost twice. The pattern detector creates targeted suppression — only the losing combo is blocked; other contract types/regimes remain tradeable.

**How to apply:** `recordLossForPattern(symbol, contractType, regime)` called in `ai.ts` after each paper and live loss. `clearLossPattern(symbol)` called after each win. Pattern expires automatically after 30 minutes even without a win.
