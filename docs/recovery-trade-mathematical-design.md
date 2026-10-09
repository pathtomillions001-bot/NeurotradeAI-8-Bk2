# Recovery-trade mathematical design

## What the change is intended to solve

Ten consecutive recovery losses are not evidence that a single missing threshold is the problem. They can arise from ordinary variance, a negative or overstated edge, autocorrelated losses, payout miscalibration, or an exposure ladder that grows faster than the evidence supporting the trade. The engine therefore needs two separate controls:

1. **Choose the least-bad recovery opportunity available now**, using uncertainty and loss clustering rather than point-estimate EV alone.
2. **Limit the amount exposed to that opportunity**, so one uncertain recovery attempt does not consume the full debt target.

The implementation keeps the tick-driven flow. It does not add a multi-minute confirmation wait or a new time-based hard gate.

## Mathematical model

### Bayesian win-rate uncertainty

For a candidate with `w` wins and `l` losses, use a Beta prior centered on the contract's baseline probability `p₀`:

\[
 p \sim \operatorname{Beta}(\alpha_0,\beta_0),\qquad
 \alpha_0=s p_0,\quad \beta_0=s(1-p_0)
\]

The posterior mean used by the existing ranker is equivalent to:

\[
 \bar p = \frac{w+s p_0}{w+l+s}
\]

The new recovery score also estimates the posterior uncertainty:

\[
 \operatorname{Var}(p) \approx \frac{\bar p(1-\bar p)}{w+l+s+1}
\]

The engine converts the distance from payout break-even into a posterior probability that the true edge is positive:

\[
 p_{BE}=\frac{1}{\text{payout}},\qquad
 P(p>p_{BE}\mid D)\approx
 \Phi\left(\frac{\bar p-p_{BE}}{\sqrt{\operatorname{Var}(p)}}\right)
\]

This is a normal approximation to the Beta tail used as a bounded, low-latency scoring feature. It is deliberately not treated as certainty: a 55% observed win rate with 20 samples is not ranked like a 55% win rate with 2,000 samples.

### Markov loss clustering

The existing engine already estimates first-order transitions. Recovery now also looks at the conditional win rate after a loss in both the full tape and a recent 40-tick window:

\[
 q_{L\to W}=\frac{LW+1}{LL+LW+2}
\]

The recent and long-run estimates are blended more heavily toward the recent estimate when the two tape halves are unstable. This is a soft regime adaptation, not a pause condition.

To quantify the immediate risk of another loss cluster, the engine estimates the probability of three future losses after the current recovery state:

\[
 R_{3L}\approx (1-q_{L\to W})\,q_{L\to L}^{2},\qquad
 q_{L\to L}=\frac{LL+1}{LL+LW+2}
\]

This is not a claim that the sequence is exactly Markovian. It is a compact stress indicator: a candidate with a high chance of another loss immediately after a loss is less suitable for recovery, even when its unconditional EV is attractive.

Bayesian first-order Markov models are a standard way to represent binary outcomes whose next probability depends on the previous outcome, and can also allow transition probabilities to vary over time [1]. Bayesian online change-point detection provides the complementary rationale for weighting recent behaviour more strongly after a regime shift [2].

### Soft recovery score

For normal trades, the existing score remains the base score. For recovery trades, the implementation adds three continuous adjustments:

\[
 S_R=S_0
 +18(P(p>p_{BE}\mid D)-0.5)
 -18R_{3L}
 -8\sqrt{\operatorname{Var}(p)}
\]

The coefficients are ranking weights, not probabilities. They are intentionally small enough that the established EV, confidence interval, instability, and clustering terms remain influential. The point is to make two candidates with similar EV distinguishable by uncertainty and near-term loss-run risk.

### Fractional recovery exposure

The exact recovery ladder remains the reference target, but it is multiplied by a bounded safety factor:

\[
 f=0.35+0.40\,C_E\,C_S\,C_R\,D_L
\]

where:

- \(C_E=\max(0,2P(p>p_{BE}\mid D)-1)\) is edge confidence;
- \(C_S=\operatorname{clip}(1-1.75\,\text{instability},0.35,1)\) is stability;
- \(C_R=\operatorname{clip}(1-R_{3L},0.35,1)\) is projected three-loss survival;
- \(D_L=1/(1+0.10\times\text{current loss run})\) is a mild streak dampener.

The resulting factor is bounded to `[0.35, 0.75]` and is applied to the requested recovery stake, subject to the existing minimum stake, balance, and maximum-stake checks. This is a **fractional recovery** policy: it accepts that a single win may not clear the full debt, in exchange for reducing the amount at risk when the evidence is weak or clustered losses are likely.

The rationale follows the limitations documented for Kelly-style sizing: maximizing long-run log growth does not guarantee acceptable short-term drawdown, and probabilistic drawdown constraints or fractional sizing can be preferable when parameter estimates are uncertain [3]. The change does not use full Kelly. It uses a bounded heuristic safety factor because the engine's payout, edge, and independence assumptions are not known with enough precision to justify an optimal-growth claim.

## Why this is preferable to another hard gate

A hard rule such as “wait for three confirmations” can reduce some bad entries, but it can also leave the engine idle while the recovery debt remains exposed to time and regime changes. The new logic instead:

- continues evaluating each tick;
- ranks all eligible recovery candidates with a risk-adjusted score;
- adapts to recent after-loss behaviour;
- reduces exposure when uncertainty, clustering, or a loss streak rises;
- preserves the existing account-level hard stops and unresolved-exposure protections.

This cannot eliminate ten-loss runs. If the underlying contract is negative expectancy or the tape is effectively independent with a high loss probability, no recovery formula can manufacture a positive edge. It can, however, reduce the chance that the engine compounds an uncertain recovery attempt into a large balance shock.

## Validation performed

- Focused autonomous hedge analysis and cycle tests passed: **15 tests, 0 failures**.
- Trading-platform unit tests passed: **36 tests, 0 failures**.
- Workspace library declarations built successfully.
- API server typecheck passed.
- Trading-platform typecheck passed.
- Production frontend build passed. Existing warnings remain for dependency engine versions, Sass deprecation, source maps, and large chunks; none were introduced as build failures by this change.

## References

[1]: https://pmc.ncbi.nlm.nih.gov/articles/PMC9797254/ "Bayesian Analysis of First-Order Markov Models for Autocorrelated Binary Responses"

[2]: https://arxiv.org/abs/0710.3742 "Bayesian Online Changepoint Detection"

[3]: https://arxiv.org/html/1710.01787v1 "On Kelly Betting: Some Limitations"
