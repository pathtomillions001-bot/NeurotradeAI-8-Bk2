---
name: AI Bot Edge v3 (specialist analysis improvements)
description: Exact Bayesian tests, run/Dirichlet conditioning, split-window Hurst, drift EMA, anti-pattern memory, and specialist-σ fusion that sharpen the five AI bots' analysis → timing → execution. Same pipeline, no new engine.
---

# AI Bot Edge v3

## What changed

### `specialist-analysis.ts` — exact probability machinery
- `logGamma` (Lanczos), `betacf` (Lentz), `regularizedIncompleteBeta` — exact
  Beta CDF, no normal approximation.
- `betaPosterior(hits, n, priorRate=0.1, priorCount=10)` → `{mean, sigma, alpha, beta}`.
- `posteriorRateProbability(hits, n, threshold, direction, ...)` → exact
  one-sided NULL-side p-value for FDR: hot = `I_thr(α,β)` (small when above
  threshold), cold = `1 − I_thr(α,β)`.
- `betaQuantile(q, α, β)` (bisection) — posterior-quantile upper bound (5.1).
- `runConditionedProbability(states, target)` — censored open-run hazard:
  p = hazard(k) when the open run is AGAINST the target, 1−hazard(k) when for it.
- `dirichletTailProbability(digits, tailSet, κ=10)` — exact
  Dirichlet-multinomial transition row conditioned on the LAST digit
  (needs rowTotal ≥ 4, else fair rate with σ=0.3).

### Per-bot
- **Parity**: blend now = chain1 + chain2 + EWMA + marginal + run-conditioned +
  Dirichlet last-digit transition (n ≥ 6). New metrics `runCondP/runCondK/
  dirTailP/dirTailN`.
- **Barrier (Over/Under)**: blend gains the Dirichlet tail probability
  conditioned on the actual last digit (n ≥ 6). New metrics `dirTailP/dirTailN`.
- **Match**: selection via exact posterior p-values + BH-FDR (q=0.25) and
  posterior-mean ranking; entry gate adds the GEOMETRIC waiting-time test —
  `(1−p̂)^gap ≤ 0.35` (gap overdue for the digit's OWN rate).
- **Differ**: `upper` bound now anchored on the 90th-percentile Beta posterior
  quantile (exact & asymmetric near 0.05–0.12) instead of `p̂ + 1.645σ`; read
  now exposes `sigma` so its win probability (1−p̂) can be fused.
- **Momentum (Rise/Fall)**: split-window Hurst — halves (len ≥ 64) must agree
  on regime or `noRegimeClaim` (random-walk treatment, no regime bonus/confidence).
  Signed-drift EMA (α=0.1) with σ_EMA = σ_resid·√(α/(2−α)); trend bonus full
  only when `|t_drift| ≥ 1.5` AND short/mid/long direction rates all agree
  (>0.52 or <0.48). New metrics `hurst1/hurst2/hurstAgreement/drift/driftT/
  driftSupported/dirRate10/dirRate30/dirRate80/dirAgreement`.

### `bot-scorer.ts` — fusion (v3)
- `specialistWinProbability(read)` converts the specialist read's pHat/σ into
  a win-probability estimate (differ → winP = 1−p̂, σ carries over).
- `botPrecisionScore` runs the specialist read BEFORE the fusion block and
  inverse-variance fuses `specWin` into the win probability that feeds
  `calibratedWinProbability`, EV, stake sizing, the EV floor and the paper sim.
- `antiPatternPenalty(recentTrades, contractType, barrier)` — decaying
  repeat-loss penalty (10 − 2·age, win clears it).

### `bot-engine.ts` — anti-pattern memory in normal mode (1.3)
- `scoreMarketForBot`/`analyzeMarketsForBot` accept `recentTrades`; normal-mode
  scoring subtracts `antiPatternPenalty` from the score so a bot refuses to
  immediately re-buy the exact (contract, barrier) setup it just lost on.
- `session.patternTrades` is now updated for EVERY trade (normal + recovery),
  still cleared on recovery exit.

## Tests
`specialist-analysis.test.ts` gained: Beta posterior closed forms, exact
p-values, run-conditioned hazard behaviour, Dirichlet planted-tail detection,
Beta quantile closed form, match geometric gate, momentum drift/agreement
metrics, and metric-presence checks for parity/barrier/differ. All API-server
suites pass (178/178 on a full run); repo typecheck green.

## Why it is not a new system
All changes reuse the existing `SpecialistRead` → bonus/gate → score → EV →
stake pipeline. Nothing new is built: the same read objects now carry stricter,
exact statistics and the win probability honestly reflects the specialist p̂.
