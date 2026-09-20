# Match Prism — a Matches bot that refuses to trade until the market is proven unfair

*Scope: `artifacts/api-server/src/lib/match-prism-analysis.ts` (the maths),
`match-prism-engine.ts` (the session loop), the `/api/bots/prism/*` routes, and
`artifacts/trading-platform/src/components/prism-console.tsx` (the console).
It adds one bot — **Match Prism** — and changes no other bot's behaviour.*

---

## 1. Why the two existing Matches bots lose

At 8.93× the break-even rate for DIGITMATCH is

```
1 / 8.93 = 11.20%
```

against a **fair** digit stream of 10%. So on a market that is not biased, every
Matches strategy ever written loses

```
1 − 0.10 × 8.93 = 10.7% per shot, forever.
```

That is not a tuning problem, and no combination of recovery steps fixes it. The
existing bots lose for three specific, fixable reasons:

| Existing behaviour | What it costs |
| --- | --- |
| **Match Sniper** takes `argmax` of the last-digit histogram and pads the bar with a flat 1.5σ margin. | The margin is a *guess* at the argmax-of-ten selection bias. On a fair tape the best-looking digit has ≈ 10% true rate; the bot pays for that with a constant it never measures. |
| **Match Sniper** times entries from a fixed 4–12 tick "dormancy" band. | On a memoryless stream, waiting for a digit to be "overdue" is the **gambler's fallacy**. The band is never tested against the Geometric law it assumes. |
| **ks-matchdiff** applies a generalist tail-contract quantile bar inside an 8.93× Matches contract. | An 8.93× loss needs an 8.93× recovery. A bar calibrated for a 1.09× Differs contract says nothing about whether a Matches *ladder* survives. |
| **Neither** tests whether the market is biased at all. | A χ² test on 4,999 ticks calls a 0.2pp deviation "significant" — six times smaller than the 1.20pp the payout actually needs. Significance is not profitability. |

Prism inverts the whole design. Its analysis budget goes on **three structure
proofs**, and it will not fire until they pass.

---

## 2. The three proofs

Every signal Prism uses has to be *proven* to exist on the tape it is about to
trade. Anything unproven is shrunk to exactly zero weight.

### PROOF 1 — is the market biased at all?

A **compositional Bayes factor** between two exact, closed-form models:

- **H₀** — the point null: `p = (0.1, …, 0.1)`. Evaluated with
  `logNullMultinomial`.
- **H₁** — a symmetric Dirichlet whose concentration α is integrated over a
  log-uniform grid out to α = 5000, using the Dirichlet–multinomial marginal.

Both marginals are exact in log-Γ, so the factor is a real posterior
probability, not a p-value.

Two things matter here, and both are regression-guarded by tests:

1. **H₀ must be the point null.** A Dirichlet(1) "uniform" alternative *prefers
   concentration*, so using it as H₀ makes an i.i.d. tape score
   `BF ≈ 2.5 × 10⁶` and `P(biased) ≈ 1`. The guard is
   *"the point null beats the Dirichlet(1) alternative on a uniform tape"*.
2. **The grid must reach the null, and the marginal must carry its own prior
   weight** (`−log(points)`). Without either, the factor is either blind to a
   near-uniform bias or inflated by the width of the α search.

Measured, on 4,999-tick tapes:

| Tape | α̂ | BF₁₀ | P(biased) | Verdict |
| --- | --- | --- | --- | --- |
| uniform | 1264 | 0.010 | 0.3% | evidence **against** bias |
| one digit at 10.5% (0.5pp hot) | 2551 | 0.002 | 0.08% | not enough to pay 11.20% |
| one digit at 13% | 83 | 1.7 × 10⁷ | 100% | proven |
| one digit at 16% | 28 | 9.4 × 10³² | 100% | proven |

The third row is the point: **a 0.5pp bias — bigger than anything a χ² test
would ignore — is still refused**, because it does not fund the payout.

### PROOF 2 — does the previous digit matter?

A **ΔBIC comparison** of the 10×10 transition table against the memoryless
model. A 10-state chain fitted on 2,500 ticks has ~250 observations per row;
used unconditionally (as both predecessors do) it injects noise, not signal.

The row is allowed to move the estimate **only if it clears the certainty tier's
ΔBIC bar** — and then only through an exact conjugate Dirichlet posterior,
weighted by `n_row / (n_row + k·α)`. A 3-observation row carries ≈ 2% weight and
is therefore invisible; a 300-observation row carries most of it.

### PROOF 3 — does being "overdue" matter?

The chosen digit's own inter-arrival gaps against the fitted Geometric:

1. a binned **χ² goodness-of-fit** (expected counts derived from the *model*,
   not from the observed residual — pooling a χ² tail with an observed
   expectation manufactures a rejection out of thin air), and
2. a **pooled early-vs-late hazard** comparison at a median split, which returns
   a **direction**, not just a yes/no.

`memoryless = p > 0.05 && |z| < 2.58`. Three outcomes:

| `hazardDirection` | Meaning | Entry rule |
| --- | --- | --- |
| `rising` | a long absence makes the digit *more* likely | wait for `gap ≥ medianGap` |
| `falling` | the digit is most likely right after it prints | require `gap < medianGap` |
| `flat` | the gaps fit a Geometric law | **dormancy contributes exactly zero** |

The third row is what both predecessors lack. They only ever bet on "overdue" —
a fallacy on a memoryless stream, and the *wrong side* on a stream whose hazard
falls. Prism waits only for reasons it can prove, and it can prove the opposite
of what they assume.

---

## 3. The posterior, and Monte Carlo where it changes a decision

One posterior object is shared by the scan, the walk-forward and the live loop:
`prismPosterior` — Dirichlet mean `(α̂ + nᵢ)/(k·α̂ + N)`, with a strength of
`N + min(k·α̂, 200)`. The cap matters: without it the posterior over a window is
*narrower than its own sampling noise*, and the probabilistic gate degenerates
into a hard threshold at break-even.

Three quantities the selector needs are posterior functionals a point estimate
cannot supply, so `compositionalPosterior` draws from the Dirichlet:

- **`pClear = P(p_digit > break-even)`** — the headline gate, computed exactly as
  `1 − I_hurdle(α, β)` in closed form (the normal approximation both
  predecessors rely on is off by a factor of ~2 in this tail).
- **`pLower`** — the 5th percentile of the digit's rate, the number the ladder has
  to survive.
- **`pArgmax = P(this digit is the hottest)`** — the argmax-of-ten selection bias,
  **measured instead of guessed at**. On a fair 1,200-tick window it comes out
  ≈ 0.1; on a real bias it comes out ≈ 1.0. Prism does not pay a flat margin for a
  bias it never quantified.

Monte Carlo runs only where it changes a decision (the top ~14 of 190
candidates); the 190-candidate family is screened in closed form, which is why a
19-market scan finishes in seconds.

---

## 4. The ladder is priced before entry

Both predecessors enter first and hope the recovery works. Prism computes an
**exact absorbing-chain clearance** of the *user's own* plan with the *same*
stake formula the live engine executes
(`calculateBotRecoveryStake` → `applyRecoveryStakeLimits` → whole cents):

> State = outstanding debt in cents. A **win** moves to a smaller debt, a
> **loss** to a larger one, so the graph runs both ways and the chain is solved
> by value iteration (converges geometrically at rate `pWin`). Ruin = the loss
> run reaching the stop loss.

`requiredWinRateFor(plan, target)` inverts it: *the minimum true win rate at which
this plan's debt is repaid with probability `target`*. That single number is the
honest Matches hurdle, and it is a property of the **plan**, not of any market:

| Base stake | Stop loss | Rate needed to clear 95% of the time | Consequence |
| --- | --- | --- | --- |
| $1 | $5 | **23.84%** | no Matches market on earth offers this |
| $1 | $8 | 18.10% | effectively unreachable |
| $1 | $40 | 10.50% | *below* the 11.20% break-even → **break-even binds** |
| $1 | $100 | 8.20% | the payout is the only real constraint |

So the gate every candidate must pass is:

```
pLower  ≥  max(requiredWinRate, 1 / 8.93)
```

and when it fails, the refusal names the knob:

> *"the pessimistic rate 14.24% is below the 23.84% this ladder needs (stop loss
> $5.00 absorbs 10 consecutive losses) — widen the stop loss or lower the base
> stake"*

That message is the direct answer to **"multiple losses blow up my account"**.
A tight stop loss is *not* safety in a Matches ladder — it makes the ladder
unrecoverable, and Prism says so before the first dollar moves. The report also
flags a **binding stake cap** (`cappedStep`, `cappedRecoveryFraction`): a stake
capped at the balance makes the ladder look immortal while each win repays only a
fraction of the debt.

---

## 5. Out-of-sample, or it does not count

Ticks are split 50/50. The first half fits α̂, the ΔBIC bar, the calibration and
the entry threshold **τ**; the second half is then replayed with the frozen rule
and only its shots count.

- **τ is the top-quantile of Prism's own entry statistic on the train half**, so
  the design shot rate (0.4% / 0.8% / 1.5% by tier) holds in any regime, and τ is
  floored at the tier's posterior-probability floor so selectivity can never
  relax the evidence requirement.
- The **post-loss shield** (a slightly higher bar plus a cool-down after a loss)
  is *simulated on the same tape* with the shield off, so the console reports what
  it cost in lost shots instead of promising that it works.
- In-sample accuracy is printed next to out-of-sample accuracy, so over-fitting
  is visible rather than hidden.
- The ladder is re-priced at the **Wilson lower bound** of the out-of-sample win
  rate — the pessimistic case — not at the point estimate.

Deployment requires: proven bias, `pClear ≥` tier bar, `pLower ≥` ladder rate,
pessimistic ladder clearance ≥ tier bar, `≥ minShots` out-of-sample shots, and an
out-of-sample win rate whose lower bound clears break-even.

---

## 6. Live execution

- **Matches only.** The contract is re-asserted as DIGITMATCH immediately before
  every buy, and the catalogue's only `sides` entry is `DIGITMATCH`, so neither a
  stale card nor a future bug can make this bot buy a Differ.
- **Locked or switching is chosen AFTER the scan**, from the measured card (the
  same choice Match Sniper offers). *Locked* re-reads only the locked market —
  the digit may rotate inside it, the market never moves. *Switching* re-screens
  every market every 60s, and a rival must beat the incumbent by a margin before
  the bot moves.
- **The same shared recovery ledger** as Match Sniper (`recovery-math` +
  `recovery-engine` + `engine-arbiter`), with one addition: before every recovery
  shot Prism re-prices `requiredWinRateFor` for the *current* debt and refuses to
  add to a ladder the digit can no longer repay.
- **Hysteresis** keeps the held digit unless a rival is better by more than the
  margin, so a "hot digit" strategy cannot decay into a random-digit strategy.
- The live statistic is closed form (`1 − I_hurdle(α, β)`) — no Monte Carlo in the
  hot path.

---

## 7. Console

`prism@1` (see `docs/console-release-skew.md` for the contract). The panel leads
with the **proof ledger** — one row per proof, PASS/FAIL/N-A plus the number that
decided it — then the posterior tiles (`P(rate > break-even)`, pessimistic 5%,
ladder clearance), then out-of-sample vs in-sample accuracy, then the universe
panel with the honest one-line diagnosis and the ladder requirement. Locked and
Switching are offered side by side on the measured candidate. A refusal is a
first-class result: it prints the exact gate that failed and the best market
available, because "no market is provably unfair right now" is the correct trade.

---

## 8. Tests

`match-prism-analysis.test.ts` (45 tests) + `bot-console-parity.test.ts` (7).
The bounds that matter:

- the point null beats Dirichlet(1) on a uniform tape; BF < 1 on fair data;
- a 13% digit scores BF 1.7 × 10⁷ and a 0.5pp bias does not;
- geometric gaps accepted, clustered gaps rejected with `overdueZ > 0`;
- the absorbing chain matches `1 − q^depthLimit` within 0.03 where that closed
  form applies, degrades when the stop loss tightens, and reports a binding cap;
- `requiredWinRateFor` is inverted correctly in both directions;
- Monte Carlo agrees with the closed form to ~0.004;
- a fair market produces almost no qualifying entries; a planted 16% digit clears
  break-even out of sample;
- a locked digit is still refused if its own numbers do not clear the gates;
- live entry is **causal** — truncating the future reproduces the past decision;
- a degenerate tape (one digit 1,500×) is refused rather than crashed on, and the
  Bayes factor stays finite (rounding a near-ceiling double overflows to
  `Infinity`, which JSON-serialises as `null`);
- every console id the API publishes is renderable by the web bundle.

## 9. What Prism will actually do

On a synthetic, effectively memoryless volatility index — which is what Deriv's
digit streams are — Prism will spend most of its time **watching and saying so**:
it will report the universe's best `P(biased)`, name the gate that failed, and
stand down. That is the feature, not a defect: a Matches bot that fires on a fair
tape is paying a 10.7% tax per shot, and no ladder arithmetic changes the sign of
that expectation. When a market *is* measurably off-uniform, has a digital
fingerprint that survives a 50/50 split, and clears a rate its own ladder needs,
Prism trades it — with the deck counted rather than hoped for.
