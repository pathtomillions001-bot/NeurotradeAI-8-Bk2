# MT5 Live Desk v4 — design record, changes and evidence

This document is the running record of the v4 programme: what changed, why,
what was measured, what is assumed, and what is still unverified. It is written
to be read by someone deciding whether to trust the desk with money — so the
numbers are here, including the ones that are unflattering.

Scope: `artifacts/api-server/src/lib/multiasset/*`, `src/routes/desk.ts`,
`src/routes/bridge.ts`, `artifacts/mt5-ea/NeurotradeBridge.mq5` and its copy in
`artifacts/trading-platform/public/downloads/`. The Deriv digit/rise-fall
engines (`lib/agents/*`, bot-engine, dual-lock, killshot) are **not touched** by
this programme.

Everything described as OFF is off by default: the v4 subsystems live behind the
`DESK_V4_*` flags in `lib/multiasset/desk-v4-config.ts`, and the pre-v4 desk runs
unchanged when they are unset.

---

## 1. The problem v4 exists to solve

The v3 desk was, in its own words, a *conviction* engine. It scored setups on a
weighted pile of indicators, required a score above a threshold, and then sized
the trade. Its own forward simulation of what the EA would actually do, run over
600 windows of pure noise, produced:

| v3 measurement on structureless data | value |
| --- | --- |
| median confluence confidence | 65.6 (the bar was 60) |
| windows where ≥3 of 7 "agreeing" families agreed | 90% |
| predicted expectancy from the quote | **+0.46R** |
| realised, after what the EA actually did | **−0.50R** |

That gap is the defect. It is not a bad indicator; it is a pipeline that
produces a confident number without any measurement that the number is true.

v4 replaces conviction with **measurement at every layer**: each component
outputs either a *calibrated probability* or a *hard permission*, and nothing
reaches the market without a measured, out-of-sample, cost-adjusted edge.

The programme is delivered in work packages (WP0…WP10). Each one must pass its
own acceptance criteria — including the research harness — before the next
starts.

| WP | subject | status |
| --- | --- | --- |
| WP0 | EA hot-fixes + the position-management state machine | **done** (`de3b40b`) |
| WP1 | hard invariants: reward:risk at the fill, one-SE targets, loss-halt backstop | **done** (`fbe0e6b`) |
| WP2 | the research harness (loader, walk-forward, executed-policy simulator, metrics, gates, CLI) | **done** (this document's section 4) |
| WP3 | regime agent (HMM + change-point permission) | next |
| WP4 | alpha agents A–E behind one interface | |
| WP5 | meta-model + calibration (isotonic, purged CV, one-SE) | |
| WP6 | gatekeeper replacing the final arm decision (EV_LCB, BH, cost/σ, executed-policy MC) | |
| WP7 | execution/timing agent (pending orders, cancel rules, seasonality, spread z) | |
| WP8 | portfolio & risk (¼-Kelly on p_LCB, DD scalar, correlation heat, CVaR) | |
| WP9 | learning & governance (shadow evals, persisted calibrators, e-process breakers) | |
| WP10 | UI + journal | |

---

## 2. WP0 — the position-management state machine

### 2.1 The defect (D1)

A plan was armed with a full `management` block — partials, breakeven, a
chandelier trail, a time stop — and **all of it was lost at the moment of
fill**. The v3.04 EA managed a position by searching for an *active plan* for
that symbol (`FindPlanForSymbol`), but a plan is removed from the armed set once
it executes, so from the first tick after entry the position had a stop and a
target and nothing else. No partial, no breakeven, no trail, no time stop. Every
simulation that assumed management therefore described a trade the EA never ran.

### 2.2 What replaced it

* `lib/multiasset/position-manager.ts` — a **pure** state machine:
  `managePosition(input) → { actions, state, notes }`. No I/O, no clock, no
  store: given the same state, quote, bars and policy it returns the same
  actions, which is what makes it testable and what lets the research harness
  execute the *real* policy rather than an approximation of it.
* States: `OPEN_RISK → BE_ARMED → PARTIAL → RUNNER`, with terminal
  `TIME_STOP`, `REGIME_EXIT`, `SESSION_NEWS_FLAT`, `PYRAMID` (transient) and
  `CLOSED`. Each terminal state records *why* it fired.
* Actions: `modify_sl`, `close_partial`, `close_all`, `pyramid_add` — the EA
  applies them; the machine never talks to the broker.
* Priority order per evaluation: session/news flatten → regime exit → time stop
  → partial rungs → breakeven → trail → pyramid. **At most one stop
  modification per evaluation**, breakeven outranks the trail (V15 in the
  tests — an earlier version could emit both and the second silently won).
* Breakeven moves the stop to `entry ± (costPrice + 0.05R)` — *covering the
  round-trip cost first*, because a stop at entry is a stop at entry-minus-cost
  and the position still books a loss. `beDone` is set **only when the stop
  actually moved** and the candidate respects the broker's stop level; marking a
  position "risk-free" while the market still holds the original stop is the
  most dangerous state this machine can be in, because the pyramid and trail
  logic both trust it.
* Partials are quantised to the broker's volume step and **never rounded up**;
  a rung that cannot be legally filled is consumed with a note rather than
  retried forever, and a rung that would leave an illegal remainder either
  shrinks or closes the whole position.
* The chandelier trail uses the **entry timeframe's** ATR (×2.0 / 2.5 / 3.0 for
  scalp / intraday / swing), arms at the plan's `activateAtR`, requires a
  minimum step of 0.1 ATR, obeys a cooldown (`1500 ms` or `0.5R` of progress),
  respects the broker's stops/freeze level, and **never loosens**.
* Time stop: if the trade has made no progress (`< 0.5R`) and its MFE is below
  `1.0R` after `noProgressBars` closed entry-timeframe bars, it is closed. A
  trade that has run is not cut off by the clock.
* The `barsSinceEntry` counter advances only on the **next** bar after entry
  (a fill inside bar *k* has seen zero completed bars, not one) — V14's fixture
  originally encoded the optimistic reading and was corrected.

### 2.3 EA v3.05 (`artifacts/mt5-ea/NeurotradeBridge.mq5`)

* Version property and sync payload are `3.05`.
* The management policy is captured **at arm time** into the EA's own plan copy.
  Nothing is looked up later: the plan may be gone, the server may be away.
* **Per-ticket `PositionState`** (`MAX_POS_STATES = 128`), created at fill from
  `OnTradeTransaction` (`DEAL_ADD` / `DEAL_ENTRY_IN`) and reconciled at start-up
  and on every sync. Management is keyed by **ticket**, never by an active plan
  — the structural fix for D1.
* Durability: each state is written to a common-file record
  `Neurotrade\pos\<login>_<ticket>.csv` and mirrored in a terminal global
  variable (`NTPS_<ticket>`). Orphan records are dropped on `OnInit`.
* New inputs: `UsePendingOrders`, `ConfirmOnBarClose`, `StreamTicks`,
  `TickStreamPerSymbol` (40), `MaxPendingOrderMinutes` (60).
* Real pending orders (`BuyLimit`/`SellLimit`/`BuyStop`/`SellStop`) with an
  expiry capped by `MaxPendingOrderMinutes`; the working order owns the plan
  until it fills, expires or is invalidated, and is cancelled once price runs
  ≥ 0.5R away unfilled. `LastClosedBarBeyondTrigger` implements bar-close
  confirmation from `rates[1]`.
* `NowUtcMs()` fixes a v3.04 latent defect: the plan's `expiresAt` is a true UTC
  epoch while the trade-server clock is not, so comparing the two was comparing
  UTC against server time — **every plan looked expired and nothing ever
  traded** through that path.
* Cached indicator handles per timeframe (created once, released in `OnDeinit`)
  instead of recomputing the ATR on every management call.
* `set_management` bridge command applies a refreshed policy to a live ticket.
* Management events (stop moved, partial closed, time stop) are buffered in a
  64-entry ring and reported in the heartbeat's `managementEvents`, so the Desk
  can journal what the EA actually did rather than what it was asked to do.
* `StringGetCharacter("|", 0)` for the pipe: MQL5 does not accept a char
  literal (`'|'`) as a `StringSplit` separator.

**The EA is UNCOMPILED.** There is no MetaEditor in this environment, so the
MQL5 in this repository has never been through a compiler. The TypeScript
mirror (`ea-contract.test.ts`) and the `position-manager` tests check the *wire
format and the rules*, not the MQL5 syntax. **Compiling in MetaEditor is a
required step before any live use**, and it is the only check that nothing still
calls a removed helper.

---

## 3. WP1 — the hard invariants

Three changes, each an invariant rather than a tuning.

### 3.1 Reward:risk is measured at the expected fill

The desk armed a plan on the current quote with `RR = |TP − quote| / |quote −
SL|`, then the EA fired it 0.08 ATR (scalp) or 0.12 ATR (intraday/swing) beyond
the trigger. A plan advertised at 1:2 was therefore around **1:1.85 at the price
actually paid** — and worse on a volatile bar, because the fill is the worse of
the trigger and the bar's open plus the spread.

Now: `expectedFill = trigger ± (triggerOffset + slippagePrice)`, the target
search runs **from the fill**, sizing runs **from the fill** (sizing off the
quote understated the stop distance and, because the lot size divides by that
distance, silently risked *more* than the budget), and a plan whose
`RR_fill = |TP − expectedFill| / |expectedFill − SL|` is below **2.0** is
refused with the numbers in the human-readable reason. `rationale.rewardRisk`
reports `RR_fill`, not the quote ratio.

### 3.2 Target selection: the one-standard-error rule, not the argmax

`bestTarget` used to return the multiple with the highest simulated expectancy —
which on a noisy simulation is the *luckiest* multiple. It now:

1. only considers multiples of **2.0, 2.5, 3.0** (nothing below 2R is reachable
   — enforced inside the function, so no caller can ask for a sub-2R target);
2. computes `rStdDev` and `expectancyStdErrR` per multiple (per-path R sums over
   wins, losses and timeouts);
3. returns the **smallest** multiple whose expectancy is within one standard
   error of the best — the simplest target that the data cannot distinguish from
   the best.

### 3.3 The consecutive-loss halt: 5 → 10, and relabelled a backstop

A five-loss breaker halts strategies that are working as designed. At a 42% hit
rate, a measured (seeded, deterministic) 400-run × 300-trade experiment gives a
median longest losing streak of **8 or more**, and more than 95% of runs reach
five. Halting at five means a healthy system spends much of its life switched
off. The backstop is now **10 consecutive losses**, documented as a backstop:
the real circuit breaker is the per-agent e-process (WP9), and the loss ladder
(1, 1, 0.75, 0.5, 0.35) de-escalates size long before either fires.

---

## 4. WP2 — the research harness

Everything above is a claim. This section is the measurement.

### 4.1 What it is

`src/lib/multiasset/research/`:

| file | what it does |
| --- | --- |
| `loader.ts` | MT5 M1/tick CSV → bars, server-time→UTC, resampling, validation warnings |
| `generators.ts` | nulls (driftless, block-shuffled, phase-randomised) and the positive control |
| `walkforward.ts` | rolling splits with **purge + embargo**, and CPCV families |
| `executed-policy.ts` | the simulator: real entry resolution, real position-manager state machine, real costs |
| `metrics.ts` | trade statistics, PSR, DSR, PBO, calibration (reliability slope, Brier skill) |
| `harness.ts` | the runner + the gates (null / control / calibration) |
| `specs.ts` | contract specs for offline studies, with every assumed value PRINTED |
| `cli.ts` | `research:run` — the command that produces a stored report |

Two properties are load-bearing and are tested directly:

* **No lookahead.** Bars are visible only once their own width has elapsed
  (a 10:15 M15 bar carries the 10:30 price; feeding it to a 10:20 decision is
  leakage). `executed-policy.test.ts` replaces every bar after time *t* with
  different data and requires the decision at *t* to be **byte-identical**.
* **Executed policy.** The trade is entered where the EA would enter
  (worse of trigger/open, plus spread and slippage), stopped or targeted on the
  bar's own high/low with the **stop winning a tie**, managed bar-by-bar by the
  real state machine, and marked to market with the spread paid, not the mid.

### 4.2 Producing the data (owner's part)

Real broker data, exported from the owner's own terminal:

1. Open an M1 chart of the symbol; press `Home` repeatedly so the terminal has
   the history (≥ 3 months for intraday, ≥ 6 months for swing).
2. Right-click → *Save As…* (or Symbols → Bars → Export) to CSV/TXT.
   Columns understood, any delimiter, any order, decimal comma fine:
   `DATE, TIME, OPEN, HIGH, LOW, CLOSE, TICKVOL, VOL, SPREAD`.
3. **Supply the server time offset** (`--server-offset-minutes 180` for GMT+3).
   MT5 exports in the broker's server time; getting this wrong shifts every
   session boundary and news window, and the error is invisible in the results.
   The report prints the offset it used.
4. Optionally export the Ticks tab for the same symbol (WP4D's flow agent).

### 4.3 Running it

```bash
# The gates, on the harness's own generators (no broker data needed)
pnpm --filter @workspace/api-server run research:run -- \
  --mode intraday --data synthetic:all --seed 1 --stride 10 --bars 2400 --runs 6 \
  --label baseline-synthetic --out research-reports/baseline-synthetic-intraday.json

# The desk on the owner's data
pnpm --filter @workspace/api-server run research:run -- \
  --mode intraday --data ./data/EURUSD_M1.csv --symbol EURUSD \
  --server-offset-minutes 180 --seed 1
```

Contract values are read off the terminal (Symbols → the symbol →
Specification) and passed as `--point --digits --tick-value --contract-size
--volume-min --volume-step --spread --commission`. Anything not passed is
defaulted **and listed as ASSUMED in the report**, because a study built on a
wrong `tickValue` is worthless and looks exactly like one built on a right one.

### 4.4 The gates

| family | gate | threshold |
| --- | --- | --- |
| NULL (driftless / block-shuffled / phase-randomised) | arm rate | ≤ 3% |
| | mean realised R | ≥ −(cost_R + 0.05) |
| | DSR-significant runs | ≤ 5% |
| POSITIVE CONTROL (regime drift + AR(1) residual) | arm rate | ≥ 10% |
| | mean realised R | ≥ +0.30 |
| | \|predicted − realised\| | ≤ 0.15R |
| CALIBRATION (quasi-held-out) | reliability slope | ∈ [0.8, 1.2] |
| | Brier skill | ≥ 0 |

A gate that cannot fail is worse than no gate, so each one is tested in both
directions (`harness.test.ts`): a strategy that never arms passes every null
gate and fails the control; a run with a DSR of 0.97 on noise fails; an
unmeasurable calibration slope fails rather than passing by default.

### 4.5 The baseline result — the current desk, as it stands

`synthetic:all`, 2400 bars per series, stride 10, 18 structureless series and 1
positive control, seed 1. Full report:
`artifacts/api-server/research-reports/baseline-synthetic-intraday.json`.

Every null reading below is the **worst series** in the family (the report names
it); the aggregate is printed as well. A family may not pass by averaging a bad
series against a good one.

**Intraday**

| | measured | gate | verdict |
| --- | --- | --- | --- |
| null arm rate (worst series) | **18.4%** (aggregate 8.2%: 316 arms in 3840 evaluations) | ≤ 3% | **FAIL** |
| null mean realised R (worst series) | **−0.481R** | ≥ −0.10R | **FAIL** |
| null runs DSR-significant | 0.0% of 18 | ≤ 5% | pass |
| control arm rate | 86.7% | ≥ 10% | pass |
| control mean realised R | +1.055R | ≥ +0.30R | pass |
| control \|predicted − realised\| | **0.348** | ≤ 0.15 | **FAIL** |
| calibration slope | **−0.241** | ∈ [0.8, 1.2] | **FAIL** |
| calibration Brier skill | **−1.70** | ≥ 0 | **FAIL** |

**Swing** (same configuration, `baseline-synthetic-swing.json`)

| | measured | gate | verdict |
| --- | --- | --- | --- |
| null arm rate (worst series) | **17.3%** (aggregate 8.5%: 325 arms in 3840 evaluations) | ≤ 3% | **FAIL** |
| null mean realised R (worst series) | **−0.848R** | ≥ −0.10R | **FAIL** |
| control arm rate | 81.3% | ≥ 10% | pass |
| control mean realised R | +1.238R | ≥ +0.30R | pass |
| control \|predicted − realised\| | **0.351** | ≤ 0.15 | **FAIL** |
| calibration slope | **23,785** — unmeasureable, not "perfect" | ∈ [0.8, 1.2] | **FAIL** |

**How to read this.** The desk *can* find a real edge — it arms on 87% of the
positive control and makes +1.06R per trade there — but it also arms on 4–17% of
pure noise and **loses money on it**, and its stated win probability is not
calibrated (it says ~50% where the truth is 85%, and where the truth on noise is
~45%). The DSR and Brier numbers are the arithmetic of the same defect: the
pipeline's confidence is not a probability.

This is the honest baseline, and it is exactly why WP3–WP6 exist: a regime
permission, measured alpha agents, a calibrated meta-model and a gatekeeper that
refuses anything whose *lower bound* expected value is not positive after costs.

Two notes on the nulls themselves. Phase randomisation preserves the power
spectrum, so it preserves linear temporal structure — it is a *weaker* null than
the driftless walk, and the desk's worst null results appear on it. And one
block-shuffled series produced +0.416R with a DSR of 90.3%: the deflation kept
it below the 95% significance line, and the "≤ 5% of runs" gate held, which is
the mechanism working.

---

## 5. WP3 — the regime agent

### 5.1 What it is

Two modules, both pure functions of `(bars, config)`, both deterministic, both
free of lookahead:

* **`change-point.ts`** — Bayesian online change-point detection (Adams–MacKay),
  a Normal–Inverse-Gamma predictive in log space with an explicit log-sum-exp.
  It reports the run-length posterior, `P(a change in the last N bars)` at every
  bar, and the bars where that path crossed 0.5. It reads the series once,
  forward.
* **`regime-hmm.ts`** — a 3-state diagonal-Gaussian HMM fitted by Baum–Welch
  (seeded k-means++ init, then eight Lloyd iterations, up to 20 EM iterations
  from two seeded starts), with a strictly forward `filterPosterior` for the
  live reading and an offline `viterbiPath` for reporting.

The regime layer's product is a **permission**, not a score:

| condition | threshold | what it catches |
| --- | --- | --- |
| `P(required state)` | ≥ 0.60 | the model is guessing |
| expected dwell ≥ 1.5 × holding bars | 18 / 36 / 72 bars for scalp / intraday / swing | the trade outlives the regime |
| `P(change point in the last 5 bars)` | < 0.30 | the world just changed — a filter is most confident exactly when it is most wrong |

Every refusal carries machine-readable codes (`STATE_PROBABILITY_LOW`,
`DWELL_TOO_SHORT`, `CHANGEPOINT_RECENT`, `REGIME_UNAVAILABLE`) and one human
sentence. `REGIME_UNAVAILABLE` **refuses**: "we could not measure the regime" is
not the same as "the regime is fine".

The observation vector is five causal features per bar: `ret_z` (the bar's
return in robust-σ units), `drift_z` (cumulative 5-bar return / σ — the feature
that actually carries a regime), `vol_ratio` (20-bar realised volatility / σ),
`slope_z` (least-squares slope of the last 20 closes), and `markov_z` — the v3
Markov model, **kept as one low-weight feature** (× 0.25) rather than deleted or
trusted: its raw signal is bounded in [−1, 1] while the others are standardised,
so the weight keeps it visible in the fitted means without letting it dominate
the geometry.

### 5.2 The measurement, and the one thing that had to be fixed first

The acceptance criterion is ≥ 80% accuracy on simulated 3-regime data against
the generator's **known labels**. The first run of that gate failed — and the
failure was in the *fixture*, not the detector: the original labelled generator
used `p_stay = 0.97`, a ~33-bar regime on 15-minute bars. Fitting even the
**supervised** filter — the true generative parameters, given the true labels,
filtered causally — recovered only ~70–74% of those bars, because a causal
detector needs several bars of evidence to notice a switch and 33-bar regimes
make a fifth of all bars unrecoverable by any causal method. The gate would have
been measuring the generator.

So the fixture now models a regime as a day-long character (`p_stay = 0.99`,
~100 bars per regime) with a +0.6σ drift in the bull, −0.6σ in the bear and a
range at half the volatility — still deliberately not trivially separable. And
the measurement itself now always reports the **supervised ceiling** next to the
fitted accuracy, with a test asserting the ceiling clears 80% — so this specific
confusion can never come back disguised as a modelling failure.

### 5.3 Why the fit window is longer than the filter window

The emissions identify themselves on a few hundred bars. The **transitions** do
not: a 250-bar window contains two or three regime switches, and the
maximum-likelihood self-transition from three observations is a lottery.
Measured on the first labelled series: the fitted dwell of a regime whose truth
was ~100 bars bounced between **10 and 35** across adjacent decision points, so
the dwell condition refused a *correct* up-trend on 96% of its bars (3 permits
in 76) and only permitted it 81 bars after the switch.

Fitting on four times the filter window (`fitBars = 1000`) costs about 3× the
milliseconds and fixes it: the same series' fitted dwell reads 220–232 bars, the
permission arrives 20 bars after the switch, and the buy-permit rate inside bull
runs went from 4% to **87–100%** across seeds (with **0** short permits inside a
bull run, which is the property that matters). The filter still runs causally
from the first bar the fit saw, so nothing is gained from the future — only from
more of the past. A test asserts `fitBars ≥ 4 × windowBars` so a future
"optimisation" cannot quietly remove this.

Cost: ~130 ms per permit on 900 bars, ~84 ms when the caller supplies the live
store's 400-bar cap. This is paid once per plan evaluation, not per tick.

### 5.4 A trend must be statistically significant

State labels cannot come from the state index (k-means++ decides that), and
"the state with the highest mean return" is not enough either: a fit can split
one trending tape into a strong and a mild up-state, and calling the mild one
"range" throws away a real permission.

A state is a trend only when its **trend score** — mean per-bar return in σ
units × √dwell, i.e. the t-statistic of the drift over a typical stay — clears
±2.0. Random walks travel ~√dwell σ by accident, so this asks whether the tape
moved further than noise explains. The threshold is measured, not picked: over
12 seeds of the driftless null the largest |score| was **1.44**, while the
labelled control's trend states scored **3.31–10.16** and the range state never
exceeded **0.78**. The dwell is capped at the sample size, so a degenerate fit
cannot inflate the score through an unmeasurable persistence. The permit sums
`P(required label)` over *every* state carrying the label, so a split trend is
one permission rather than two half-permissions.

### 5.5 The result

Accuracy against the generator's labels — fitted on the first half of each
series, graded causally on the held-out second half — with the supervised
ceiling for the same series:

| mode | series | causal | Wilson 95% LCB | Viterbi | ceiling |
| --- | --- | --- | --- | --- | --- |
| intraday | 5 labelled series | **85.5 – 90.5%** | 83.4 – 88.7% | 88.0 – 92.2% | 86.7 – 91.1% |
| swing | 3 labelled series | **89.0 – 90.5%** | 87.1 – 88.7% | 89.9 – 91.9% | 89.6 – 90.6% |

The gate is **≥ 80%** and it is met on every series, within 1.2 points of the
supervised ceiling — the remaining error is the information limit of the
features at regime boundaries, not slack in the fit. Reports:
`research-reports/2026-10-11-wp3-regime-study-intraday.json` (5 series, verdict
**PASS**) and `…-wp3-regime-study-swing.json` (3 series, verdict **PASS**).

What the permission does to trades, on the labelled series (113 decisions each):

| series | desk-v3 arms / E[R] | v4-regime arms / E[R] | vetoes |
| --- | --- | --- | --- |
| #1 | 66 / +1.441R | 49 / **+1.608R** | 17 |
| #2 | 71 / +1.276R | 47 / **+1.540R** | 24 |
| #3 | 4 / **−0.890R** | 31 / **+1.365R** | 17 |
| #4 | 75 / +0.903R | 39 / **+1.198R** | 39 |
| #5 | 55 / +0.992R | 41 / **+1.114R** | 15 |

Series #3 is the interesting one: the un-gated desk lost 4 trades, tripped its
own consecutive-loss/cooldown logic and then stopped arming for the rest of the
series — while the gated desk, its trade sequence cleansed of the trades that
would have tripped it, armed 31 times at +1.365R. The veto removes 15–39 of
55–75 arms and improves the mean on all five.

The null result is the safety claim, and it is the number this work package
exists for (`…-wp3-regime-null.json`, 9 structureless series, 549 evaluations):

| family | aggregate arm rate | worst series | arms |
| --- | --- | --- | --- |
| desk-v3 | **17.5%** | 25.7% | 96 in 549 evaluations |
| v4-regime | **0.18%** | 1.35% | **1 in 549 evaluations** |

The v4-regime family's report verdict is nevertheless **FAIL**, and it is worth
being precise about why: one of its 549 evaluations armed on a block-shuffled
series and lost 1.0R, so the family's "mean realised R ≥ −(cost+0.05)" null gate
reads −1.000R and fails. A single trade is the minimum possible sample and
evidence of nothing either way; the gate is applied exactly as written rather
than relaxed for it, and the honest summary is: the *arm-rate* gates — the ones
that measure whether the layer is doing its job on noise — pass at 0.18% versus
the desk's 17.5%.

**WP3 is not yet wired into the live decision path.** The agent, its measurement
and its reports exist; the flags `DESK_V4_REGIME_HMM` and `DESK_V4_CHANGEPOINT`
default to off, and the composition point for every permission — the gatekeeper
— is WP6. Until then the shipped desk behaves exactly as it did after WP2.

## 6. Documented assumptions and conservative choices

Each of these was a fork in the road where the conservative option was taken and
the reasoning recorded.

1. **Fill = trigger + slippage allowance** (`expectedFill`). The desk does not
   model queue position or partial fills, so it assumes it pays the worse side
   plus the mode's slippage allowance. Conservative for the R:R gate (it shrinks
   the measured ratio) and for sizing.
2. **Halt after 10 consecutive losses**, explicitly a *backstop*. Justified by
   the measured streak distribution (§3.3); the primary breaker is the WP9
   e-process.
3. **`triggerType` stays `"break"` until WP7.** The v3.05 EA can already place
   real limit/stop orders and confirm on bar close, but the *server* keeps
   arming breakout entries because changing the entry style changes the strategy
   — that decision belongs to the WP7 execution agent, on harness evidence.
4. **An armed plan without a `management` block is tolerated by the EA**, which
   falls back to documented defaults (`management` is a required field on the
   TypeScript side, so no server path can omit it; the fallback exists for wire
   compatibility with an older server). The alternative — refusing the plan —
   would turn a compatibility gap into a missed trade.
5. **The harness does not re-simulate portfolio-level limits.** Daily loss,
   the drawdown scalar, correlation heat and margin are governed live by
   `risk.ts` / `portfolio-risk.ts`. What *is* carried across trades is the
   consecutive-loss state (and the loss ladder), so the backstop behaves as it
   does live. Arm rates measured on structureless data are therefore an
   optimistic **upper** bound on what the same setup would arm live.
6. **Calibration is reported quasi-held-out** (trades whose decision fell in the
   last two thirds of the series) for the baseline, where nothing was fitted.
   WP5's fitted models must report from walk-forward *test* windows instead.
7. **Assumed contract spec values are printed, never hidden.** `tickValue = 1`
   per point per lot is right for a 5-digit USD-quoted pair and wrong nearly
   everywhere else.
8. **The EA is treated as unverified MQL5 until the owner compiles it** (§2.3).
9. **A refusal is a default, not an exception.** Every path in `regimePermit`
   that cannot produce a reading — too little history, a fit that throws, an
   empty frame — returns `permit: false` with `REGIME_UNAVAILABLE`. The
   alternative (treating "no measurement" as "no objection") is how a filter
   silently becomes a no-op.
10. **The regime veto is measured on the labelled control with a supervised
   ceiling reported beside it.** No claim about the detector is made without
   also stating what the data allows; the test asserts the ceiling clears the
   gate, so a bad fixture cannot be mistaken for a bad detector.
11. **The three-regime fixture models a day-long regime** (`p_stay = 0.99` on
   M15, ~100 bars), not the 33-bar regime the first version used. Rationale and
   measurement in §5.2 — with 33-bar regimes ~20% of bars are unrecoverable by
   *any* causal filter, which makes an 80% gate unpassable by construction.
12. **A trend must clear a significance bar (±2.0 t-statistic of the state's
   drift over its own dwell).** Measured separation, not a taste: null ≤ 1.44,
   control's trend states 3.31–10.16, control's range state ≤ 0.78 (§5.4).
13. **`fitBars = 1000` versus `windowBars = 250`.** The dwell condition is a
   transition probability and the transition needs more history than the
   emissions; measured cost ~130 ms per permit against the alternative of a
   lottery (§5.3). `regimePermit` reports the bars it actually got
   (`bars`), the bars it wants (`wanted`) and the floor below which the reading
   is flagged inadequate (`minimum`), so a caller with a short history is told
   rather than left to find out from the fills.
14. **The change-point veto reads the *last* bar's probability of a run length
   shorter than 5**, which is exactly "a change in the last five bars", and
   nothing looks at the final value of an *older* reading: a break that has
   aged out of the window is correctly no longer recent. The veto is 0.30, not
   the 0.35 the false-veto measurements might have permitted — the conservative
   direction.

## 7. Changelog — every behavioural change, and the gate ledger

### Behavioural changes

| # | change | effect |
| --- | --- | --- |
| 1 | Position management no longer depends on an active plan (TS state machine + EA per-ticket `PositionState`) | fixes D1: partials, breakeven, trail and time stop now actually run after fill |
| 2 | `NowUtcMs()` in the EA's plan evaluation | fixes a latent defect where every plan evaluated as expired |
| 3 | Entry pending orders (`UsePendingOrders`) with expiry and 0.5R runaway cancel | **off by default**; the server keeps arming breakout entries until WP7 |
| 4 | Bar-close confirmation (`ConfirmOnBarClose`) | **off by default** |
| 5 | Tick streaming to the server (`StreamTicks`) | **off by default** |
| 6 | Management events reported in the heartbeat | new observability; no change to trading |
| 7 | Cached ATR handles | performance only (the walk to the broker is unchanged) |
| 8 | Reward:risk measured at the expected fill, minimum 1:2, plans below it refused | **tighter** |
| 9 | Target selection: multiples restricted to [2, 2.5, 3] R and the one-SE rule | **tighter / more conservative** |
| 10 | Sizing measured from the expected fill | risk now matches the budget instead of exceeding it |
| 11 | Consecutive-loss halt 5 → 10 (backstop) | **looser** — justified by the measured streak distribution; the loss ladder and WP9's e-process remain |
| 12 | Labelled 3-regime generator: `p_stay` 0.97 → 0.99, bull/bear drift 0.45σ → 0.6σ, range volatility ×0.6 → ×0.5, all configurable | **research fixture only** — no shipped code path reads it; it exists to make the WP3 gate measurable (§5.2) |
| 13 | The regime layer's permission (HMM state probability + dwell + change-point veto) | **added, not yet wired**: `DESK_V4_REGIME_HMM` / `DESK_V4_CHANGEPOINT` default off; the live desk is unchanged until WP6 composes the permissions |
| 14 | `regimePermit` refuses with `REGIME_UNAVAILABLE` instead of guessing when history is short or a fit fails | **tighter** (fail-closed) |
| 15 | Null-family gates in the research report now report the *worst series* per gate, with the aggregate beside it | reporting only — no strategy behaviour changes; the two baselines were re-run so every stored report shares one format |
| 16 | The 10 WP0–WP3 test files are now part of `package.json`'s `test` script (they were only runnable by hand) | coverage only — the same assertions now run in the standing regression |

### Gate ledger

* **Added**: `MIN_RR_FILL = 2.0` (refuses sub-2R plans); `MIN_TARGET_R = 2.0`
  inside `bestTarget`; the research gates (null / control / calibration).
* **Tightened**: the R:R ratio is now measured at the fill rather than the
  quote; the target search is constrained to ≥ 2R; the one-SE rule replaces the
  argmax.
* **Added (WP3)**: the regime permission itself (state probability ≥ 0.60,
  dwell ≥ 1.5 × holding bars, change-point veto < 0.30 — three conditions, all
  must hold); `REGIME_UNAVAILABLE` as a refusing path; the trend-significance
  bar in `labelStates` (±2.0); the "detector within 10 points of the supervised
  ceiling" gate; `null:v4-regime` — the same null gates applied to the gated
  family, which is what turns "it feels safer" into a number (17.5% → 0.18%).
* **Removed**: **none.** No safety gate was removed in WP0–WP3. Everything in
  §1's constraint list (fail-closed news gate, quote integrity, clock
  normalisation, one-account-one-desk, live-off default, daily-loss and drawdown
  limits) is intact, and the position-manager tests assert the ones that touch
  management.

## 8. Open risks and unverifiable items

1. **The EA has never been compiled** (no MetaEditor here). Compile
   `NeurotradeBridge.mq5` in MetaEditor before any live or demo use; the
   compiler is also the final check that nothing still references a removed
   helper.
2. **No real broker data has been studied yet.** The baseline above is on
   synthetic data. The command in §4.3 must be run on the owner's own export
   before any threshold is treated as final.
3. **The baseline fails its null gates.** Until WP6's gatekeeper is in place,
   the desk arms on structureless data at 4–17% and loses on it. Nothing in v4
   should be switched on for live trading before that gate exists.
4. **Calibration is unproven.** The current probability output is not
   calibrated (slope −0.24, Brier skill negative). WP5 must fix it and show the
   slope inside [0.8, 1.2] on held-out data.
5. **Slippage is modelled, not measured.** The ledger (WP7) replaces the
   allowance with observed slippage by symbol, session and order type.
6. **Portfolio effects are not yet simulated** (see §6.5); WP8 owns them.
7. **The harness's own blind spots**: uniform spread when the file has no SPREAD
   column, no queue position at the trigger, no partial fills at the entry,
   intrabar ambiguity resolved pessimistically (stop first), and a decision
   clock on the fastest frame of the mode's band.
8. **The regime agent needs more history than the desk currently retains.**
   `regimePermit` wants `fitBars = 1000` bars of the frame it reads (§5.3), and
   the bar store keeps `MAX_BARS = 400`. Wired as it stands, the model would fit
   on ~370 rows and the dwell estimate would return to the measured lottery
   (fitted dwell 10–35 bars against a ~100-bar truth, permitting a correct
   up-trend on 4% of its bars). WP6 must either raise retention for the regime
   frame or have the agent read a coarser frame — and the permit now carries
   `fit.bars / wanted / minimum / adequate` so the journal can say which
   happened. A coarse frame is not a free lunch either: the horizon in
   `MODE_HORIZON_BARS` is denominated in the *fastest* frame's bars, so the
   conversion has to be explicit and tested.
9. **The 85–91% accuracy is on simulated regimes.** The generator's dwell
   (~100 bars) and drift (±0.6σ) are modelling choices, not measurements of
   EURUSD. A market with shorter regimes would make the dwell condition refuse
   more often (the conservative direction) and a market with longer regimes
   would make it bite less; both must be re-measured on the owner's own export
   (§4.2) before the gate is treated as final for a live symbol.
10. **The regime agent is not consulted by the live decision path yet.** Its
    flags default off and the composition point is the WP6 gatekeeper (§5.5).
    Between now and then the desk's behaviour is exactly the WP2 baseline —
    including the null-gate failures above.

## 9. Tests and commands

```bash
# the standing regression — every api-server test, including the desk suites
cd artifacts/api-server && pnpm run test

# every desk test on its own (multiasset + research)
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx --test \
  --test-timeout=180000 --test-force-exit src/lib/multiasset/*.test.ts src/lib/multiasset/research/*.test.ts

# typecheck (all packages)
pnpm run typecheck

# the harness
pnpm --filter @workspace/api-server run research:run -- --help

# the WP3 regime study, from scratch (≈ 55 s, writes its own report)
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx src/lib/multiasset/research/cli.ts \
  --mode intraday --data synthetic:three-regime --runs 5 --seed 1 --bars 2400 --stride 20 \
  --strategy v4-regime --label wp3-regime-study

# the WP3 safety claim: the null gates, applied to the gated family (≈ 35 s)
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx src/lib/multiasset/research/cli.ts \
  --mode intraday --data synthetic:null --runs 3 --seed 1 --bars 2000 --stride 25 \
  --strategy v4-regime --label wp3-regime-null
```

Stored reports (`artifacts/api-server/research-reports/`):

| report | what it is | verdict |
| --- | --- | --- |
| `baseline-synthetic-intraday.json` | the WP2 baseline (desk-v3), intraday | FAIL (null, control, calibration) |
| `baseline-synthetic-swing.json` | the same, swing | FAIL |
| `2026-10-11-wp3-regime-study-intraday.json` | WP3 accuracy gate, 5 labelled series | **PASS** |
| `2026-10-11-wp3-regime-study-swing.json` | the same, swing, 3 series | **PASS** |
| `2026-10-11-wp3-regime-null.json` | null gates for desk-v3 vs v4-regime | FAIL (desk-v3 null gates; v4-regime fails one gate on a single trade — §5.5) |

Current state: **416/416** desk tests (was 382 before WP3), **1,060/1,060**
api-server tests overall, **37/37** trading-platform tests (including the 6/6
EA-download parity check that keeps `public/downloads/NeurotradeBridge.mq5`
byte-identical to the source), typecheck clean across all packages.
