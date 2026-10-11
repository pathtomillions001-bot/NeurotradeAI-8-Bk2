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

**Status after WP4:** the desk's LIVE behaviour is still the pre-v4 desk. WP0–WP3
built the position manager, the RR floor, the research harness and the regime
agent; WP4 built and measured five alpha agents (§6) and allowlisted two of them
for intraday and none for swing. Nothing in WP0–WP4 is consulted by the live
decision path — every flag defaults off, and the composition point is the WP6
gatekeeper.

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

## 6. WP4 — the alpha agents

Five detectors, one interface, and one rule that shaped all of it: **no agent may
state a probability it has not measured.**

### 6.1 The five agents, and the catalogue that is not here

| id | file | the claim it trades |
| --- | --- | --- |
| A `trend` | `alpha/trend.ts` | after a directional move, a shallow counter-move that holds the structure resumes |
| B `mean-reversion` | `alpha/mean-reversion.ts` | a close in the outer tenth of its own 20-bar range, with the push stalling, reverts |
| C `liquidity-sweep` | `alpha/liquidity-sweep.ts` | a raid through a prior extreme that closes back inside and gives back half the raid fails |
| D `vol-regime` | `alpha/vol-regime.ts` | volatility expanding 1.25–3× its own base rate carries the drift with it |
| E `seasonality` | `alpha/seasonality.ts` | the UTC hour has a measured, persistent drift (t ≥ 2.5 on its own history) |

Each is a file with one exported factory, a declared frame list, a minimum
history, and a single `view(ctx)` method that returns **either a view or null**.
Abstention is a first-class answer, and an agent that throws is reported as an
abstention rather than taking the desk down (`readAlphaAgents`).

The brief's longer catalogue — Ichimoku balance, ADX > 26, CCI, RSI(2),
pips-of-pullback, Keltner, Gaussian channels, alligator spreads, round-number
distances — is deliberately **not** shipped as a set of hard-coded thresholds.
A dozen authoritative-looking numbers with no measurement behind them is the
defect this whole programme exists to remove (§1). They belong in this table as
future per-family studies, each with a fixture and a report; what ships is the
five families whose claims could be measured.

### 6.2 Where a probability comes from (`alpha/edge.ts`)

There is no hand-set probability anywhere in `alpha/`. Each agent measures its
own hit rate for **this exact setup** on the bars it can see, and states the
shrunk estimate

```
P̂ = (hits + k · p₀) / (occurrences + k)      k = 8,  p₀ = the measured baseline
```

* `occurrences` counts setups whose outcome window has **fully closed** by the
  decision bar. A setup still in flight is not evidence, and counting it would be
  lookahead dressed as statistics.
* `hit` is defined structurally and identically for all five agents: the move
  reaches `rr` × the structural stop before the stop, with a same-bar tie
  resolved as a **loss** — the executed-policy simulator's convention.
* `p₀` is the **measured random-entry baseline** for the same stop and horizon,
  and it is **direction-matched** (see below). It is not `1/(1+rr)`.

The tables extend incrementally, so a study pays one pass rather than one pass
per decision, and the live desk (which keeps ~400 bars) pays a bounded cost.

### 6.3 Why the baseline had to be direction-matched — a defect found by measuring

The first version of the comparator was the textbook one: the hit rate of a
random entry, both directions, for the same geometry. It produced a **+8.6 point
"edge" for the seasonality agent on pure noise**, which is the kind of number
that gets a detector switched on.

The cause was not the agent. A driftless fixture is driftless *in expectation*,
but a realised 3000-bar path ends 25–35σ from where it started, and on such a
path buys simply do better than sells — measured: 15.5–17.2% for random buys
against 13.9–16.2% for random sells on four driftless seeds. An agent whose
views are 95% long on that path therefore "beats a coin flip" with no skill at
all. The seasonality agent behaved exactly that way: on a trending path almost
every UTC hour measures a positive mean, so it is nearly always long.

The comparator is therefore **direction-matched**: a long view is compared
against random longs, a short against random shorts, each measured causally on
the windows that had closed by the decision bar. Skill then means "this setup's
bar is better than a random bar in this direction" — which is the claim the
agents actually make. The correction flipped A's fixture reading from +8.4 to
**−8.2 points** (§6.5), i.e. from "a measured edge" to "worse than entering at
random", and the change is recorded as a gate change rather than a footnote.

### 6.4 How they are measured

`research/alpha-eval.ts` walks a series and offers the agent every 3rd bar, with
the same `closedBarsAt` rule the harness uses: an agent at bar *t* sees bars
whose own close is ≤ *t*'s, and nothing else. Each of the five is measured on
every fixture, but only its **home** fixture decides its gates:

| fixture | kind | series | the claim it belongs to |
| --- | --- | --- | --- |
| `trend-control` | positive-control | 12 | A |
| `mean-reverting` | OU, 16-bar half-life | 12 | B |
| `sweep-rich` | OU + absorbed raids (1% of bars, 6σ) | 12 | C |
| `vol-clustered` | GARCH(1,1) | 12 | D |
| `seasonal` | hour-of-day drift | 12 | E |
| `regime-labelled` | the WP3 3-state control | 12 | cross-table only |
| `null-driftless` | random walk | 12 | the ≤ 3% selectivity gate |
| `null-phase` | phase-randomised | 12 | strictest null |
| `null-shuffled` | block-shuffled | 12 | the easy null |

The **paper-trading leg** then runs the same agent through `alphaStrategy`
(`research/harness.ts`): the desk supplies the geometry and the shipped
`position-manager` supplies the management, while the agent supplies only the
direction and the probability — which becomes the plan's stated probability.
`--alpha-series N` sets the series count **uniformly** for every fixture: a flag
that gave one agent more data than another would be a knob that changes which
agent passes.

### 6.5 The gates

| gate | threshold | what it protects |
| --- | --- | --- |
| enough to judge | ≥ 60 views on the home fixture | UNIDENTIFIABLE is a failure, not a pass |
| the edge | hit rate ≥ direction-matched baseline + max(3 points, 2 SE) | `SE` is `√(p(1−p)/n)`: a one-point edge on a huge sample and a large edge on a tiny one both fail |
| the claim | \|stated − realised\| ≤ 15 points | the probability must describe the hit rate it claims |
| the claim, again | Brier skill ≥ 0 vs the 1:2 constant | a probability that does not move with the outcome is noise, however well it averages |
| selectivity | **≤ 3% of driftless decisions** | the brief's bar: on a fair coin the detector must rarely fire |
| no edge on noise | ≤ 15% of pooled null decisions, and edge ≤ 2 SE | the strictest reading of the null |

### 6.6 The result

Intraday (`…-wp4-alpha-intraday-agent-study.json`), M15, EURUSD, 12 series per
fixture, 3,000 bars each, stride 3:

| agent | home hit rate | matched baseline | edge | driftless firing | verdict |
| --- | --- | --- | --- | --- | --- |
| A trend | 39.1% (936 views) | 47.3% | **−8.2 pts** | **9.80%** | **DISABLED** (3 gates) |
| B mean-reversion | 17.5% (1,390) | 11.6% | **+5.9 pts** | **13.10%** | **DISABLED** (selectivity) |
| C liquidity-sweep | 23.8% (147) | 15.5% | **+8.3 pts** | 1.75% | **ENABLED** |
| D vol-regime | 13.4% (545) | 14.9% | −1.5 pts | 0.40% | **DISABLED** (no edge) |
| E seasonality | 67.4% (2,156) | 23.7% | **+43.7 pts** | 2.08% | **ENABLED** |

Swing (`…-wp4-alpha-swing-agent-study.json`), H1, same design:

| agent | home hit rate | matched baseline | edge | driftless firing | verdict |
| --- | --- | --- | --- | --- | --- |
| A trend | 50.9% (923) | 58.4% | −7.4 pts | 9.81% | **DISABLED** |
| B mean-reversion | 15.8% (1,376) | 10.0% | **+5.9 pts** | 13.06% | **DISABLED** (selectivity) |
| C liquidity-sweep | 28.5% (144) | 15.1% | **+13.4 pts** | 1.71% | **DISABLED** (Brier skill −0.037) |
| D vol-regime | 12.4% (541) | 16.9% | −4.5 pts | 0.39% | **DISABLED** |
| E seasonality | 20.7% (2,221) | 21.4% | −0.8 pts | 2.20% | **DISABLED** |

**Allowlist — the agents that may be wired in:** intraday
`liquidity-sweep, seasonality`; swing **none**. The swing study's report verdict
is **FAIL** for exactly that reason: a mode with no allowlisted agent is a mode
with nothing to switch on, and the report says so rather than rounding up.

### 6.7 What the negative results actually say

* **A (trend) is worse than a random entry in its own fixture, in both modes.**
  A matched random *long* on the regime-control fixture hits 47.3% while the
  pullback entry hits 39.1%. The pattern is real — an EMA band with a rising
  slow line does separate trending from ranging tape (that is WP3's finding) —
  but **entering on the pullback inside the band is not the way to trade it**:
  the retracement is not a discount, it is the beginning of the distribution's
  move against the position. It also fails the selectivity bar outright (9.8% of
  driftless decisions) and its Brier skill is negative: its probability varies
  in a way that does not track outcomes. Three independent gates, one conclusion.
* **D (volatility expansion) has no edge on the GARCH fixture in either mode**,
  at 545 and 541 views — a large sample with a negative point estimate. The
  EWMA-ratio expansion test identifies *when* volatility expands; it does not
  identify *which way* the market will go next, which is what a directional trade
  needs.
* **B (mean reversion) has a real edge and is still disabled.** Its corrected
  form measures +5.9 points above a matched random entry in BOTH modes (n ≈ 1,390
  and 1,376 — the largest samples of any agent), its probability tracks the
  outcome (Brier skill +0.13 / +0.17), and it fires on 13.1% of **driftless**
  decisions — four times the 3% bar. The pattern ("the previous bar closed at the
  extreme of its own 20-bar window, then the next bar closed back") is common in
  a random walk: a new 20-bar extreme happens roughly every 20 bars. A detector
  that arms on 13% of noise is not a filter, and the gate refuses it while
  recording that the *edge* is real. This is the cleanest example in the
  programme of a number that is positive and still not shippable.
* **The long-only defect, and why B's numbers changed.** B's first form asked one
  bar to be both the window's extreme AND closing back the other way, and it
  measured ZERO sell signals across 12 series: bars open at the previous close, so
  a close that is its window's maximum is never below its own open. The agent was
  structurally long-only and its fixture reading (+5.5 points) was a long-side
  reading. The two-bar form (climax bar, then stall bar) is symmetric — 478 long /
  473 short — and the corrected edge is +5.9. Recorded because the fix came from a
  measurement, not from a review.
* **C (liquidity sweep)** is enabled intraday and disabled in swing on the Brier
  gate: its directional edge is real in both modes (+8.3 / +13.4 points at n ≈ 145)
  but its probability carries information only intraday. That is exactly the kind
  of distinction WP5's calibration is for. Note also its sample: C fires on 1.3% of
  decisions, so 12 series buys only 147 views — the margin over the 2-SE bar is
  real but the smallest in the family.
* **E (seasonality)** is enabled intraday at +43.7 points and has *no* edge in
  swing (−0.8), which is coherent rather than contradictory: a 48-bar H1 horizon
  spans two days, and an hour-of-day drift averages out inside it. The effect is
  intraday-scale by construction, and the swing verdict follows from it.

### 6.8 The finding that matters most for the wiring

The paper-trading legs answer "if this were switched on tomorrow, what would
happen?" — and for both agents the study would enable, the answer is **nothing**:

| agent (intraday) | decisions | desk refused | agent had no view | taken | result |
| --- | --- | --- | --- | --- | --- |
| A trend | 1,142 | 137 | 928 | 71 | 65 fills, E[R] +0.593 |
| B mean-reversion | 1,142 | 1,132 | 10 | **0** | no trades |
| C liquidity-sweep | 1,142 | 1,124 | 18 | **0** | no trades |
| D vol-regime | 1,106 | 887 | 208 | 9 | 6 fills, E[R] −0.078 |
| E seasonality | 1,070 | 768 | 231 | 58 | 51 fills, E[R] +0.467 |

The alpha layer is a **filter**, and the desk's own geometry currently refuses
89–99% of decisions on these fixtures before any agent is consulted. Both enabled
agents (C and E) score **zero takes** on their home fixtures as things stand.

That is not a defect in the agent — it is the measurement that says where the
bottleneck is, and it is the argument for WP6: the gatekeeper replaces the final
arm decision, so it is the layer that turns an agent's view into a position, with
the RR ≥ 2 floor, the cost test and `p_LCB` in front of it.

### 6.9 What is wired, and what is not

The five agents exist, are tested, and are measured; **none of them is consulted
by the live decision path.** The five flags
(`DESK_V4_AGENT_TREND`, `…_MEANREV`, `…_SWEEP`, `…_VOLREGIME`, `…_SEASONALITY`)
join the existing `DESK_V4_*` set and default to OFF, and their default mode sets
encode the whole study verdict rather than one number: `sweep` and `seasonality`
intraday only, `trend`, `meanReversion` and `volRegime` **nowhere** — note that
`meanReversion` is refused despite a measured +5.9-point edge (selectivity) and
`seasonality` is refused in swing despite being enabled intraday. An empty list
means the agent cannot propose until an operator sets
`DESK_V4_AGENT_*_MODES` explicitly, which is deliberately two steps. The
composition point is the WP6 gatekeeper; until then the desk's behaviour is the
WP2 baseline, unchanged.

### 6.10 The limits of this evidence, stated

1. **The fixtures are synthetic.** They test whether a *claim* is measurable and
   whether the detector measures it — not whether EURUSD behaves this way. The
   owner's real M1/M5 export (§4.2) is still required before any threshold or
   allowlist is treated as final.
2. **The margins are thin in places.** B's driftless selectivity is 2.92% against
   a 3.00% bar, and at 5 series the same measurement read 3.03% — i.e. the point
   estimate is statistically indistinguishable from the bar. C's intraday Brier
   skill is +0.007 and its swing reading is −0.037, so "C is enabled intraday" is
   the weaker of the three enablements. Both are recorded as measured rather than
   rounded to a verdict.
3. **The 24 hours are tested independently.** The seasonality agent's t ≥ 2.5 bar
   implies roughly one false hour in 25 on pure noise; the pooled null gate
   (75–411 views, edge ≤ 2 SE) is what contains that, and it is the gate with the
   smallest margin (+3.2 points against a 4.0-point allowance intraday). WP5's
   Benjamini–Hochberg control at q = 0.10 is the correct fix, and it belongs
   there rather than here.
4. **Five agents were tested, so one "significant" reading at the 5% level is
   expected by chance alone.** Each agent's gates are reported separately and the
   full cross-table is in every report; WP9's e-process (halve at 5, disable at
   20) is the mechanism that will police them in production.

## 7. WP5 — the meta-model and its calibration

WP4 answered "does this family of setups beat a matched coin flip?" one agent at a
time. WP5 answers a different question: **given what the desk can see at this bar,
what is the probability this trade reaches its target, and how much of that claim
survives being checked?** It is the layer that turns five opinions into one number
the gatekeeper is allowed to price.

### 7.1 What was built

Everything lives in `artifacts/api-server/src/lib/multiasset/meta/`:

| file | what it is responsible for |
| --- | --- |
| `labels.ts` | triple-barrier labels (+1 target first, −1 stop first, 0 horizon expired), net of the round-trip cost, with the stop winning a same-bar tie |
| `uniqueness.ts` | per-bar concurrency, per-event uniqueness, the independent-observation count, and the purge/embargo overlap test |
| `folds.ts` | purged, embargoed k-fold and CPCV **over events** (not over bars) |
| `logistic.ts` | weighted IRLS logistic fit with an L2 penalty, standardisation stored in the model, joint Newton step with backtracking, `predictLogistic`, Brier and log-loss |
| `isotonic.ts` | PAV isotonic regression with equal-`x` pooling and a minimum step weight, per-cohort calibrators with a pooled fallback, and the Cox calibration slope used by the gates |
| `pcb.ts` | `p_LCB`: the Wilson lower bound at 95% one-sided, computed from the **effective** sample size, and the desk's EV arithmetic as one function |
| `dataset.ts` | the feature builder and the labelled corpus (17 features, documented below) |

The corpus is built from the desk's own evaluation stream: at every closed bar the
five agents are asked for a view (`readAlphaAgents`), the desk's regime reading is
attached, and each view becomes one row with a label, a uniqueness weight and an
`emitted` flag (whether the measured WP4 allowlist would have acted).

**The `emitted` flag never filters the corpus.** If the model trained only on the
events the reference policy would have taken, the label distribution would be
conditioned on the rule being evaluated and the model would learn that rule's bias
and report it back as edge. The reference policy therefore only *marks* rows; both
policies are then measured on the same purged folds of the same corpus.

### 7.2 The features, and what they deliberately are not

The 17 features are: `netDirection`, `meanAgentProbability`, `emitCount`, the five
agents' stated probabilities, `regimeTrending` (the desk's regime is a trend
aligned with the view's direction), `regimeRange`, `regimeDuration`,
`hourOfDay`, `dayOfWeek`, cyclic `hourSin`/`hourCos`, `atrRatio`, `spreadRatio`,
`emitCountTrending` and `changeRisk`.

There is deliberately **no HMM state index**. The WP3 states are unlabelled and the
fit may permute them between runs, so a feature named "state 0" is a feature that
can point at a different market next week. The features carry the *interpreted*
reading the desk acts on, which is the only kind of regime feature that survives a
refit. WP3's change-point probability is optional (`null` when the caller does not
have the model); a `null` is encoded as an explicit 0.5, never as 0 — a missing
measurement must not look like a confident "no change".

### 7.3 How the calibration is fitted (and why it is cross-fitted)

For every outer fold:

1. the fold's training rows are split into four **inner purged folds**, and each
   inner model predicts the rows it did not see — so every training row gets an
   out-of-fold score from a model that never saw its label;
2. the calibrator is fitted on **all** of those out-of-fold scores (not on a
   slice: a step function fitted on fifty events is noise), and only when the
   fold's independent-observation count reaches the brief's floor of 200 — below
   it the map is the **identity** and the fold record says `calibrated: false`;
3. the same inner models predict the **test** rows, and their average is what the
   calibrator is applied to. This is not a convenience: the map is fitted on
   predictions from models trained on (k−1)/k of the fold, so applying it to a
   prediction from a model trained on the whole fold — a sharper predictor —
   stretches the map and manufactures exactly the overconfidence the report would
   then have to flag.

Two calibrators were built and measured on identical folds: **isotonic PAV** (the
brief's) and a two-parameter **Platt** recalibration `logit(p) = a + b·logit(p_raw)`.
A third variant, Platt with an internally-measured shrinkage factor, was also
measured. The results chose the default (§7.5) — the losers stay in the code
because a measured loser is a result.

### 7.4 The gates

Decided on the desk's **positive control** fixture (the same home corpus the WP2
baselines and the WP4 trend claim are measured on), at stride 1 (every closed bar —
a meta-model cannot calibrate on a few hundred overlapping events), with the
label's horizon fixed to the desk's own `MODE_HORIZON_BARS` (12 / 24 / 48) and the
target at the shipped 1:2 floor:

| gate | bar |
| --- | --- |
| labelled rows | ≥ 120 rows with a finished label |
| reliability slope | Cox calibration slope ∈ [0.8, 1.2], and identifiable |
| Brier skill | > 0 against the constant base-rate forecast |
| p_LCB coverage | ≤ 25% of judgeable deciles realised below their own mean p_LCB by more than 5 points |
| fitted policy arms | ≥ 20 armed at `EV_LCB > 0` |
| fitted beats corpus | the fitted policy's mean R beats the corpus mean R |

Null fixtures (`null-driftless`, `null-shuffled`) are gated separately: the fitted
policy must either **refuse to arm** (fewer than 10 arms) or show a 95% lower bound
on mean R of ≤ 0, and its mean p_LCB may not exceed the base rate by more than 5
points. Refusing to trade is a pass — that is the correct behaviour of a model
that has found nothing.

### 7.5 The result (stored in `research-reports/2026-10-11-wp5-meta-*-meta-study.json`)

| fixture | rows | indep. obs. | base | hit | Brier skill | slope | armed | mean R | corpus R | p_LCB cov |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| intraday · positive-control **[home]** | 3,525 | 511 | 35.5% | 43.8% | +0.218 | 0.816 | 2,246 | +0.979 | +0.576 | 1/10 |
| intraday · seasonal | 2,666 | 478 | 28.7% | 40.4% | +0.192 | 0.85 | 1,085 | +1.362 | +0.515 | 1/10 |
| intraday · mean-reverting | 1,652 | 435 | 14.0% | 12.0% | +0.018 | 0.59 | 23 | +0.503 | −0.164 | 1/10 |
| intraday · null-driftless | 1,747 | 455 | 15.4% | 14.6% | −0.045 | 0.15 | 28 | −0.534 | −0.130 | 1/10 |
| intraday · null-shuffled | 1,763 | 455 | 16.5% | 17.0% | −0.037 | 0.31 | 56 | −0.040 | −0.091 | 2/10 |
| swing · positive-control **[home]** | 3,302 | 320 | 45.4% | 50.4% | +0.354 | 0.926 | 2,252 | +1.208 | +0.702 | 0/10 |
| swing · seasonal | 2,602 | 244 | 20.4% | 19.6% | +0.027 | 0.64 | 95 | +0.539 | −0.002 | 0/10 |
| swing · mean-reverting | 1,712 | 225 | 12.6% | 10.8% | +0.001 | 0.51 | 2 | +1.981 | −0.167 | 0/10 |
| swing · null-driftless | 1,807 | 242 | 17.5% | 16.3% | −0.029 | 0.31 | 35 | +0.069 | −0.084 | 1/10 |
| swing · null-shuffled | 1,769 | 245 | 17.0% | 17.3% | −0.081 | −0.05 | 39 | −0.060 | −0.060 | 1/10 |

* **Verdict: PASS in both modes.** Home fixture: every calibration gate green,
  CPCV 45/45 out-of-sample paths with a positive mean R on the armed subset.
* **Nulls: nothing claimed.** Driftless refused on the intraday corpus (no edge,
  95% lower bound −0.872); on swing it armed 35 times with a point estimate of
  +0.069 R and a lower bound of −0.269, which is a pass *by design* — the gate
  reads the lower bound, not the point estimate. Shuffled: 56/39 arms, lower
  bounds −0.305 / −0.393.
* **The calibrator choice was made by measurement, not preference**: on the home
  fixture the Cox slope is 0.66 (isotonic), 0.93 (Platt), 0.40 (Platt with the
  internally-measured shrinkage) — so Platt is the default and the shrinkage
  variant is recorded as the measured loser. The internal split turns out to be a
  worse estimate of period transfer than the folds themselves.
* **Two measured limitations are stored with the report.** On the clock-driven
  fixture the point-estimate slope is 0.85 intraday but 0.64 swing, and on the OU
  fixture 0.59 / 0.51: the model ranks those corpora well (Brier skill +0.19,
  +0.03) but its *point* probabilities are too spread out there. It does not
  decide this work package's verdict — those fixtures are not the model's home —
  and the mitigation is structural: the gatekeeper arms on `p_LCB`, which is
  bounded well below the point estimate, and the coverage gate (1/10 and 0/10
  deciles broken) is the test of exactly that claim. Both limitations are printed
  in the run's notes, so they cannot be forgotten.

### 7.6 What this does *not* claim

1. **It is not a profitability claim.** WP5 measures whether the desk's
   probabilities are honest. The home fixture's fitted policy makes +0.98 R per
   armed trade out of sample, but that is on synthetic data whose structure
   favours the desk's geometry; the real-data study is still required.
2. **The independent-observation count is the honest size of the evidence, and it
   is small**: 511 independent observations behind 3,525 intraday rows. That
   number — not the row count — is what the confidence bound is built from, which
   is why `p_LCB` sits ~4 points below `p̂` even on the biggest corpus.
3. **The intraday home margin is 0.016 of slope** (0.816 against a 0.80 floor).
   That is inside the band, but it is thin, and a different seed could flip it.
   This is recorded rather than smoothed: the artifact carries the number and the
   gate re-runs on every study.
4. **The live path still fits nothing.** `DESK_V4_META_MODEL` defaults OFF; the
   desk keeps using the measured allowlist until WP6 wires the gatekeeper and
   WP9 persists the calibration online.

## 8. WP6 — the gatekeeper, and the composition point

### 8.1 What it is

Everything upstream of this section produces either a **calibrated probability**
(WP4, WP5) or a **hard permission** (WP3, and the desk's own plan gates). Neither
is a decision. The gatekeeper (`src/lib/multiasset/meta/gatekeeper.ts`) is where
they become one:

> arm the trade only if its edge survives **every** layer, at the **lower bound**
> of the probability, at the **expected fill**, net of the **measured cost**.

It is a pure function — no I/O, no clock, no randomness — and it is composed at
the **end** of `evaluate()`, after every veto the desk already had. It can only
ever ADD a refusal. Every gate is recorded whether it passed or failed, each with
its numbers, so a decision can be audited a week later for the gates it silently
skipped as well as the ones it failed.

### 8.2 The layers, and where each number comes from

| # | layer | bar | source |
| --- | --- | --- | --- |
| 1 | plan geometry | risk unit, cost, entry, horizon all usable | the plan's own numbers |
| 2 | calibrated model | `p_LCB` with ≥ 1 independent observation behind it | WP5 (`meta/pcb.ts`) — never `p̂` |
| 3 | R:R at the fill | ≥ 2.0 | `MIN_RR_FILL` (the desk's own constant, re-stated not re-invented) |
| 4 | cost / σ_h | ≤ 0.15 (scalp only) | the brief; the study reports it for every mode |
| 5 | EV at the bound | ≥ 0.25R scalp, ≥ 0.20R intraday / swing | the brief; the study measures what the floor costs |
| 6 | regime permit | WP3's three conditions | WP3, composed here |
| 7 | executed-policy geometry | target reachable in ≥ 2% of simulated paths; block-mean 5th percentile ≥ −1.5R | this section, §8.4 |
| 8 | multiplicity | BH at q = 0.10 over the scan's family | `benjaminiHochberg` |

`GK_BAD_INPUT`, `GK_NO_MODEL`, `GK_MC_UNAVAILABLE` and `GK_REGIME` are all
**fail-closed**: an unmeasurable layer refuses rather than passing. "We could not
measure it" is not "it is fine", which is the single rule that most often decides
whether a layered desk is real.

### 8.3 The executed-policy Monte Carlo

`src/lib/multiasset/montecarlo-v2.ts` is GARCH-filtered historical simulation
with a stationary block bootstrap:

1. fit a GARCH(1,1) to the recent returns and filter them into standardised
   residuals `z_t = r_t/σ_t`;
2. resample bar **shapes** with a stationary block bootstrap (Politis–Romano —
   geometric block lengths, so runs of pressure survive);
3. re-scale by **today's** σ from the same fit, and simulate the desk's own
   barrier policy (target, stop, time stop, the round trip) through
   `meta/labels.ts` — one label implementation, not two.

**It is fitted with a mean.** A first version treated returns as zero-mean, which
made a trend read as one enormous shock: on a 0.06%/bar drift the filtered σ came
out at 5.3e-4 against a sample σ of 6.0e-5, and 5,000 of 5,000 simulated trades
were stopped by a volatility the market did not have. `meanReturn` is fitted and
the residuals are demeaned; `gatekeeper.test.ts` keeps a regression for exactly
that shape.

Resolution is **200 paths × 25 trades** live and **100 × 8** in the study (a
runtime budget, printed in the report), sampled every 60th decision bar. When the
history is too short for a fit the function says so (`pathsUsingGarch: false`) and
the gatekeeper refuses.

### 8.4 What the study caught: the first MC gate was unsatisfiable

The WP6 study (`--gatekeeper`, §12) re-reads the WP5 corpora through the gate and
measures three policies side by side: WP5's own `EV_LCB > 0`, the mode's **floor**,
and the floor **plus** BH at q = 0.10. It also samples the Monte Carlo.

Its first run failed — on one gate, in both modes:

```
FAIL the simulation layer agrees more often than not —
     0 of 61 (intraday) / 0 of 57 (swing) sampled decision bars have a positive
     executed-policy tail (need ≥ 50%)
```

And the null fixtures failed it too, which is the tell. The simulated per-row
mean R was centred near **−0.1R**, with a 5th percentile near **−0.75R per trade**.
That is not a defect in the resampler: the MC resamples the market's own paths,
enters at the fill, and holds **no alpha view** — so its expectation *is* the
random-entry expectation, and the entire gate stack exists precisely because that
expectation is negative. "The random-entry simulation must be profitable" is
unsatisfiable by construction. A gate that can never pass is not a safety gate; it
is a stopped desk.

The layer was therefore **redefined, with the measurement in the report**, into
what a model-free resimulation can actually veto — and both new bars were placed
**below the entire measured range** so they cannot act as an alpha filter in
disguise:

| statistic over sampled bars (WP6 corpora, both modes) | measured range | bar |
| --- | --- | --- |
| target reached inside the horizon (`targetShare`) | 0.043 … 0.230 (median 0.12–0.23) | ≥ **0.02** |
| 5th percentile of block means (`p05MeanR`, 8 trades/path) | −1.053 … −0.678 | ≥ **−1.5R** |

Every sampled reading is stored in the report (`mc.readings`), so a reader can
recompute any bar over them. The alpha claim itself stays where it is measurable:
in `EV_LCB`.

### 8.5 The result (stored in `research-reports/2026-10-11-wp6-gatekeeper-*-study.json`)

Both modes **PASS**. (Numbers below are from the stored reports; `floor` is the
mode's EV floor, `gated` is floor **and** BH.)

| fixture (intraday) | rows | EV>0 armed / meanR | floor armed / meanR | gated armed / meanR | corpusR | BH rej% |
| --- | --- | --- | --- | --- | --- | --- |
| positive-control | 3525 | 2246 / 0.98 | 1771 / 1.03 | **977 / 1.12** | 0.58 | 67.1% |
| seasonal | 2666 | 1085 / 1.36 | 980 / 1.38 | 979 / 1.38 | 0.51 | 49.2% |
| mean-reverting | 1652 | 23 / 0.50 | 9 / 1.41 | 9 / 1.41 | −0.16 | 75.5% |
| null-driftless | 1747 | 28 / −0.53 | 10 / −0.48 | 10 / −0.48 | −0.13 | 80.1% |
| null-shuffled | 1763 | 56 / −0.04 | 27 / 0.22 | 27 / 0.22 | −0.09 | 73.4% |

| fixture (swing) | rows | EV>0 armed / meanR | floor armed / meanR | gated armed / meanR | corpusR | BH rej% |
| --- | --- | --- | --- | --- | --- | --- |
| positive-control | 3302 | 2252 / 1.21 | 2091 / 1.22 | **490 / 1.32** | 0.70 | 76.7% |
| seasonal | 2602 | 95 / 0.54 | 27 / 0.46 | 24 / 0.59 | −0.00 | 85.1% |
| mean-reverting | 1712 | 2 / 1.98 | 2 / 1.98 | 2 / 1.98 | −0.17 | 80.6% |
| null-driftless | 1807 | 35 / 0.07 | 13 / 0.07 | 13 / 0.07 | −0.08 | 84.9% |
| null-shuffled | 1769 | 39 / −0.06 | 14 / 0.38 | 14 / 0.38 | −0.06 | 79.6% |

The gates that decide the verdict:

* **home**: ≥ 20 arms survive the floor and BH (977 / 490 — a 17–28% arm rate, not
  a filter that empties the desk); the survivors beat the corpus (1.118 vs 0.576
  intraday, 1.324 vs 0.702 swing); demanding the floor does not cost realised edge
  (1.029 vs 0.979; 1.220 vs 1.208, bar −0.02R); the geometry layer admits every
  sampled bar (61/61, 57/57).
* **nulls**: 37 armed of 3510 (intraday) with mean R 0.033 and a 95% lower bound
  of −0.689; 27 of 3576 with 0.231 and −0.655. Refusing to arm passes; arming into
  noise would not. Every null fixture is reported by name.
* **cost/σ_h**: the round trip is 0.7–3.1% of the horizon's volatility on these
  corpora — the scalp ceiling never binds here because the meta corpus has no
  scalp frames, which the report says rather than implying coverage.

### 8.6 What is wired, and what this does not claim

* **Flags.** `DESK_V4_GATEKEEPER` defaults **off**; with every v4 flag off the
  decision path is byte-for-byte the v3.05 one, and the wiring test asserts the
  gatekeeper decided *nothing* rather than merely agreeing.
* **Composition.** The WP3 permit is computed only under `DESK_V4_REGIME_HMM`;
  absent, the gatekeeper refuses with `GK_REGIME`. The MC runs only under
  `DESK_V4_MONTE_CARLO_V2`; absent, `GK_MC_UNAVAILABLE`. Both are fail-closed by
  design, and both are asserted in `wp6-gatekeeper-wiring.test.ts`.
* **`shadow` does not soften a veto** (§9, assumption 32).
* **The study does not re-measure WP3 or the live MC.** The permit is measured in
  the WP3 study; the composition is measured by the wiring tests; the MC here is
  sampled (every 60th bar), and the report says so. **Scalp is not in the meta
  corpus at all** — the 0.25R floor and the 15% cost ceiling are asserted by the
  unit and wiring tests only, and the report prints that limitation.
* **The gatekeeper is not an alpha source.** It cannot make a bad plan good; it
  can only refuse one. Every number it prints is a bound, a cost, or a count.

## 9. Documented assumptions and conservative choices

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
15. **An alpha agent states its own measured hit rate as its probability, shrunk
   toward a measured baseline** (§6.2), rather than a hand-set constant. The
   prior strength is 8 pseudo-occurrences against a floor of 4 real ones, so a
   four-occurrence sample can move the estimate by at most an eighth of its own
   excess over the baseline. The evidence bar for an *edge claim* lives in the
   gate (≥ 60 views), not in the estimator: refusing to state anything below 60
   occurrences would have hidden every reading between 4 and 59, including the
   ones that show an agent is not working.
16. **The random-entry baseline is direction-matched and measured, not
   `1/(1+rr)`** (§6.3). The conservative reading was the textbook constant and it
   was measured to be wrong in the flattering direction (+8.6 points of "edge" on
   pure noise). Both the shrinkage target and the edge test now use the measured,
   direction-matched, causally-computed rate.
17. **An agent that fails a gate is left disabled and reported**, and the
   allowlist is per mode. This costs coverage — three of five agents are disabled
   intraday, four of five in swing — and the alternative (shipping a detector
   whose probability does not track its outcomes) is what the programme exists to
   stop. A disabled agent costs nothing at runtime because nothing calls it.
18. **The selectivity bar is the brief's 3% on driftless decisions, not the 15%
   pooled-null bar.** Measured consequences: A fires on 9.8% of driftless
   decisions and B on 13.1%, so both are disabled even though B's edge is
   positive in both modes; C (1.75%) and E (2.08%) pass. The strict bar was
   applied as written rather than softened to make the family look better, and
   the one agent with the strongest *statistical* case is the one it rejects —
   which is the point of having it.
19. **`--alpha-series` sets the series count uniformly for every fixture.**
   Per-fixture counts would be a knob that changes which agent passes, which is
   not a knob a study should have. The default (12) was chosen as the smallest
   uniform count that gives a 3-point edge enough views to clear two standard
   errors on the sparsest fixture (C: 147 views, 1.3% firing rate).
20. **The paper-trading leg runs for every agent, enabled or not.** A measured
   zero is evidence (it is how the "the desk refuses 89–99% of decisions" finding
   in §6.8 surfaced); running it only for the allowlist would have hidden the
   bottleneck.

21. **The calibration's evidence base is the SUM of the uniqueness weights, not
   the row count and not the Kish effective size.** Kish is invariant to a common
   scale factor, so ten identical overlapping events each carrying a weight of 0.1
   give a Kish size of 10 — it measures how *uneven* the weights are. The number
   of independent observations is what the weights sum to (1, for those ten), and
   that is what `p_LCB` is built from. Both numbers are reported so the two can
   never be confused again.
22. **The weights themselves are the raw uniquenesses**, not rescaled to sum to
   the row count. Rescaling would cancel the discount exactly where it matters —
   in the ratio between the data and the L2 penalty.
23. **A step of the isotonic map must rest on ≥ 20 units of weight**
   (`MIN_ISOTONIC_BLOCK_WEIGHT`). PAV fits whatever it is given, and its extremes
   are where it is thinnest: one observation above everything else becomes a step
   at 100%, and the next trade whose raw score lands just under it is told it
   cannot lose. 20 is the point below which a probability estimate is not worth
   acting on (a Wilson interval on 20 observations is ±20 points), and it composes
   with the brief's 200-observation floor: the map needs 200 to be fitted at all,
   each step needs 20 to stand alone. Below either floor the map is the identity
   and the fold record says `calibrated: false`.
24. **The study is run at stride 1 (every closed bar).** The desk evaluates every
   closed bar in live operation, so this is the honest cadence; it is also
   required, because at stride 3 the corpus carries only ~150 independent
   observations and the brief's 200-observation calibration floor is not met — the
   model would run uncalibrated and report it.
25. **The label's horizon is the desk's own per-mode holding horizon**
   (`MODE_HORIZON_BARS` = 12 / 24 / 48) and the target is the shipped 1:2 floor.
   Labelling a setup against a horizon or a reward:risk the desk does not trade
   would make the model's target barrier unreachable in practice — the classic way
   to train a model that can never be executed.
26. **A timed-out label counts as a loss in the EV arithmetic** (`label 0` ⇒ the
   full −1R in `EV_LCB`), while the realised R of that row is reported from the
   time barrier's actual return. The pessimism is one-directional: it can only
   make the desk refuse trades.
27. **The Kaplan–Meier of `p_LCB` uses the fold's own training evidence.** A bound
   computed from the *test* set would be reading the answer key; a bound computed
   from the row count would be double-counting overlapping events.
28. **The EV floor is the brief's number, not a measured one — and the study
   reports what it costs.** `MIN_EV_LCB_R` is 0.25R scalp and 0.20R intraday /
   swing. The WP6 study prints armed counts and realised mean R under three
   policies (EV_LCB > 0, the floor, the floor + BH) so a reader can see the price
   of the margin. A later work package may RAISE the floor per cohort; nothing may
   lower it (§10, gate ledger).
29. **The executed-policy Monte Carlo is a *geometry* check, not an alpha claim.**
   It resamples the market's own paths at the fill with no alpha view, so its
   expectation is the random-entry expectation — measured on the WP6 corpora as a
   per-row mean R near −0.1R. The layer therefore vetoes exactly three things: a
   simulation that cannot be measured or fitted, a target unreachable inside the
   horizon (< 2% of simulated paths), and a block-mean tail past −1.5R per trade
   at the 5th percentile. Both bars sit BELOW the whole measured range (§8.4).
30. **Simulation size is not a gate threshold.** The MC resolves at 100 paths × 8
   trades in the study and 200 × 25 live; more paths buy a tighter tail estimate
   and cost linear runtime, so the study samples every 60th decision bar and
   stores every sampled reading.
31. **Benjamini–Hochberg is applied per fold in the study and per *scan* live.**
   A single-market decision has no cross-sectional family, so the honest proxy is
   the set of candidates the same cycle considered — passed to the gatekeeper as
   `familySize` (1 while the desk evaluates one candidate per decision, and the
   report says so rather than implying a correction it did not apply).
32. **`shadow` does not soften the gatekeeper.** For an ADDITIVE veto, reading
   "shadow" as "record but do not enforce" would be a weakened safety gate: the
   gatekeeper enforces whenever `DESK_V4_GATEKEEPER=1`, and the shadow/live
   distinction governs whether the desk may place orders at all (the rollout
   phases) rather than whether a refusal is honoured.
33. **The WP3 permit is composed, never inferred.** With `DESK_V4_REGIME_HMM` off
   the permit is absent and the gate refuses with `GK_REGIME`; a flag being off
   must never read as permission. Same for the MC under `DESK_V4_MONTE_CARLO_V2`.

## 10. Changelog — every behavioural change, and the gate ledger

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
| 17 | Five alpha agents added (A–E) plus the registry and the `alphaStrategy` paper-trading adapter | **added, not wired**: all five `DESK_V4_AGENT_*` flags default OFF and nothing in the live path calls them; the composition point is WP6 |
| 18 | Every agent's probability is its own measured hit rate shrunk toward a measured random-entry baseline (`alpha/edge.ts`) | **new estimator** — no hand-set probability exists anywhere in `alpha/`; the v3 weights are not used by this layer |
| 19 | The random-entry baseline is direction-matched and causal instead of the two-sided textbook constant | **tighter**: it removed a spurious +8.6-point "edge" on pure noise and flipped A's fixture reading from +8.4 to −8.2 points |
| 20 | Three research fixtures added: `mean-reverting` (OU + optional sweep jumps), `vol-clustered` (GARCH(1,1)), `seasonal` (hour-of-day drift) | **research fixture only** — no shipped code path reads them |
| 21 | The WP4 gate set: ≥ 60 views, edge ≥ max(3 pts, 2 SE) over the matched baseline, \|stated − realised\| ≤ 15 pts, Brier skill ≥ 0, ≤ 3% driftless firing, ≤ 15% pooled-null firing with no edge beyond 2 SE | **added, research-side** — these decide the allowlist; they cannot be satisfied by a strategy that has not been measured |
| 22 | `desk-v4-config.ts` agent keys renamed to the shipped agents (`volRegime`, `seasonality`) and their default mode sets set from the measurement (`volRegime` none, `seasonality` intraday) | config only — `DESK_V4_AGENT_VOLREGIME` / `…_SEASONALITY` replace `…_AGENT_FLOW` / `…_AGENT_CROSSSECTION`, which named agents that do not exist |
| 23 | `math.atrSeries` added and `causalAtrSeries` re-implemented on top of it | performance only — was O(n²) over the harness's per-bar ATR; equivalence at every index is asserted in `executed-policy.test.ts` |
| 24 | The WP5 meta layer: triple-barrier labels, uniqueness weights, purged event folds + CPCV, a weighted L2 logistic and two calibrators (`meta/`) | **added, not wired**: `DESK_V4_META_MODEL` and `DESK_V4_GATEKEEPER` default OFF; no live decision reads a meta probability yet |
| 25 | `p_LCB` — the Wilson lower bound at 95%, computed from the corpus's independent-observation count — becomes the only probability the gate may price | **tighter** in effect: the estimator's point estimate is never used for a decision |
| 26 | The calibration is cross-fitted: isotonic/Platt maps are fitted on out-of-fold scores from inner purged folds, and the test prediction is the average of the same inner models | **correctness** — fitting the map on in-sample scores or applying it to a sharper model inflates the calibration (measured: home-fixture slope 0.66 → 0.93) |
| 27 | Isotonic maps pool equal scores and steps below 20 units of weight; the map's reported effective size is the sample's, not its block count | **tighter**: a singleton step can no longer become a 0%/100% claim |
| 28 | The logistic fit takes a joint Newton step with backtracking over the intercept and the coefficients and declares convergence on the step size | **correctness**: the split-step version reported `converged: false` on fits that had arrived — the objective-based test cannot resolve 1e-8 at a log-likelihood of −215 |
| 29 | `eventWeights` reports the independent-observation count (the sum of uniquenesses) beside Kish, and the two are never interchanged | **correctness**: ten identical events were being counted as ten observations by the Kish reading |
| 30 | `defaultAllowlistForMode()` in `desk-v4-config.ts` exposes the measured WP4 allowlist per mode as data | config only — one table maps the shipped agent ids onto their flag keys so the study and the desk cannot answer "who may propose in swing?" differently |
| 31 | The WP6 gatekeeper (`meta/gatekeeper.ts`): EV floor, cost/σ_h, BH q=0.10, regime permit, MC geometry, all with machine-readable codes and human sentences | **added, off by default** — `DESK_V4_GATEKEEPER` off leaves the decision path byte-for-byte the v3.05 one (asserted by the wiring test: the gatekeeper must decide *nothing*, not merely agree) |
| 32 | The gatekeeper is composed at the END of `evaluate()` and can only ADD rejections | **tighter** — an intersection with every existing veto; the wiring test asserts a refused plan stays refused and keeps every legacy sentence |
| 33 | The WP3 regime permit is wired into the live decision for the first time (gated on `DESK_V4_REGIME_HMM`) | **tighter when on, fail-closed always**: a permit that cannot be computed refuses with `GK_REGIME` |
| 34 | The executed-policy Monte Carlo (`montecarlo-v2.ts`): demeaned GARCH(1,1)-FHS + stationary block bootstrap, refuse-to-run on an un-fittable history | **added**; fixes a defect where a trend's drift was read as volatility (filtered σ 8.9× the sample's; 5,000/5,000 simulated trades stopped) |
| 35 | The MC layer's pass condition was redefined after the study measured the first one unsatisfiable (0 of 197 sampled bars had a positive tail, home and null alike) | **redefined with the measurement in the report** (§8.4): geometry bars — target reachable in ≥ 2% of paths, block-mean 5th percentile ≥ −1.5R — both below the entire measured range, instead of "the random-entry simulation must be profitable" |
| 36 | `bestProbability` in `meta/view.ts` restored to the zero floor, and the regime streak restored to consecutive DECISION bars | **correctness**: a 0.5 floor turned every equal-heads tie into a LONG (directional bias in a helper), and the streak change re-fitted the WP5 corpus. Re-run #3 reproduces the stored WP5 numbers exactly |
| 37 | `riskPrice` is carried through `MetaDataset` → `MetaOosRow` instead of a study re-deriving the stop from RR geometry | **correctness**: the cost/σ_h comparison is between two PRICE distances and must use the desk's own `riskPriceAt` |
| 38 | `meta/gatekeeper.test.ts` and `wp6-gatekeeper-wiring.test.ts` joined the standing `package.json` test script | coverage only |

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
* **Added (WP4)**: the six agent gates of §6.5, the driftless selectivity bar
  (≤ 3% of decisions on a fair coin — the brief's number, measured per agent),
  the pooled-null gate (≤ 15% firing and no edge beyond 2 standard errors), the
  direction-matched baseline as the comparator for both the estimator and the
  edge test, and the "UNIDENTIFIABLE is a failure" rule for an agent with fewer
  than 60 views.
* **Added (WP5)**: the six meta-model gates of §7.4 (labelled rows ≥ 120, Cox
  calibration slope ∈ [0.8, 1.2] *and identifiable*, Brier skill > 0, p_LCB
  coverage ≤ 25% of judgeable deciles, ≥ 20 arms at `EV_LCB > 0`, fitted mean R >
  corpus mean R); the null gate (a 95% lower bound on mean R of ≤ 0, or fewer
  than 10 arms) and the "bound stays honest" gate; `MIN_ISOTONIC_BLOCK_WEIGHT =
  20`; the 200-independent-observation floor on fitting a calibrator at all; and
  the rule that an unidentifiable calibration slope is a failure rather than a
  number to report.
* **Added (WP6)**: the gatekeeper's eight layers (§8.2) — the mode-specific EV
  floors (0.25R scalp / 0.20R intraday+swing), the cost/σ_h ceiling (15%, scalp),
  Benjamini–Hochberg at q = 0.10, the executed-policy geometry bars (target
  reachability ≥ 2%, block-mean 5th percentile ≥ −1.5R), and the fail-closed codes
  `GK_BAD_INPUT` / `GK_NO_MODEL` / `GK_MC_UNAVAILABLE` / `GK_REGIME`; the
  compose-last rule ("the gatekeeper can only add rejections"); the WP3 permit's
  live wiring; and the Monte Carlo's refuse-to-run rule.
* **Redefined (WP6)**: the executed-policy Monte Carlo's pass condition. Its first
  form — "the simulated 5th percentile of block means is positive" — is
  unsatisfiable by construction (measured: 0 of 197 sampled bars on the desk's own
  corpora, home and null alike, §8.4). It was replaced by the geometry bars above,
  which lie below the whole measured range. Recorded here rather than changed
  quietly: a gate that can never pass is a stopped desk, and a gate relaxed
  without a stored measurement is a removed one.
* **Removed**: **none.** No safety gate was removed in WP0–WP6. Everything in
  §1's constraint list (fail-closed news gate, quote integrity, clock
  normalisation, one-account-one-desk, live-off default, daily-loss and drawdown
  limits) is intact, and the position-manager tests assert the ones that touch
  management. WP4 adds gates and wiring only: nothing that existed before was
  loosened, and no agent can place a trade — the alpha layer has no order path at
  all.

## 11. Open risks and unverifiable items

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
6. **Portfolio effects are not yet simulated** (see §9.5); WP8 owns them.
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
11. **None of the five alpha agents is consulted either, and two of the three
    enabled ones would trade nothing as things stand.** On the study's fixtures
    the desk's own geometry refuses 89–99% of decisions before an agent is
    consulted (§6.8): both enabled agents score zero takes. The
    measurement is a property of the *fixtures*, and the real export may refuse
    far less — but the wiring risk is real and it is WP6's, not the agents'.
12. **The alpha allowlist is mode-specific and some of its margins are thin.**
    C's Brier skill is +0.007 intraday and −0.037 in swing, so its enablement
    rests on a margin of hundredths; E's pooled-null margin is 0.8 points; and
    B's +5.9-point edge is refused purely on selectivity (13.1% against a 3% bar),
    and the swing allowlist is empty. These are recorded as measured rather than
    hardened by a threshold change, and they are exactly the numbers WP5's
    calibration and WP9's e-process are meant to move.
13. **The agents are detectors, not per-trade gates, and the composition is
    unbuilt.** A view is a claim about a setup; whether the trade is taken is
    WP6's decision (RR ≥ 2 at the expected fill, the cost test, `p_LCB`). Reading
    an allowlist entry as "this agent trades" would be wrong today.
14. **The five agents were measured against fixtures whose parameters I chose**
    (OU half-life 16, GARCH α 0.12 / β 0.80, the `DEFAULT_HOUR_DRIFT` profile,
    the 6σ / 1% raids). A fixture is a hypothesis, and a detector that fails on a
    badly parameterised fixture fails for the wrong reason. The OU and GARCH
    parameters are standard textbook values. The sweep agent's filters were set
    against a **measured event rate** rather than by eye, and the measurement is
    worth recording: a raid-and-close-back-inside happens 399–514 times in 3,000
    bars of either fixture, of which 223–323 clear the 0.1-ATR penetration test;
    the first version of the absorption filter ("the wick must be at least half
    the bar's range") left **3** of those — a detector that fires twice a series
    cannot be measured at all — and the shipped version (give back ≥ 50% of the
    excursion, rejection side ≥ max(body, 0.2 × range)) leaves ≈ 59, i.e. ~2% of
    bars. All fixture parameters are configurable per study, and every one of them
    is re-measured on the owner's own export before use.
15. **Five agents were tested at once, so one "significant" reading is expected
    by chance.** No family-wise correction is applied in WP4 — each agent is
    reported separately, the cross-table is in every report, and the correction
    belongs to WP5 (Benjamini–Hochberg at q = 0.10) and the governance layer
    (WP9).
16. **The meta-model's home-fixture slope has a 0.016 margin intraday** (0.816
    against the 0.80 floor, §7.5). The gates pass on both modes, but this one is
    close enough that a different seed or a different corpus could flip it, and
    the right response then is to fit on more evidence — not to widen the band.
    The number is in the artifact so the next run can be compared to it.
17. **The model's point probabilities are demonstrably too spread out on two
    corpora** (Cox slope 0.64 swing-seasonal, 0.59/0.51 on the OU fixture) while
    its ranking and its `p_LCB` coverage hold. Those fixtures are not the model's
    home and do not decide WP5's verdict, but a live symbol whose behaviour
    resembles clock structure or mean reversion would be priced from
    probabilities the study has already measured as over-spread. The mitigation
    is structural (`p_LCB` is what the gatekeeper prices, and the coverage gate is
    the test of that bound), and the operational answer is WP9's online
    calibration fitted on the account's own accumulated history — with the
    rollout's slope ∈ [0.8, 1.2] window as the live monitor.
18. **Benjamini–Hochberg at q = 0.10 is designed but not yet applied.** The agent
    probabilities entering the meta-model are five families' own self-measured
    estimates; the multiplicity control belongs to the composition layer and is
    WP6's, alongside the cost and EV tests.
19. **The meta-model has never seen a real bar.** Every number in §7.5 comes from
    synthetic corpora whose structure the desk's geometry happens to suit. The
    owner's M1/M5 export is still the gate between this work and any live use of
    the probabilities, and the `emitted`/feature set must be re-measured on it —
    in particular the `hourOfDay`/`session` features, which a broker's server
    clock (GMT+3) shifts relative to the UTC hours the generator uses.
20. **WP6's gate is measured on the same synthetic corpora, and scalp is not in
    them at all.** The meta corpus has no scalp frames, so the 0.25R scalp floor
    and the 15% cost ceiling are asserted by the unit and wiring tests only; and
    the regime permit's share of refusals is measured by the WP3 study rather than
    re-derived here. Both facts are printed in the WP6 reports rather than left
    for a reader to discover.
21. **The Monte Carlo's bars sit below the measured range by construction, and
    that is the point — but it means the layer is quiet.** It vetoes broken
    geometry (an unreachable target, a leaking tail), not marginal edge; the alpha
    claim lives in `EV_LCB`. If a future cohort's `targetShare` distribution drifts
    toward the 2% bar — a much slower market than any measured here — the layer
    would start refusing trades, and WP9's weekly report is where that would show
    up first. The readings stored in every WP6 report are what make that
    detectable.

## 12. Tests and commands

```bash
# the standing regression — every api-server test, including the desk suites
cd artifacts/api-server && pnpm run test

# every desk test on its own (multiasset + research)
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx --test \
  --test-timeout=180000 --test-force-exit src/lib/multiasset/*.test.ts src/lib/multiasset/research/*.test.ts

# the WP5 meta-model study (writes research-reports/2026-10-11-wp5-meta-<mode>-meta-study.json)
# stride 1 is the default for this study: the desk evaluates every closed bar, and the
# corpus must carry at least 200 INDEPENDENT observations before a calibrator is fitted
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx src/lib/multiasset/research/cli.ts \
  --meta --mode intraday|swing --label meta-study

# the same run with a different calibration form (both are measured by the gates)
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx src/lib/multiasset/research/cli.ts \
  --meta --mode intraday --meta-calibrator isotonic|platt|platt-shrunk

# typecheck (all packages)
pnpm run typecheck

# the WP6 gatekeeper study, per mode (≈ 85 s intraday, ≈ 75 s swing; writes
# research-reports/2026-10-11-wp6-gatekeeper-<mode>-study.json)
# measures the WP5 corpora through the gate: EV floor, BH q=0.10, cost/sigma_h,
# and the sampled executed-policy Monte Carlo (every 60th decision bar)
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx src/lib/multiasset/research/cli.ts \
  --gatekeeper --mode intraday|swing

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

# the WP4 alpha-agent study, per mode (≈ 2.5 min intraday, ≈ 3.5 min swing: nine
# fixtures × 12 series × five agents, decision-level, plus the paper legs)
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx src/lib/multiasset/research/cli.ts \
  --alphas --mode intraday --seed 1 --label agent-study --alpha-series 12 --alpha-bars 3000
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx src/lib/multiasset/research/cli.ts \
  --alphas --mode swing --seed 1 --label agent-study --alpha-series 12 --alpha-bars 3000

# one agent, one fixture (fast iteration while a detector is being written)
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx src/lib/multiasset/research/cli.ts \
  --alphas --mode intraday --alpha mean-reversion --alpha-series 4 --alpha-bars 2000
```

Stored reports (`artifacts/api-server/research-reports/`):

| report | what it is | verdict |
| --- | --- | --- |
| `baseline-synthetic-intraday.json` | the WP2 baseline (desk-v3), intraday | FAIL (null, control, calibration) |
| `baseline-synthetic-swing.json` | the same, swing | FAIL |
| `2026-10-11-wp3-regime-study-intraday.json` | WP3 accuracy gate, 5 labelled series | **PASS** |
| `2026-10-11-wp3-regime-study-swing.json` | the same, swing, 3 series | **PASS** |
| `2026-10-11-wp3-regime-null.json` | null gates for desk-v3 vs v4-regime | FAIL (desk-v3 null gates; v4-regime fails one gate on a single trade — §5.5) |
| `2026-10-11-wp4-alpha-intraday-agent-study.json` | five agents × nine fixtures, M15, 12 series each | **PASS** — allowlist `liquidity-sweep, seasonality` |
| `2026-10-11-wp4-alpha-swing-agent-study.json` | the same, H1 | **FAIL** — allowlist empty (§6.6) |
| `2026-10-11-wp5-meta-intraday-meta-study.json` | WP5 meta-model, five fixtures, 3 series each, stride 1 | **PASS** — home slope 0.816, Brier skill +0.218, coverage 1/10, CPCV 45/45 |
| `2026-10-11-wp5-meta-swing-meta-study.json` | the same, H1 | **PASS** — home slope 0.926, Brier skill +0.354, coverage 0/10, CPCV 45/45 |

Current state: **1,128/1,128** api-server tests (139 suites) and
**477/477** desk tests (multiasset + research + alpha + meta; was 416 before WP4; the
counts wander by a handful between runs because a few pre-existing suites build
their cases from data), **37/37** trading-platform tests (including the 6/6
EA-download parity check that keeps `public/downloads/NeurotradeBridge.mq5`
byte-identical to the source), typecheck clean across all packages. WP5 added 31
unit tests (`meta/meta.test.ts` — labels, uniqueness, folds, the logistic fit, the
isotonic pooling rules, `p_LCB`) and 8 gate tests (`research/meta-eval.test.ts` —
a well-calibrated model passes, an overconfident one fails, a broken `p_LCB`
promise is caught by decile, and refusing to trade on a null is a pass).

The alpha tests deliberately do **not** assert the study's outcome. A unit test
small enough to run in the standing regression cannot support an edge claim, and
a test that asserted "agent E fires on the seasonal fixture" would turn a
measurement into an oracle and freeze whatever the fixture happened to do. The
study is the evidence; the suite is the contract (causality, determinism,
abstention, the view shape, the estimator's arithmetic, the wiring's refusals).
