# Recovery-trade mathematical design

## What the change is intended to solve

Ten consecutive recovery losses are not evidence that a single missing threshold is the problem. They can arise from ordinary variance, a negative or overstated edge, autocorrelated losses, payout miscalibration, or an exposure ladder that grows faster than the evidence supporting the trade. The engine therefore needs a better candidate-selection control while preserving the existing staking contract:

1. **Choose the least-bad recovery opportunity available now**, using uncertainty and loss clustering rather than point-estimate EV alone.

1. **Leave staking to the existing recovery engine**, so Instant and Split continue to behave exactly as configured.

The implementation keeps the tick-driven flow. It does not add a multi-minute confirmation wait or a new time-based hard gate.

## Mathematical model

### Bayesian win-rate uncertainty

For a candidate with `w` wins and `l` losses, use a Beta prior centered on the contract's baseline probability `p₀`:

$$
 p \sim \operatorname{Beta}(\alpha_0,\beta_0),\qquad
 \alpha_0=s p_0,\quad \beta_0=s(1-p_0)
$$

The posterior mean used by the existing ranker is equivalent to:

$$
 \bar p = \frac{w+s p_0}{w+l+s}
$$

The recovery score also estimates posterior uncertainty:

$$
 \operatorname{Var}(p) \approx \frac{\bar p(1-\bar p)}{w+l+s+1}
$$

The engine converts the distance from payout break-even into a posterior probability that the true edge is positive:

$$
 p_{BE}=\frac{1}{\text{payout}},\qquad
 P(p>p_{BE}\mid D)\approx
 \Phi\left(\frac{\bar p-p_{BE}}{\sqrt{\operatorname{Var}(p)}}\right)
$$

This is a normal approximation to the Beta tail used as a bounded, low-latency scoring feature. It is deliberately not treated as certainty: a 55% observed win rate with 20 samples is not ranked like a 55% win rate with 2,000 samples.

### Markov loss clustering

The existing engine already estimates first-order transitions. Recovery now also looks at the conditional win rate after a loss in both the full tape and a recent 40-tick window:

$$
 q_{L\to W}=\frac{LW+1}{LL+LW+2}
$$

The recent and long-run estimates are blended more heavily toward the recent estimate when the two tape halves are unstable. This is a soft regime adaptation, not a pause condition:

$$
 \omega=\min(0.75,\;3\cdot\text{instability}),\qquad
 \tilde q_{L\to W}=(1-\omega)\,q_{L\to W}+\omega\,q^{(40)}_{L\to W}
$$

To quantify the immediate risk of another loss cluster, the engine estimates the probability of three future losses after the current recovery state:

$$
 R_{3L}\approx (1-\tilde q_{L\to W})\,q_{L\to L}^{2},\qquad
 q_{L\to L}=\frac{LL+1}{LL+LW+2}
$$

This is not a claim that the sequence is exactly Markovian. It is a compact stress indicator: a candidate with a high chance of another loss immediately after a loss is less suitable for recovery, even when its unconditional EV is attractive.

Bayesian first-order Markov models are a standard way to represent binary outcomes whose next probability depends on the previous outcome, and can also allow transition probabilities to vary over time [1]. Bayesian online change-point detection provides the complementary rationale for weighting recent behaviour more strongly after a regime shift [2].

### Soft recovery score

For normal trades, the existing score remains the base score. For recovery trades, the implementation adds three continuous adjustments:

$$
 S_R=S_0
 +18\,w\,(P(p>p_{BE}\mid D)-0.5)
 -18\,w\,R_{3L}
 -8\sqrt{\operatorname{Var}(p)}
$$

The coefficients are ranking weights, not probabilities. They are intentionally small enough that the established EV, confidence interval, instability, and clustering terms remain influential. The point is to make two candidates with similar EV distinguishable by uncertainty and near-term loss-run risk.

### Loss-streak weight `w`

This document requires the engine to change "candidate ranking when uncertainty, clustering, or **a loss streak** rises while leaving exposure sizing unchanged". `w` is that response, and it is the mechanism aimed squarely at repeated recovery losses:

$$
 e=\max(\text{streakLossCount},\ \text{recoveryStep}),\qquad
 w=1+\kappa\,\frac{\min(e,E)}{E}
$$

with `κ = HEDGE_LIMITS.recovery.riskWeightMax = 0.5` and `E = HEDGE_LIMITS.recovery.escalationCap = 6`, so `w ∈ [1.0, 1.5]`.

Why the maximum of the two counters: `streakLossCount` is the live consecutive-loss run, and it is reset both by a win and by a cooldown auto-resume. `recoveryStep` only advances on a recovery loss and only clears when the loss debt is fully repaid, so it survives the cooldown. Taking the maximum stops a cooldown from silently restarting the ladder at `w = 1` while exactly the same debt is still outstanding.

Properties, all deliberate:

- **It re-orders, it does not block.** `w` scales the two directional risk terms, so a deep run widens the score gap between a well-evidenced candidate and a marginal one. It never changes `eligible`, so no new hard gate is introduced and the engine still evaluates every tick.
- **It sharpens in both directions.** A candidate whose posterior edge is genuinely positive is scored *higher* as the run deepens; a candidate the posterior doubts is scored lower. The engine keeps trading the best evidence it has instead of idling with debt exposed.
- **It is bounded.** `w` saturates at `1 + κ`, keeping the EV, confidence-interval, instability and clustering terms influential exactly as this document requires.
- **It never touches a stake.** See the staking invariant below.

### Staking invariant

The analysis change does **not** alter stake calculation. Once a recovery candidate is selected, `cycle.ts` continues to call the existing `getDynamicRecoveryStake` path with the configured payout, recovery method, multiplier, maximum recovery steps, and auto/manual mode. Therefore:

- **Instant** continues sizing the configured full-clearance recovery attempt.

- **Split** continues capping each attempt according to the existing normal-base-stake/debt-carry-forward behavior.

- Existing minimum-stake, balance, maximum-stake, payout, and settlement rules remain authoritative.

Fractional-Kelly and drawdown-sensitive exposure are useful future research directions, but they are intentionally not part of this implementation. The Kelly reference [3] is retained as design context only.

`src/lib/recovery-staking-invariant.test.ts` pins the exact Instant/Split/manual stake numbers and asserts that a recovery stake is identical at escalation 0 and at the cap, so a future edit to the analysis cannot leak into the money path.

## Why this is preferable to another hard gate

A hard rule such as “wait for three confirmations” can reduce some bad entries, but it can also leave the engine idle while the recovery debt remains exposed to time and regime changes. The new logic instead:

- continues evaluating each tick;

- ranks all eligible recovery candidates with a risk-adjusted score;

- adapts to recent after-loss behaviour;

- changes candidate ranking when uncertainty, clustering, or a loss streak rises while leaving exposure sizing unchanged;

- preserves the existing account-level hard stops and unresolved-exposure protections.

This cannot eliminate ten-loss runs. If the underlying contract is negative expectancy or the tape is effectively independent with a high loss probability, no recovery formula can manufacture a positive edge. It can, however, improve which eligible recovery candidate is selected without silently changing the user's configured staking mode.

What it does change in practice: with several eligible recovery candidates the engine now demonstrably prefers the one with more evidence and less loss clustering, and that preference strengthens as the run deepens. The existing account-level protections — daily loss limit, consecutive-loss cooldown, max drawdown, one-exposure-at-a-time, and the durable settlement ledger — remain the backstop for a run that no ranking can prevent.

## Implementation map

| Piece | Location |
| --- | --- |
| `normalCdf`, `posteriorEdgeProbability`, `posteriorVariance`, `threeLossRunRisk`, `recoveryEscalation`, `recoveryRiskWeight` | `artifacts/api-server/src/lib/autonomous-hedge/recovery-risk.ts` |
| `recentAfterLoss`, regime blend, `recoveryAfterLoss`, `R_3L`, `S_R` | `artifacts/api-server/src/lib/autonomous-hedge/hedge-analysis.ts` (`analyseHedgeCandidate`) |
| `κ`, `E`, 40-tick window, regime-weight cap | `artifacts/api-server/src/lib/autonomous-hedge/constants.ts` (`HEDGE_LIMITS`) |
| escalation computed per cycle and passed to the ranker | `artifacts/api-server/src/lib/autonomous-hedge/cycle.ts` (`runCycle`) |
| evidence published to the UI (`P(edge)`, `R3L`, `w`, `escalation`) | `contest.ts` (`decideHedge` reason) and `cycle.ts` (`scan_complete`), `agents/recovery-intelligence.ts` |
| staking invariant guard | `artifacts/api-server/src/lib/recovery-staking-invariant.test.ts` |

## Validation performed

- Full API server suite (`pnpm --filter @workspace/api-server test`): **906 tests, 124 suites, 0 failures** — including `recovery-risk`, `hedge-analysis`, `contest`, `families`, `cycle`, `agents`, `ledger*`, `recovery-completion`, `bot-recovery-parity` and the new `recovery-staking-invariant`.

- API server typecheck passed (`pnpm --filter @workspace/api-server typecheck` after `pnpm run typecheck:libs`).

- Trading-platform unit tests passed: **36 tests, 0 failures**.

- Trading-platform typecheck and production build passed; the first-paint render check passed all 8 routes.

## References

[1]: https://pmc.ncbi.nlm.nih.gov/articles/PMC9797254/ "Bayesian Analysis of First-Order Markov Models for Autocorrelated Binary Responses"

[2]: https://arxiv.org/abs/0710.3742 "Bayesian Online Changepoint Detection"

[3]: https://arxiv.org/html/1710.01787v1 "On Kelly Betting: Some Limitations"
