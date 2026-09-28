# Vector Surge DBot — PULSE v2: fast, evidence-gated Rise/Fall analysis

**Status:** shipped in the generated "Create DBot" Rise/Fall bot runtime.
**Scope:** the DBot that Vector Surge's *Create DBot* button emits — the
Blockly runtime blocks `nt_analyse_surge_markets` / `nt_surge_decision` and
the pure analyser behind them. The pre-deploy scan (`scanForSurge`) is
untouched; its fitted `weights`/`tau` still flow into the runtime through the
generated XML, exactly as before.

## 1. Problem statement

The generated Rise/Fall DBot had two failure modes:

1. **Slow to trade.** Every `before_purchase` pass re-fetched up to 8 market
   tapes in serial batches of 3, re-ran five O(window) lenses per side, then
   had to pass a stack of gates that rarely line up together
   (`samples ≥ 79` AND `probability > BE+0.4pt` AND `lowerBound > BE−2.5pt`
   AND `utility > 0` AND `instability < 16pt` AND `disagreement < 20pt`), on
   top of a two-distinct-tick confirmation. The bot spent most of its life
   "ANALYSING".
2. **Still losing when it fired.** The direction-frequency estimate has a
   standard error of ≈3.2pt at 240 ticks, yet the model fired whenever the
   point estimate sat ~0.4pt above the 52.08% break-even — and it even
   allowed the 90% lower bound to be **2.5pt under** break-even. It was
   trading noise. There was also no test for whether the tape contained any
   exploitable serial structure at all, and no distinction between
   trend-following and mean-reversion tapes.

## 2. Brainstorm — candidate mathematics

Everything considered, and why it was accepted or rejected:

| Idea | Verdict |
|---|---|
| Wald **SPRT / sequential likelihood testing** — fire the moment evidence crosses a boundary, the provably fastest fixed-error test | ✅ Accepted, generalised form |
| **Generalized likelihood ratio (G-test)** of the conditional edge vs break-even, `evidence = n_ctx · KL(p ∥ p₀)` | ✅ Accepted — one number that says "the edge is real" |
| **Posterior tail probability** `P(p > break-even)` via the regularized incomplete beta function | ✅ Accepted as the "confidence" gate |
| **Beta quantile lower bound** (10% quantile) instead of a normal-approx bound | ✅ Accepted — strict, small-sample honest |
| **Markov regime classification**: marginal-adjusted persistence z (`p̂_stay` vs `p_up² + p_down²`) | ✅ Accepted — primary regime statistic |
| **Wald–Wolfowitz runs test** z-score | ✅ Accepted as a reported diagnostic (confounded by skewed marginals, so it informs rather than gates) |
| **Order-1 Markov conditional** `P(next ∣ last direction)` with Dirichlet(4,4) smoothing | ✅ Kept — the exact quantity the trade bets on |
| **Run-length hazard** (Kaplan–Meier style discrete hazard) | ✅ Kept, upgraded with **exponential recency decay** (half-life 60 ticks) so fresh micro-structure outweighs stale runs |
| **Adaptive memory via prequential scoring** — two half-life Beta models (20/60 ticks), keep whichever predicted the last 25 ticks better | ✅ Accepted — algebraic model selection with no hyper-parameter to fit |
| Robust **MAD-normalised EMA drift** | ✅ Kept as a minority lens (discounted in REVERSAL regimes where drift misleads) |
| Multi-horizon direction rates (20/60/all) | ✅ Kept as instability monitor + lens component |
| Hurst exponent (R/S) | ❌ Rejected for the DBot — biased on short tick tapes, marginal-adjusted persistence z is more reliable at n≈50–500 |
| Order-2..5 suffix memory | ❌ Rejected for the DBot — too sparse per context at 1-tick horizon; the scan-side engine keeps it |
| UCB/Thompson market bandit | ❌ Deferred — market ranking already exists; the win is making each ranking cheap (epoch cache) |
| CUSUM change detection | ⚠️ Approximated — the existing instability gate + recency-decayed hazard cover regime flips adequately |

## 3. The PULSE v2 pipeline (what the DBot now runs)

One O(n) pass builds a **shared tape summary** (directions, transition
matrix, recency-weighted runs, flat rate); both sides then reuse it.

### Q1 — Is this tape exploitable at all? (the loss-stopper)

```
p_up   = (n_up + 4) / (n + 8)                       # Jeffreys-smoothed mix
p_exp  = p_up² + (1 − p_up)²                        # stay-rate of an iid tape
z_pers = (p̂_stay − p_exp) / √(p_exp(1−p_exp)/(n−1)) # marginal-adjusted
```

* `z_pers ≥ +1.282` → **TRENDING** (continuation structure — ride runs)
* `z_pers ≤ −1.282` → **REVERSAL** (alternation structure — fade the last move)
* otherwise → **RANDOM** — **both sides are refused**.

At a 1.92× payout the break-even win rate is `1/1.92 ≈ 52.08%`. On a coin-
flip tape every fired trade is −EV before latency, so **standing aside is the
edge**. This single gate removes the bulk of the old model's losing trades:
the old bot happily fired on any noisy 54% frequency; PULSE v2 first demands
proof (90% one-sided) that the tape is not a coin flip. Adjusting for the
marginal matters: a tape that rises 75% of the time has an expected stay
rate of 62.5% under randomness — an observed 50% stay rate is strong
*mean-reversion* evidence, which a naïve "p_stay vs 0.5" test would miss.

### Q2 — Which side, with what probability?

Four lenses, each expressed as "probability this side wins the next tick":

1. **Adaptive-memory Bayes** — recency-decayed Beta posterior
   (`α ← 12 + (α−12)·0.5^(1/hl)` per tick). Two memories run in parallel
   (half-life 20 and 60); a **prequential log-score** over the final 25 ticks
   keeps whichever one has actually been predicting better. Fast regime
   changes are picked up without any change-point machinery.
2. **Order-1 Markov conditional** —
   `P(up∣up) = (n_uu+4)/(n_uu+n_ud+8)`, `P(up∣down) = (n_du+4)/(n_du+n_dd+8)`;
   the lens reads whichever matches the current last direction.
3. **Recency-decayed run hazard** — the open run's probability of ending now,
   with completed runs weighted `0.5^(age/60)`.
4. **Robust drift + multi-horizon rates** — MAD-normalised EMA z-score folded
   through a sigmoid, averaged with 20/60/full direction rates; drift weight
   is discounted in REVERSAL regimes.

Fusion (as v1): **logarithmic opinion pool** in logit space, but the user's
fitted weights are now blended with regime weights by geometric mean
(`wᵢ ∝ √(userᵢ · regimeᵢ)`), with temperature τ:

```
logit(p) = Σᵢ wᵢ · logit(lensᵢ) / τ
```

### Q3 — Is there enough evidence to fire NOW? (the speed engine)

* **Conditional G-test.** The trade bets on a *conditional* probability, so
  the evidence is measured on the transitions out of the current
  last-direction state (`n_ctx` of them, minimum 12):

  ```
  evidence = n_ctx · KL(Bern(p_fused) ∥ Bern(p₀)),   p₀ = 1/payout
  ```

  This is the one-sample binomial likelihood ratio against break-even —
  the sequential-testing boundary `ln 9 ≈ 2.197` corresponds to ≈90%/90%
  error probabilities. A clean tape crosses it within ~50–100 ticks; a noisy
  tape never does. Recovery mode fires at `0.8·ln 9` (repayment speed beats
  selectivity, but the gate still exists).
* **Posterior tail** — pseudo-Beta `Beta(p·n_eff, (1−p)·n_eff)` with
  `n_eff = clamp(n_ctx, 24, 120)`: require `P(p > p₀) ≥ 0.80` (0.70 recovery)
  computed with the **regularized incomplete beta function** (Lanczos log-Γ +
  continued fraction).
* **Lower bound** — the distribution's 10% quantile (bisection on the CDF)
  must clear break-even outright (recovery gets 1.2pt of slack). The old
  model's `BE − 2.5pt` allowance is gone.
* **Kept guards** — loss-continuation veto `q_LL < 0.58` in recovery,
  instability `max(|s−m|,|m−l|)`, weighted lens disagreement, flat-tape veto,
  plus a new **one-sided-tape veto** (needs ≥8 ticks of counter-evidence).

### Speed engineering around the maths

* **Epoch-keyed analysis cache** in the runtime: results are keyed by
  `(mode, symbol, window, payout, tape length, last tick epoch)`. Repeated
  interpreter passes over the same tick reuse the analysis — zero re-fetch,
  zero recompute.
* **One parallel round** for all watched markets (was: serial batches of 3).
* **Single-pass shared summary** per tape; both sides reuse it. Full analysis
  of a 500-tick tape measures ≈1ms (regression-tested).
* **Sample floor 79 → 48**: the beta-tail and G-test are calibrated for small
  samples; waiting for 79 bought nothing but latency.
* **Confirmations:** NORMAL fires on a single evidence-strong tick (the GLR
  boundary already demands persistent evidence); RECOVERY keeps the
  two-distinct-tick rule because those stakes are debt-sized.

## 4. Why this should trade better, honestly stated

* Fewer, better trades: the regime gate refuses coin-flip tapes outright —
  the class of tape where the old model bled most.
* Faster trades on real structure: the sequential evidence boundary fires as
  soon as the structure is proven, instead of waiting for six gates to align
  by accident.
* Structure-aware sides: trending tapes are ridden, alternating tapes are
  faded, via the same conditional probabilities — the old model only ever
  hunted unconditional directional bias.
* No promise of edge on a truly random market: 1-tick Rise/Fall on synthetic
  indices is close to a fair coin minus spread. PULSE v2 turns that fact into
  discipline — it only spends money where the serial structure is
  statistically demonstrated, and sizes recovery through the existing shared
  debt ledger.

## 5. Files

| File | Change |
|---|---|
| `artifacts/dbot-builder/.../trade/surge-forge-analysis.js` | Full PULSE v2 rewrite (pure, synchronous) |
| `artifacts/dbot-builder/.../trade/Ticks.js` | Parallel scan, epoch cache, mode-specific confirmations |
| `artifacts/dbot-builder/.../Tick Analysis/neurotrade_surge_forge.js` | New decision fields: regime, edge probability, evidence, persistence z, runs z, memory |
| `artifacts/api-server/src/lib/surge-dbot.ts` | Entry log text ("evidence-confirmed setup") |
| `artifacts/dbot-builder/src/preview/__tests__/fixtures/surge-r50-adaptive.xml` | Regenerated fixture |
| `artifacts/dbot-builder/.../trade/__tests__/surge-forge-analysis.spec.js` | 4 existing + 7 new tests |

New decision fields readable from `nt_surge_decision`: `regime`, `edgeProb`,
`evidence`, `zPersist`, `runsZ`, `memory` — available for custom strategies
and future console UIs.
