# AI Bot Edge — Brainstorm: Making the 5 Specialist Bots Statistically Sharper

*Scope: only the five AI Bots (Parity/Even-Odd, Barrier/Over-Under, Match, Differ, Momentum/Rise-Fall)
and their analysis → timing → execution pipeline. We improve the existing system; we do not build a new engine.*

> **Implementation status (v3, this PR):** all ✓ items below are implemented in
> `specialist-analysis.ts` / `bot-scorer.ts` / `bot-engine.ts`:
> exact Beta-Binomial posterior tests (Lanczos + Lentz, no normal
> approximation), run-length-conditioned censored hazard, Dirichlet
> last-digit-transition tails, split-window Hurst regime agreement, signed-drift
> EMA + multi-scale direction agreement for momentum, posterior-quantile upper
> bound + geometric waiting-time gate for Match/Differ, anti-pattern repeat-loss
> memory in normal mode, and specialist-σ fusion of the read's own p̂ into the
> final win probability that feeds EV, stake sizing and the paper sim.

---

## 0. What "statistical edge" honestly means here

Deriv's synthetic markets are *pseudo-random* streams. Nobody can force a fixed win
rate; what an edge really is, is:

1. **Honest probabilities** — the bot's p̂ must be the minimum-variance, unbiased estimate
   of the true rate, and it must be *calibrated* (a "58%" trade wins ~58% of the time).
2. **Positive-EV gating** — never fire unless p̂ clears the payout's break-even rate by a
   margin in its own standard errors (z_be). Already implemented; must be kept airtight.
3. **Serial-structure exploitation** — digits/parities/tails are not i.i.d. in practice
   (Markov structure, runs, cycles). Each bot must model the exact structure its one
   contract family depends on, better than a generalist can.
4. **Selection-bias correction** — picking the "best of 10 digits" is upward-biased; FDR,
   shrinkage and posterior tests must eat that bias.
5. **Timing** — enter only when the edge is *present and persisting* at the execution tick,
   not merely at decision time.
6. **Learning** — per-family calibration on the bot's own trade history (Platt scaling
   already exists; extend the closed loop).

Everything below is graded **ethical ✓** (improves estimation/gating/timing) vs
**unethical / not viable ✗** (game-the-market tricks that are illegal, detectable, or
mathematically unsound — we do not implement these).

---

## 1. Cross-cutting improvements (all 5 bots)

### 1.1 ✓ FUSE THE SPECIALIST PROBABILITY INTO THE FINAL WIN-PROBABILITY
**Problem today:** the specialist layer computes the family's *best* p̂ (2-state chain,
tail chain, FDR-gated digit rate, Hurst-direction blend) but it only adds a **bonus to the
score**. The win probability that drives EV, stake sizing, the EV floor and the paper
simulation still comes from the FAB fusion (empirical + Markov + momentum + quantum)
**without the specialist's estimate**.

**Fix:** inverse-variance fuse `specialist.metrics.pHat` (with `metrics.sigma`) into the
same blend that already merges the FAB and quantum estimates, *before* Platt calibration.
The Differ bot's read is an *appearance* rate → winP = 1 − p̂. This is the single highest
value-per-line change: every downstream number becomes more accurate.

### 1.2 ✓ EXACT POSTERIOR TESTS FOR DIGIT SELECTION (Match/Differ)
**Problem today:** `digitCandidates` computes a normal-approximation z-test
(`(p̂−0.1)/σ`) against the fair 10%. For small windows a normal z understates
uncertainty and overstates significance → FDR passes noise digits.

**Fix:** model each digit's rate with a **Beta-Binomial posterior**
`Beta(1 + hits, 9 + (n−hits))` (a κ=10 pseudo-count prior at 10%). The one-sided
p-value becomes the exact posterior probability `P(p > 0.1)` / `P(p < 0.1)` via the
regularized incomplete beta function — no normal approximation, correct for small n.
Posterior variance replaces the ad-hoc EWMA σ. Fewer false discoveries; a genuinely hot
digit still passes.

### 1.3 ✓ ANTI-PATTERN REPEAT-LOSS MEMORY IN NORMAL MODE
**Problem today:** the recovery "sniper" path penalizes re-entering a
`(contract, barrier)` setup the market just punished, but **normal mode does not** — a bot
can lose on OVER-5 and instantly re-enter the same OVER-5.

**Fix:** record pattern outcomes for *every* bot trade (not just recovery) and apply the
same decaying penalty (`10 − 2·age`, cleared on a win) to normal-mode market scoring. The
bot refuses to re-buy the exact setup that just failed.

### 1.4 ✓ CALIBRATION CLOSED LOOP (already partial)
Keep per-family Platt scaling; the fusion in 1.1 feeds it a *better* input probability,
so the learned calibration is less polluted by estimator noise.

---

## 2. Even / Odd (Parity Sentinel)

**Current:** 2-state parity Markov (P(even|last parity)), 2nd-order chain, EWMA rate,
marginal rate, Wald–Wolfowitz runs → side, lag-2/3 cycles. Entry: z_be ≥ 0.75 and the
runs structure must not contradict.

### 2.1 ✓ RUN-LENGTH-CONDITIONED PROBABILITY
A 2-state chain conditions only on the *last* parity. The strongest serial information
for a parity bet is the **length of the current open run**: "odds have run 5 in a row —
what is the empirical hazard of that run ending *now*?"

**Fix:** add `runConditionedProbability` — censored run-hazard on the parity series.
If the open run is *against* the target, P(target) = hazard(k). If the open run is *for*
the target, P(target) = 1 − hazard(k). Laplace-smoothed, σ from the number of runs that
reached length k. Fused into the parity estimate blend. This is exactly the structure the
runs test *detects*; now the probability *uses* it.

### 2.2 ✓ DIRICHLET TRANSITION FROM THE LAST DIGIT
The parity chain collapses the 10 digits; it cannot see that "last digit = 7" vs
"last digit = 3" behave differently even though both are odd. Add an exact
**Dirichlet-multinomial transition posterior** P(next ∈ evens | last digit), with a
shrunken prior toward the marginal digit distribution. Exact posterior variance of the
sum. Blended in inverse-variance. Catches digit-specific parity structure the 2-state
model is blind to.

### 2.3 ✓ FRAGILITY OF THE PARITY SET
Cheap addition: if recent evens are dominated by 1–2 digits (low entropy inside the
even set), the "even" win is fragile — the mass can vanish without the parity chain
noticing. Mirror the barrier bot's fragility term.

---

## 3. Over / Under (Barrier bot) — user priority

**Current:** 2-state tail-membership chain + 2nd-order, EWMA, marginal, digit-mass drift,
edge fragility, barrier-adjacency pressure, streak hazard, tail-size-aware entry margin.

### 3.1 ✓ DIRICHLET TAIL PROBABILITY (the big one)
The tail chain conditions only on *tail membership* ("last tick in the tail?"), throwing
away which digit it was. But **the last digit is the single most predictive state** for
the next digit.

**Fix:** exact Dirichlet-multinomial posterior over the 10-digit transition row
conditioned on the **actual last digit**: α_d = rowHit(last→d) + κ·marginal(d),
P(win) = Σ_{d ∈ tail} α_d / Σα, with the exact posterior variance
`(α_sum−α_tail)·α_tail / (α_sum²·(α_sum+1))`. Blended into the estimate. This is a
strictly richer estimator than the 2-state tail chain — it is the *reason* a
single-family bot can beat a generalist.

### 3.2 ✓ SOFT BOUNDARY / NEAR-MISS MASS
Currently adjacency is a fixed ±2 penalty. Make it *continuous*: weight digits by
distance from the barrier in the probability estimate itself (kernel-shrunk mass), so a
tail whose mass is bunched at barrier+1 is correctly priced as more fragile than one
spread to the far end.

### 3.3 ✓ ADAPTIVE BARRIER GAP WINDOW
The `gap 4–12` / hazard thresholds are fixed bands. Replace with the digit's **own
mean gap ± σ** (dormancy z-score): "due" = gap ≥ mean_gap + 0.5σ. Already partially there
via `hazardRelative`; make the entry gate use a proper due-ness z.

---

## 4. Matches (Match Sniper) — user priority

**Current:** per-digit EWMA + context blend, FDR hot selection, dormancy hazard
(Kaplan–Meier style), break-even ranking (z_be vs 11.2%), entry z_be ≥ 1.5 (selection-bias
margin), gap ≥ 3 & hazard ≥ 0.8 gate.

### 4.1 ✓ EXACT POSTERIOR SIGNIFICANCE (from 1.2)
An 11.2% break-even with a 10% base rate means the *loss side* is fat-tailed in estimate
space. The Beta-Binomial posterior p-value (1.2) is the correct test; keep the
argmax-of-ten FDR correction on top. Also use the **posterior probability that p > 11.2%**
as the ranking criterion for the *selection* step (currently ranked by z_be of the blend —
similar, but posterior ranking is honest for small windows).

### 4.2 ✓ DORMANCY → PROPER GEOMETRIC WAITING-TIME
The current gap/hazard heuristic is good but ad hoc. A cleaner statistic: under the
digit's own posterior rate p̂, the probability that a gap of length ≥ g occurs is
`(1−p̂)^g`. Convert dormancy to a **geometric p-value** and gate on it (e.g. only enter
when the observed gap is in the tail of the digit's own gap distribution, p < 0.3). This
is the mathematically correct "overdue" test.

### 4.3 ✓ HOT-DIGIT MASS SHARING
When several digits survive FDR, prefer the one whose *neighbors* are also hot (mass
concentration) — a digit that is hot alone is more likely a noise draw; a digit hot
*with its cohort* is a real regime. Cheap: add a neighborhood bonus.

### 4.4 ✓ MATCH-SPECIFIC TIMING
The 8.93× payout means the bot should trade *rarely* and only at the exact dormancy
breaking tick. Consider requiring the gap to be ≥ the digit's own mean gap AND the
quantum timing score to be positive at the execution tick (the revalidation already
re-checks the specialist gate — extend it with the geometric test).

---

## 5. Differs (Differ Guardian)

**Current:** FDR cold-digit selection, 1.645σ upper-confidence-bound worst-case,
hot-run veto, gap gating. Break-even 91.7% — loss side is everything.

### 5.1 ✓ POSTERIOR UPPER BOUND (from 1.2)
The upper confidence bound should be a **posterior quantile** (Beta distribution
quantile, e.g. 90th percentile) instead of `p̂ + 1.645σ` normal bound — exact and
asymmetric, which matters at rates near 0.05–0.12.

### 5.2 ✓ MULTI-TICK SAFETY HORIZON
A Differ loses when the digit appears *within the contract window*. Currently only a
6-tick hot-run veto exists. Add: require the digit's posterior rate over the *next*
k ticks (k = 1–2) — approximated by `1 − (1−p̂)^k` — to stay below the loss budget,
and veto digits whose *conditional* P(appear | last digit) is elevated (uses the same
Dirichlet row as 3.1).

---

## 6. Rise / Fall (Momentum bot)

**Current:** Hurst R/S, lag-1..3 autocorrelation, tick-magnitude asymmetry, realized-vol
floor, direction chains, dead-chop refusal.

### 6.1 ✓ SPLIT-WINDOW HURST AGREEMENT
A single Hurst on ~80 returns is high-variance; a noise stream can look "trending" for
minutes. **Fix:** compute Hurst on the first and second half of the window and only claim
a regime (trending / mean-reverting) when **both halves agree**. Otherwise treat as
random-walk (no regime bonus, no regime-based side preference). This kills the most
common false-positive on this bot — noise misread as trend.

### 6.2 ✓ SIGNED-DRIFT EXPECTATION (EMA of returns, not just up/down counts)
Add an EMA of *signed* returns (drift μ̂) with its standard error; require
`|μ̂| / σ_μ ≥ 1.5` for the trend bonus to apply. A trend that only exists in the sign
counts but not in the magnitudes is too weak to trade.

### 6.3 ✓ MULTI-SCALE DIRECTION CONSISTENCY
Require short (10-tick), mid (30-tick) and long (80-tick) direction rates to agree in
sign for a trending entry — the same multi-window concurrence the FAB uses elsewhere,
now at the direction level.

---

## 7. Ethical vs unethical — honest scoring

| Idea | Verdict | Why |
|---|---|---|
| Better estimators (Beta/Dirichlet posteriors, run-hazard, split-window Hurst) | ✓ Implement | Reduces variance & bias of p̂ — the definition of edge |
| Fusing specialist p̂ into EV / sizing | ✓ Implement | EV is only as good as the probability feeding it |
| Anti-pattern repeat-loss memory | ✓ Implement | Loss-aversion of known-losing setups is sound risk management |
| Exact posterior tests instead of normal approx | ✓ Implement | Statistics 101; fewer false discoveries |
| Per-family self-calibration | ✓ Keep + feed better inputs | The honest closed loop |
| "Overfitting to past data to claim fake win rates" | ✗ Reject | Fits noise; produces a bot that *looks* great on backtests and loses live |
| "Bet only after N consecutive losses (martingale-adjacent)" | ✗ Already bounded | Existing recovery caps + EV floor make it a contained ladder, not an edge |
| Front-running / order-flow gaming on Deriv | ✗ Impossible+illegal | Synthetic ticks are generated centrally; no order book to front-run |
| Platform/time exploits (e.g. betting on stale quotes) | ✗ Reject | ToS violation; Deriv closes accounts; risk to users |
| Lying to the user about win rates / backtests | ✗ Reject | Fraud; destroys the trust the whole app is built on |
| Predict "near-certain" outcomes via insider info | ✗ N/A | No such info exists for synthetic indices |

The only durable edge is honest probability + positive-EV gating + selective timing +
self-calibration. Everything in sections 1–6 implements exactly that.

---

## 8. Priority & expected effect

1. **1.1 Specialist p̂ fusion** — every bot's EV/sizing immediately uses its best estimate. (all)
2. **1.2 + 5.1 Exact posterior tests** — Match/Differ stop chasing noise digits. (match/differ)
3. **3.1 Dirichlet tail probability** — Over/Under uses the last digit, its richest state. (barrier)
4. **2.1 Run-length conditioning** — Even/Odd exploits open runs exactly. (parity)
5. **6.1 Split-window Hurst** — Rise/Fall stops trading noise-trends. (momentum)
6. **1.3 Anti-pattern memory** — all bots refuse recently-punished setups. (all)

Each is a bounded, additive, well-tested improvement to the *existing* analysis layer —
no new timing/execution system, exactly per the requirement.
