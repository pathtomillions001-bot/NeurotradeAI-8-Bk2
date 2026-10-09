---
name: Recovery risk-adjusted ranking
description: How the autonomous 1-tick engine ranks recovery candidates, and why the loss-streak weight never touches a stake
---

## Where it lives
- `lib/autonomous-hedge/recovery-risk.ts` — `normalCdf`, `posteriorEdgeProbability`, `posteriorVariance`, `threeLossRunRisk`, `recoveryEscalation`, `recoveryRiskWeight`
- `lib/autonomous-hedge/hedge-analysis.ts` — `analyseHedgeCandidate` computes `recentAfterLoss`, the regime blend, `recoveryAfterLoss`, `R3L`, and the recovery score
- `lib/autonomous-hedge/constants.ts` — `HEDGE_LIMITS.recentAfterLossWindow` (40), `regimeWeightCap` (0.75), `recovery.riskWeightMax` (0.5), `recovery.escalationCap` (6)
- Design doc: `docs/recovery-trade-mathematical-design.md`

## Recovery score
`S_R = S_0 + 18w(P(p>p_BE|D) − 0.5) − 18w·R3L − 8√Var(p)`, normal trades keep `S_0`.
`R3L = (1 − q̃_L→W)·q_L→L²` with `q̃_L→W` the long-run after-loss win rate blended toward the recent 40-tick estimate by `min(0.75, 3·instability)`.

## Loss-streak weight
`e = max(streakLossCount, recoveryStep)`, `w = 1 + 0.5·min(e,6)/6` → `w ∈ [1, 1.5]`.
Uses the MAX because `streakLossCount` is zeroed by any win **and** by a cooldown auto-resume
(`stopEngine` → `seedState({...state, streakLossCount: 0})`), while `recoveryStep` only clears when
the debt is repaid. Without the max, a cooldown silently restarts the ladder at `w = 1` with the
same debt still outstanding.

## Rules that must not be broken
- `w` is applied to the two directional risk terms only; it never changes `eligible` and never
  touches `getDynamicRecoveryStake`. `recovery-staking-invariant.test.ts` pins the Instant/Split/
  manual stake numbers and asserts the stake is identical at escalation 0 and at the cap.
- `riskWeight` is 1 in NORMAL mode — the base score there is the pre-existing Nexus score.
- No new time-based entry gate. The engine still evaluates every tick; the tick-driven
  confirmation ladder in `hedge-state.ts` is unchanged.

## Observability
`scan_complete` carries `posteriorEdge`, `lossRunRisk`, `riskWeight`, `escalation`; the decision
reason renders `P(edge) NN% R3L 0.NN wN.NN`; the recoveryIntelligence agent reports the same.
