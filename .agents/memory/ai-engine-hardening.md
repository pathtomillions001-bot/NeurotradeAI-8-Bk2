---
name: AI engine hardening — 17 fixes
description: Structural fixes to gates, statistics, Markov models, and recovery logic applied in one session.
---

## Key decisions — durable rules going forward

**Gates that are NOW hard (were advisory)**
- `master-decision.ts` Gate 3 (timing): direction trades blocked at timingScore < 48; digit at < 45.
- `master-decision.ts` Gate 5 (drift): severe drift (recent WR < 40%, ≥20 trades) is a hard block, not a warning.
- `master-decision.ts` Gate 4 (consensus): old `Math.min(threshold, 50)` cap removed — user setting is now honoured exactly. Loss-streak boost raised from 3pts/loss (max 15) to 5pts/loss (max 30).
- `market-scanner.ts`: direction removed from enabledFamilies when tickCount < 20 (was 10).
- `pattern-discovery.ts`: relevance floor raised from 5 to 20 trades; similarity floor raised from 3 to 15 similar states.
- `ai.ts` tournament: quality floor of 60 added — cycles where the best winner scores below 60 are skipped.
- `ai.ts` recovery: digit recovery trades blocked when regime is trending_up or trending_down.

**Why:** advisory gates were a root cause of consecutive losses — the engine was executing despite poor timing, drifting strategies, and thin-data pattern signals.

**Markov improvements (digit-probability.ts)**
- `buildMarkov` now applies Laplace smoothing (α=1 per digit): `(count+1)/(total+10)`. Removes the old flat-10% fallback for unobserved transitions.
- 2nd-order Markov added: `transitions2[prev2][prev1][to]`, 10×10×10 states. `nextProb2` exposed on MarkovMatrix.
- `winProbForBarrier` now accepts `sampleSize` and uses a tiered ensemble: <50 samples → Bayes 95%/Markov1 5%/Markov2 0%; <100 → 80/15/5; ≥100 → 65/25/10.
- `buildBarrierOptions` signature changed to include `sampleSize` as second argument (before allowedBarriers). All callers updated.
- `analyzeMatchDiffers` uses the same tiered ensemble.
- Hot/cold thresholds in `analyzeDigits` now scale with n: n<50→±50%, n<100→±30%, n≥100→±15%.

**Why:** fixed-weight Markov at any sample size was producing unreliable scores from sparse transition matrices.

**EV calculator (ev-calculator.ts)**
- Digit EV scores now scaled by `sqrt(sampleSize/100)` toward neutral (50) for small samples.

**Why:** high edge computed from 30 digits is mostly sampling noise — was inflating scores and winning trades.

**Recovery engine (recovery-engine.ts)**
- Stake buffer raised from 1.02× to 1.05× to survive payout rounding on near-1.0 payouts.
- `ensureFreshDay()` now carries 50% of unrecovered debt into the new day (capped at 3× base stake, min 0.35). The new day starts at recoveryStep=1 so previous-day multipliers don't compound. Full wipe was silently losing real account losses incurred near midnight.
