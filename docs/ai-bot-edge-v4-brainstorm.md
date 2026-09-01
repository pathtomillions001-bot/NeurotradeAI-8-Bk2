# AI Bots v4 — "Edge Honesty" Upgrade (brainstorm + implemented solutions)

> **Goal.** Make the five specialist AI bots (Parity Sentinel, Differ Guardian,
> Match Sniper, Barrier Architect, Vector Momentum) deliver better-analysed,
> better-timed, better-executed trades so the user is confident deploying any
> bot. **Constraint.** We are *not* building a new analysis/timing/execution
> system per bot — we are improving the current one: same architecture
> (FAB-parity scorer → specialist layer → inverse-variance fusion → Platt
> calibration), sharper statistics inside it.

---

## 1. Where the current system stands

Each bot runs, on every tick, a specialist statistical layer
(`lib/specialist-analysis.ts`) that is fused into a FAB-parity score and a
win probability (`lib/bot-scorer.ts`), gated twice (FAB green light +
`specialistEntryGate`), re-validated on the execution tick, and calibrated on
the bot's own journaled trades (`lib/bot-calibration.ts`). The five families:

| Bot | Family | Core estimators already present |
|---|---|---|
| Parity Sentinel | parity | 2-state + 2nd-order parity chains, EWMA, marginal bias, run-length conditioning, Dirichlet last-digit, Wald–Wolfowitz runs, lag-2/3 cycles |
| Barrier Architect | barrier | 2-state tail chains, EWMA, marginal, Dirichlet last-digit, digit-mass drift, edge fragility, barrier adjacency, run-hazard falling-knife veto |
| Match Sniper | match | FDR-gated digit selection, dormancy hazard from the digit's own gap history, geometric waiting-time gate, 1.5σ selection-bias margin |
| Differ Guardian | differ | Exact Beta upper-bound tail risk, cold FDR, hot-run veto, worst-case-win gate |
| Vector Momentum | momentum | Hurst R/S with split-half agreement, lag-1..3 autocorr vector, 2-cycle, magnitude asymmetry, dead-chop floor, drift-EMA t-test, multi-scale direction agreement |

This is already a serious statistical stack. The v4 work is about the places
where it is still **statistically dishonest or under-armed**, which directly
costs win rate.

---

## 2. Weaknesses found (root-cause analysis)

### W1 — Variance understatement from correlated estimators (ALL bots)
Every family blends several estimates of the *same quantity* computed from the
*same buffer* (EWMA, marginal frequency, 1st/2nd-order chains, run-conditioned
hazard, Dirichlet row). `blendEstimates` treats them as independent:
`σ_blend = 1/√Σ(1/σᵢ²)`. Because the estimates are positively correlated
(they are all functions of the same series), the true uncertainty is larger.
The consequence is **inflated z and z_be → the entry gates release more trades
than the evidence justifies → realized win rate trails the estimate**. With k
equally-weighted, equally-variable, correlation-ρ estimates the correct
inflation is `σ_eff = σ_iid · √(1 + (k−1)·ρ)`.

### W2 — Marginal digit rates average the whole window (Match/Differ)
The per-digit Beta posterior is computed from **raw counts over the entire
buffer** (up to thousands of ticks ≈ tens of minutes), while the EWMA uses a
≈65-tick memory. A digit that was hot 30 minutes ago still inflates p̂ and —
worse — the Beta's σ is `√(p(1−p)/n)` with n = full window, so the posterior
**overwhelmingly dominates the blend** (97%+ weight) and the recent-context
estimators become irrelevant. The blend is inconsistent: recency is not
priced into the exact posterior.

### W3 — Argmax selection bias is handled by a *fixed* margin (Match/Differ)
The match bot's p̂ is the best of ten noisy digit estimates; an argmax is
optimistically biased. The current fix is a fixed 1.5σ margin. That absorbs
`E[max of 10] ≈ 1.54σ` for *independent* estimates, but says nothing about the
**gap to the runner-up**: two near-equal digits at 13% both clear a marginal
hurdle and the bot effectively coin-flips which one to trade. The data-driven
correction is to require the chosen digit to **beat the runner-up by a
margin in its own significance units** (a selection margin).

### W4 — Differ hot-run veto is a count heuristic, not a probability
`recent6 ≥ 3` is a proxy. The mathematically correct quantity is the
**immediate repeat hazard**: `P(target digit | last digit = target)` — the
probability the just-seen digit appears again and kills a Differ. At a 1.09×
payout the loss budget is `1 − 1/1.09 = 8.26%`; if the transition estimate of
a repeat exceeds that budget, the Differ is −EV *right now*.

### W5 — Match has no current-tick context requirement
The match gate checks dormancy (gap) and break-even significance, but not
whether **this tick's transition context** supports the digit:
`P(chosen | last digit)`. A digit can be overdue and marginally hot while the
live transition row says it is cold *right now*.

### W6 — Side arbitration ranks bonuses, not expected value (Barrier)
When OVER and UNDER are both armed, `specialistSideChoice` compares raw
specialist *bonuses*. Different barriers have different payouts, so the
higher-bonus side is not always the higher-EV side. Example: OVER 2 (1.40×,
break-even 71.4%) with p̂=0.75 has EV +0.05; UNDER 2 (4.72×, break-even
21.2%) with p̂=0.25 has EV +0.18 — the EV-optimal choice is not the
max-bonus choice.

### W7 — Momentum regime is confirmed by Hurst only
Hurst R/S is high-variance and known to be biased; split-half agreement helps
but there is no distribution-backed random-walk test. The **Lo–MacKinlay
variance-ratio test** is the standard complement: `VR(q) ≈ 1` under a random
walk, `VR > 1` trending, `VR < 1` mean-reverting, with a
heteroskedasticity-robust z-statistic. The direction stream also never gets a
runs test (the parity bot has one; momentum should too).

### W8 — The entry gate's break-even is the *fallback* schedule, not the live quote
At execution time the bot fetches a live payout quote, but the specialist
revalidation gate re-checks z_be against the **fallback** payout. If the live
quote is worse than the schedule, a trade that clears the margin at fallback
break-even can still be −EV — the EV floor catches it afterwards, but the
whole scan/quote cycle was wasted, and the margin itself was not tested
against the real hurdle.

---

## 3. The solutions (all implemented in this PR)

### S1 — Correlation-aware variance inflation (W1)
`blendEstimatesCorrelated(est, ρ)` — inverse-variance blend with the
inflation factor `√(1 + (k−1)·ρ)`. Used by all five family reads
(ρ ≈ 0.30–0.35). Keeps the same point estimate (minimum-variance mean), but
the σ that feeds z, z_be, confidence, and the outer fusion is honest. Net
effect: fewer marginal trades, same strong edges (the planted-edge harness
still fires, the fair-stream harness filters harder).

### S2 — Recency-weighted Beta posterior (W2)
`weightedBetaPosterior(series, priorRate, priorCount, decay)` — the exact
Beta-Binomial posterior computed on **exponentially-decayed counts**
(`α=0.99 ⇒ n_eff ≈ 199` ticks). Replaces the raw-count posterior in
`digitCandidates`: the posterior mean, the exact quantile upper bound, and
the exact one-sided posterior p-value (`posteriorRateProbabilityWeighted`)
all become recency-consistent. The EWMA is removed from the per-digit blend
(it was redundant with, and inconsistent against, the posterior). A digit's
p̂ and σ now describe *the recent stream*, and the blend's weights are honest.

### S3 — Selection margin vs the runner-up (W3)
A **z-test of the difference** between the two strongest digits becomes a
metric (`selectionMargin`) and a gate:

    D = (p̂_best − p̂_second) / √(σ_best² + σ_second²)

Under "the top two are equally good" this statistic is ≈ N(0,1), so the
95% one-sided threshold (**1.645**, same for match and differ, the latter
on worst-case win rates) refuses ~95% of genuine coin-flips, while a
decisive digit (the only hot/cold one) clears it by a wide margin. A locked
digit (user's explicit choice) is exempt — the user decided.

### S4 — Repeat-hazard gate for Differ (W4)
`digitCandidates` now exposes `ctxSupport = P(target | lastDigit)` (exact
Dirichlet-style transition, κ=10 prior toward the digit's marginal rate,
thick-row requirement `rowTotal ≥ 8`). The differ gate refuses when
`ctxSupport > 1 − 1/payout` (≈8.26% at the fallback 1.09×, recomputed from
the LIVE payout at execution) — the repeat probability exceeds the loss
budget. The count heuristic (`recent6 ≥ 3`) remains as a fast pre-check;
the probability is the law.

### S5 — Context-support gate for Match (W5)
The same `ctxSupport` metric: the match gate refuses when the current-tick
transition context says `P(chosen | last) < 0.07` (below 70% of fair 10%)
with a thick row. The entry must be supported by the live tick, not only by
the window statistics.

### S6 — EV-aware side arbitration (W6)
`specialistSideChoice` gains an optional `valueOf(read, side)` function;
the bot engine arbitrates OVER vs UNDER (and RISE vs FALL) by **expected
value** (already computed in each `BotMarketScore`) with hysteresis in EV
units (2pp), falling back to bonus when EV is absent. Same hysteresis
invariant, better objective.

### S7 — Variance-ratio test + runs alignment for momentum (W7)
`varianceRatioTest(returns, q=4)` — overlapping Lo–MacKinlay estimator with
the heteroskedasticity-robust z (neutral `{1,0,0}` for `n < 12` or zero
variance). Used as:
- **Regime confirmation**: trending bonus is only full-strength when
  `VR > 1.05` agrees; a contradicting VR zeroes the regime bonus.
- **Bounded bonus** `±2` when `|z_vr| ≥ 1.5` (scaled by z/5).
Plus the existing `waldWolfowitz` runs test on the direction series:
significant clustering → ride the last move; significant alternation → fade
it (`±2`). Regime conviction now rests on Hurst **and** VR **and** runs
agreeing.

### S8 — Live-payout-aware entry revalidation (W8)
In `bot-engine.ts` the payout quote is fetched **before** the execution-tick
specialist revalidation, and `specialistEntryGate(read, { payout })`
recomputes `break-even = 1/payout` and `z_be = (p̂ − be)/σ` against the
**real hurdle** before the trade is released. The EV floor remains the last
backstop; the gate now uses the same numbers as the floor.

---

## 4. Verification

- **Unit tests** (`bot-edge-v4.test.ts`, plus the existing suites):
  - correlated fusion inflates σ by the closed-form factor and keeps the
    point estimate;
  - weighted Beta is recency-sensitive (a recent hot block moves the mean
    more than an old one) and agrees with the closed form for small n;
  - variance-ratio test separates trending / alternating / i.i.d. series;
  - match selection margin refuses near-equal digits and passes a decisive
    hot digit; locked digit exempt;
  - differ repeat-hazard blocks a repeating digit below the count threshold
    and passes a cold digit;
  - context-support gates block a contradicted current tick;
  - payout-aware gate blocks a read that only clears the fallback
    break-even when the live payout is worse;
  - EV arbitration picks the higher-EV side and respects hysteresis.
- **Regression harness** (`bot-edge-upgrade.test.ts`, unchanged): gates
  still filter fair streams, still fire on planted edges, released trades
  still beat break-even, Platt calibration and digit hysteresis untouched.
- `pnpm run typecheck` across the workspace.

## 5. What we deliberately did NOT do

- No new per-bot "systems": no new API endpoints, no new DB tables, no new
  execution paths, no per-bot engines. All changes live inside the existing
  specialist layer, scorer wiring and engine gating.
- No changes to the FAB-copied formulas in `bot-scorer.ts` (the FAB parity
  rule is respected: bot-scorer's copied formulas are untouched).
- No changes to stake sizing, recovery math, SL/TP, or the shared recovery
  ledger — those are user-controlled risk functions.
