# MT5 Desk v4 — calibrated probabilities, hard permissions

Status: **WP0, WP1 and WP2 complete and verified. WP3+ not started.**
Scope: the multi-asset MT5 Desk only — `artifacts/api-server/src/lib/multiasset/`,
`src/routes/desk.ts`, `src/routes/bridge.ts`, `artifacts/mt5-ea/NeurotradeBridge.mq5`
and its published copy. The Deriv digit / rise-fall engines are explicitly out of
scope and untouched.

This document is the running record of the programme: what changed, why, what is
verified, what is assumed, and what is still open. It is written as the work
happens, so a section marked *pending* means exactly that.

---

## 1. What this programme is for

The v3 desk decides by voting: several indicator families each shout a direction,
the votes are weighted, and the winner becomes a plan whose odds are *simulated*
from a drift-and-volatility model. Two things follow, and both are the reason
this programme exists:

* **The probabilities are not calibrated.** `winProbability` is the output of a
  normal approximation with drift taken as truth. Nothing in the system measures
  whether a plan quoting 62% actually wins 62% of the time. A model that is
  wrong about drift is wrong about everything downstream, and the error is
  invisible because the same model generates the score and the confidence.
* **The "edge" is not measured against costs, out of sample.** Expectancy is
  computed from the same simulated distribution, before spread, commission and
  slippage, on the bars that produced the signal.

The target shape is a layered system in which every component either emits a
**calibrated probability**, a **cost-adjusted expected value**, or a **hard
permission**, and nothing else:

```
regime (WP3)  →  alpha agents A–E (WP4)  →  meta-model + calibration (WP5)
      →  edge gatekeeper + executed-policy MC (WP6)
      →  execution / timing (WP7)  →  portfolio & risk (WP8)
      →  learning & governance (WP9)  →  UI / journal (WP10)
```

Only a measured, out-of-sample, cost-adjusted edge may trade. An agent that
cannot demonstrate one stays disabled — that is a correct outcome, not a
failure of the harness.

**No profitability is claimed or promised.** What this programme promises is
that a trade is only taken when a claim of edge survives measurement, and that
every decision is auditable after the fact.

---

## 2. Standing constraints (binding on every work package)

1. TypeScript strict; no new heavy dependencies; numerical helpers live in-repo.
2. No lookahead, anywhere. Every feature has a prefix-replay test proving the
   value computed at bar *i* is identical whether the series ends at *i* or later.
3. Determinism through `makeRng` — same seed, same numbers, no `Math.random`.
4. Existing safety behaviour is kept. Gates may be added or tightened, never
   weakened. (The one deliberate exception is recorded in §5.)
5. New fields on `AgentDecision` / `ArmedPlan` / `ManagementPlan` are optional;
   existing consumers keep working; the EA version is bumped; the EA-download
   parity test stays green.
6. Every v4 feature sits behind a `DESK_V4_*` flag in one config module,
   defaulting to off / shadow.
7. No threshold is tuned by eye. A number changes because the WP2 harness
   produced a report that says so, and the report is stored with the commit.
8. Each work package ends with the multiasset suite and `pnpm run typecheck`
   green, and its own commit.
9. Ambiguity is resolved conservatively and the assumption is written down here.

---

## 3. Work packages

| # | Package | State |
|---|---|---|
| WP0 | EA hot-fixes + position-manager state machine | **complete, verified** |
| WP1 | Hard invariants in `agent.ts` (1:2 at fill, target search, loss halt) | **complete, verified** |
| WP2 | Research harness + BASELINE report | **complete, verified** (baseline on generated controls — see §9) |
| WP3 | Regime HMM + changepoint detection | not started |
| WP4 | Alpha agents A–E under `multiasset/alpha/` | not started |
| WP5 | Meta-model + calibration | not started |
| WP6 | Edge gatekeeper + montecarlo-v2 (executed-policy MC) | not started |
| WP7 | Execution / timing agent (pending orders, seasonality, slippage ledger) | not started |
| WP8 | Portfolio & risk (Kelly on p_LCB, EWMA + Ledoit–Wolf, heat caps) | not started |
| WP9 | Learning & governance (Drizzle shadow ledgers, e-process breaker) | not started |
| WP10 | UI / journal | not started |

---

## 4. Defects this programme is fixing

| # | Defect | Status |
|---|---|---|
| D1 | The EA lost the management plan at fill; every position degraded to a hard-coded +1.0R break-even | **fixed in WP0** |
| D2 | No RR ≥ 2 guard, and the Monte Carlo target search was an argmax (winner's curse) | **fixed in WP1** |
| D3 | MC treated regime drift as truth, bootstrapped i.i.d., and marked timed-out paths to market | **measured in WP2**, fixed in WP6 |
| D4 | Evidence confidence inflated on noise (~65.6 against a 60–62 bar) | **measured in WP2**, fixed in WP5 |
| D5 | Auto-select had no multiple-testing correction | open — WP5 (the harness now deflates by trial count, so the size of the problem is measurable) |
| D6 | The 5-loss session halt fired on healthy 1:2 systems | **fixed in WP1** (backstop at 10) |
| D7 | Crowded fractal stops, breakout triggers, short TTL, sub-minute bars built from 500 ms quotes | open — WP4 / WP7 |

---

## 5. Changelog of behavioural changes and gates

Every entry states what changed, what it does to real money, and what it costs.

### WP0 — 2026-10-11

* **Management survives the fill (D1).** `ExecutePlan` cleared the plan one line
  after the order was placed, and `ManageOpenPositions()` resolved its rules
  through `FindPlanForSymbol()`, which requires an active plan. After a fill
  there was never a plan, so partials, trailing, the time stop and the guards
  silently did nothing. Rules are now captured onto a per-ticket
  `PositionState` at fill, before the plan is cleared.
  *Effect on money:* the ladder the desk chose is the ladder that runs. This is
  the single largest behavioural change in the programme, because positions were
  previously managed by a constant.
* **State survives a restart.** `NTP4_*` terminal globals; a position with no
  saved state is adopted with conservative defaults and reports that it did so.
  *Effect:* a recompile or terminal restart mid-trade no longer abandons the ladder.
* **The regime-exit latch is explicit.** Initialised `false` at capture (a
  recycled ticket must not flatten a new position on its first tick), persisted
  as `rexit`, settable at runtime via `set_management`, and evaluated inside
  Step 1 *above* the softer time stop.
* **The desk can see what happened.** Management events are queued and drained
  into the sync payload only after a successful sync, so each is delivered
  exactly once, and journalled under kind `management`.
* **Cost of this change:** more messages on the sync path, and one more
  persisted key per open position. No new gate, no new permission.
* **Gate added:** none. WP0 removes a defect.
* **Not flag-gated, deliberately.** `DESK_V4_*` gates new v4 *features*
  (constraint 6). WP0 is a correction to existing behaviour: with the flag off,
  the D1 defect returns and management silently stops running again. A
  defect that loses money cannot be shadowed.

### WP1 — 2026-10-11

* **Gate added, hard: RR ≥ 1:2 at the expected fill.** Measured as
  `|tp − fill| / |fill − sl|` with `fill = trigger ± (slippage + spread/2)`,
  against the *final* stop (`sizing.sl`, after broker stop-level widening), and
  against the final risk unit. A plan below 2.0 is refused, with the arithmetic
  in the rejection reason. The realised ratio is reported as
  `PlanRationale.rewardRiskAtFill` (optional field).
  *Effect on money:* plans are refused that were previously taken — plausibly a
  meaningful fraction of them, since the old floor was applied to the quote and
  the fill is always worse. This is the owner's stated floor and the point of the
  change; the counter-effect is fewer trades, not worse ones.
  *Cost:* opportunity. If the true edge at 1.8R were positive, the desk now
  declines it.
* **Target search cannot propose sub-2R.** `MIN_TARGET_MULTIPLE = 2`,
  `TARGET_MULTIPLES = [2, 2.5, 3]`; 1 and 1.5 are structurally unable to clear a
  1:2 floor after costs, and offering them only encouraged the search to pick a
  target the desk would refuse.
* **One-standard-error rule replaces the argmax.** The chosen multiple is the
  smallest within one standard error of the best, not the best. On driftless
  noise the argmax picked ≥ 3R in 87% of intraday plans: with no edge every
  multiple has the same expectancy, so "the largest" is the winner's curse.
  `MonteCarloResult.expectancyStdError` is now required, because the rule cannot
  be stated without it.
  *Effect on money:* nearer, more attainable targets; fewer winners turning into
  losers while reaching for the tail.
* **The 5-loss session halt becomes a backstop at 10 (D6).** At a 40–45% hit
  rate the median longest losing streak over 300 trades is 8–10, so the old
  threshold ended sessions on books that were working as designed.
  *This is a deliberate loosening of a safety rule, and it is the only one in
  the programme.* It is taken on the owner's explicit instruction. The
  compensating controls are unchanged: the de-escalation ladder still cuts size
  from the first loss and suspends the symbol that lost, and the drawdown-from-
  peak and daily-loss limits — which are statements about money, not about runs
  of coin flips — still halt the desk. WP9 replaces the streak rule with a
  per-agent e-process.
  *Residual risk:* a system that has genuinely broken now loses roughly twice as
  much before the streak rule catches it. The drawdown limit is what bounds that,
  and it should be re-checked against the owner's tolerance in WP8.
* **Not flag-gated, deliberately.** The RR floor is a tightening (permitted by
  constraint 4), and the alternative — a `DESK_V4_MIN_RR` flag defaulting off —
  would mean shipping the fix with the defect still live by default.

### WP2 — 2026-10-11

**The harness.** `multiasset/research/` — a data loader for MT5 bar/tick
exports, a purged-and-embargoed walk-forward engine, an executed-policy
simulator, the null and positive-control generators, the metric set (including
Probabilistic and Deflated Sharpe, and PBO via CSCV), a report writer, and a
CLI:

```
pnpm --filter @workspace/api-server run research:run -- \
  --mode intraday --data <bars.csv> --seed 1
```

**The single most important property of it** is that the simulator replays the
plan through the SHIPPED `position-manager.ts` — the same machine the EA runs —
rather than through an idealised "exit at target or stop". A plan is filled at
its real order type (a stop order, so the fill is the trigger plus spread plus
slippage), it can be invalidated or expire, it pays the spread guard, and its
partials, break-even, chandelier and time stop all fire. Without that, the
harness would have measured a strategy nobody is running.

**Conventions, all conservative and all recorded per report:** bid bars (so a
long buys the ask and exits on the bid); the stop is assumed to have been hit
before the target when one bar contains both; the invalidation is assumed to
have fired before the trigger when one bar contains both; the position machine
is stepped on each bar's favourable extreme, because a real machine is
tick-driven and acting on the close instead would understate every partial and
every trail; ATR is computed only from CLOSED entry-frame bars; a trade still
open at the end of the data is marked to market and never silently dropped.

**Gate constants (WP2 acceptance).** Null: arm rate ≤ 3%; mean realised R ≥
−(cost + 0.05); ≤ 5% of runs DSR-significant at 0.95. Positive control: arm ≥
10%; mean realised R ≥ +0.30; |predicted − realised| expectancy ≤ 0.15R.
Calibration: reliability slope in [0.8, 1.2]; Brier skill ≥ 0.

**Measured result — the current desk fails the null gate, as the defect list
predicted.** Three driftless-random-walk seeds, 40 000 M1 bars, decisions every
15 bars (`docs/research/baseline-null-intraday.md`):

| Seed | Arm rate | Fills | Mean R | DSR |
|---|---|---|---|---|
| 1 | 7.95% | 171 | −0.620 | 0.000 |
| 2 | 16.13% | 356 | +0.236 | **0.996** |
| 3 | 13.63% | 302 | −0.169 | 0.000 |

* **Arm rate 12.57% against a 3% ceiling.** On data with no drift by
  construction, the desk arms one time in eight. This is D4 measured: the
  confidence score and the evidence ensemble do not know the difference between
  structure and noise.
* **One of three null runs produced a "significant" profit (DSR 0.996).** The
  gate tolerates 5%. A desk that finds a 99%-significant edge in a coin flip a
  third of the time is not unlucky — it is a selection machine, and this is the
  concrete case for the WP5 calibration and the WP6 gatekeeper.
* Mean realised R is −0.088 against a floor of −0.101: it passes that one check
  only because the losses and the wins are both large and roughly cancel. That
  is not a passing grade for the desk, it is a statement that the R distribution
  is noise.

**Measured result — the desk does find the positive control, and still
overstates what it will get** (`docs/research/baseline-control-intraday.md`):

| Check | Observed | Required |
|---|---|---|
| Arm rate | 60.81% | ≥ 10% — PASS |
| Mean realised R | +1.419 | ≥ +0.30 — PASS |
| Predicted vs realised expectancy | 0.557R apart (1.976 predicted) | ≤ 0.15R — **FAIL** |

The arm rate shows the desk is not blind — it fires hard when there is
something to find. The expectancy gap is D3 in numbers: the Monte Carlo still
treats the regime's drift as known truth, so it promises ~0.56R more per trade
than the executed policy delivers. A system that sizes positions off that number
is risking more than it believes.

**The verdict on the baseline is therefore:** the desk reacts to real structure
and is fooled by none, in the specific proportions above. Both failure modes are
now measured rather than asserted, which is what WP3–WP6 have to move.

**Smaller fixes made while building it.**
* `analytics.normalCdf` returned 0.5 for any non-finite input. Φ(+∞) is 1, not a
  coin flip; a degenerate variance would have quietly halved a probability.
  Finite inputs are unaffected.
* A CPCV fold holds out SEVERAL non-contiguous groups. `Fold` reported only a
  bounding `testFrom`/`testTo`, which invites a caller to treat everything
  between the first and last held-out group as out-of-sample when most of it is
  training data. `Fold.testRanges` now carries the exact blocks.

**Tests.** 47 new, in `research-numerics.test.ts`, `research-simulator.test.ts`
and `research-harness.test.ts`. The one that matters most is the prefix-replay
check: truncating the dataset and re-running must reproduce every earlier
decision bit-for-bit (excluding the plan's UUID, which is unique by design), and
it runs as part of the suite on every change.

---

## 6. Verification status

Environment limits, stated plainly: **the EA cannot be compiled or run here.**
There is no MetaTrader terminal in this sandbox. MQL5 correctness is therefore
claimed on three things, and not on a terminal run:

1. **Golden vectors.** `position-manager.ts` is the TypeScript twin of the MQL5
   state machine, with the line-by-line mapping in its header. 29 scripted tick
   paths assert the action sequence, the resulting phase, and that a stop never
   loosens.
2. **Source-level assertions.** `ea-contract.test.ts` reads
   `NeurotradeBridge.mq5` itself and pins the defects structurally: capture
   precedes the plan being cleared, no `FindPlanForSymbol` on the management
   path, state save/restore/clear, indicator handles released, the five-step
   order, one stop modification per tick, the event queue drained only after a
   successful sync, the chandelier on the entry frame, and the regime latch.
3. **The wire contract**, including a legacy payload with none of the new
   optional fields, which must read as `""` / `0` rather than throwing.

What this does **not** prove: that the terminal's semantics match the twin on a
real broker's tick stream, or that `HistorySelect` and `GlobalVariableSet`
behave as assumed under load. Both are listed as open risks (§8).

| Check | Command | Result |
|---|---|---|
| Multiasset suite | `cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx --test --test-timeout=300000 src/lib/multiasset/*.test.ts` | **388 tests, 388 pass** |
| Position-manager goldens | `... src/lib/multiasset/position-manager.test.ts` | 29 pass |
| EA wire contract | `... src/lib/multiasset/ea-contract.test.ts` | 24 pass |
| Full typecheck | `pnpm run typecheck` (api-server, trading-platform, mockup-sandbox, scripts) | clean |
| EA download parity | `pnpm --filter @workspace/trading-platform run test` | pass (v4.00) |
| EA compiles in a terminal | — | **not verifiable here** |
| WP2 null gate (driftless, 3 seeds) | `pnpm run research:run -- --gate null --mode intraday --seeds 1,2,3 --bars 40000 --step 15` | **FAIL** — arm 12.57% vs ≤3% |
| WP2 positive control (3 seeds) | `pnpm run research:run -- --gate control --mode intraday --seeds 1,2,3 --bars 40000 --step 15` | arm 60.8% PASS, mean R +1.42 PASS, expectancy gap 0.56R **FAIL** |
| Prefix replay (no lookahead) | part of the suite | pass |

---

## 7. Assumptions made where the spec was ambiguous

Recorded so they can be overruled deliberately rather than rediscovered.

1. **The RR floor is measured against the final risk unit**, not the pre-sizing
   one. `sizing.sl` may be wider than the structural stop when a broker's
   stop level forces it, and it is what will actually be sent to the server.
   A floor measured against a stop that is not the one placed is not a floor.
2. **Adverse fill, both legs, half-spread each side.** A buy fills at
   `trigger + slippage + spread/2` and a sell at `trigger − slippage − spread/2`.
   The trigger already sits beyond the market, so this is the conservative
   reading; the alternative (favourable fill) exists only in backtests.
3. **A fresh fill has no regime exit.** The plan has no `regimeExit` field to
   copy, the server never emits one at arm time (it would refuse to arm), and the
   desk pushes the latch at runtime via `set_management`. Capture therefore
   initialises it `false` rather than inheriting.
4. **WP0/WP1 are not flag-gated** — see §5.
5. **`haltAfterConsecutiveLosses: 10` is a backstop**, documented as such in
   `risk.ts`, superseded by the WP9 e-process rather than by a new heuristic.
6. **WP2 evaluates against a clear, available calendar.** The harness passes
   `emptyAvailableNewsFeed` so a baseline measures PRICE LOGIC. A null feed would
   make the fail-closed news gate refuse every entry, and the report would say
   "the desk never trades" for a reason unrelated to the desk. The rule itself is
   covered by `news.test.ts` and by shadow mode on the live feed.
7. **WP2 evaluates an empty book.** One plan is replayed at a time, so
   `armRate` is "how often a setup is offered", not "how often the book would
   have taken it". Portfolio interaction is WP8's measurement.
8. **Scalp harness runs use M1/M2/M3.** S10/S30 are synthesised from a 500 ms
   quote stream that an M1 CSV cannot reconstruct. This is defect D7 and is
   explicitly out of scope until WP4/WP7.
9. **Pyramid adds are recorded but not simulated.** The machine emits them and
   the replay logs them; the added position's own P&L is not folded into the base
   plan's R, because each add is a separate position. Portfolio-level accounting
   is WP8's scope, and the harness says so in every report.
10. **A decision's plan id is excluded from the determinism digest.** It is a
    UUID, unique per call by design, not a feature.

---

## 8. Open risks and unverifiable items

* **No terminal run (structural, WP0).** Everything in §6 applies. The highest-
  value action available to the owner is to compile the EA and watch one live
  trade's journal: the WP0 events (`captured`, `modify_sl`, `close_partial`)
  should appear, and if they do not, the mapping is wrong somewhere this sandbox
  cannot see.
* **Broker semantics under load.** Stop-level rejection and `FreezeLevel`
  behaviour during the terminal's own modifications is modelled, not observed.
* **The 5 → 10 halt change is a real loosening.** Bounded by the drawdown limit;
  re-check in WP8 against the owner's stated drawdown tolerance.
* **The 1:2 floor costs trades.** Its effect on the realised sample size, and
  therefore on how long any future edge claim takes to become measurable, is
  unquantified until WP2's baseline report exists.
* **The real-data baseline is still outstanding.** The WP2 harness runs
  headless on a broker export, but **no export exists in this environment**, so
  the two stored baselines are generated controls, not evidence about any real
  instrument. The loader is written and tested against the CSV format; the
  measurement needs one file from the owner's terminal (§9).
* **WP2's simulator cannot resolve intrabar sequence.** Bars are assumed to hit
  the stop before the target and to invalidate before they trigger. That is the
  conservative reading, but it is a reading: on instruments where a bar
  routinely spans both levels the simulated loss rate is an upper bound. Tick
  data (`--data` with a tick export) removes the ambiguity in WP4-D/WP7.
* **Sub-minute bars from 500 ms quotes (D7)** — the desk still builds decisions
  on quote-derived series for the fastest modes. Untouched.
* **Auto-select multiple-testing (D5)** — still uncorrected; every symbol the
  desk scans is another chance to find noise. WP5.


---

## 9. The baseline, in one page

WP2's first deliverable is the measurement of the desk AS IT IS, so that any
later improvement is a difference against something rather than a claim.

**What was measured.** Two families of synthetic data, both generated by the
harness's own generators (so they are reproducible from a seed), three seeds
each, 40 000 M1 bars of EURUSD, a decision every 15 bars, intraday mode. The
null has zero drift by construction; the positive control has a persistent
regime-switching drift plus an AR(1) mean-reverting state. Every decision was
made by the shipped `agent.evaluate` and every fill was replayed through the
shipped `position-manager.ts`.

**What the desk does with nothing to find.**

| | Observed | Gate | |
|---|---|---|---|
| Arm rate | 12.57% | ≤ 3% | FAIL |
| Mean realised R | −0.088 | ≥ −0.101 | pass, for the wrong reason |
| Runs showing DSR ≥ 0.95 | 33% | ≤ 5% | FAIL |

The arm rate is the headline: one setup offered in eight, on data where the only
structure is the structure the desk itself imposes. The third row is the one to
internalise: one of the three null runs produced a 99%-significant profit. That
is precisely the outcome the deflation exists to expose, and it is why no edge
claim from this desk can be believed without a stored harness report alongside
it.

**What the desk does when the edge is real.**

It arms 61% of the time and realises +1.42R per trade — so the desk is not
broken, and a fix that simply makes it timid would fail the positive control.
But it *predicts* +1.98R and gets +1.42R. The 0.56R gap is the Monte Carlo
treating `regime.drift` as known truth (defect D3). Sizing multiplies that
number by money, so the desk is systematically risking more than its own model
believes.

**What this means for WP3–WP6.** Two separate problems, and they need different
fixes:
1. **Selectivity.** The desk must arm ≤ 3% of the time when there is nothing to
   find. That is the regime permission (WP3), the calibrated probability (WP5)
   and the gatekeeper's EV_LCB floor (WP6), not a new threshold in `agent.ts`.
2. **Honesty of the number.** Predicted and realised expectancy must agree to
   within 0.15R. That is the executed-policy Monte Carlo (WP6), which simulates
   the exit policy that actually runs instead of a drift-and-volatility path.

**What must happen before this baseline becomes real evidence.** The owner
supplies one M1 export (steps in `research/data.ts`); the same two commands are
re-run against it; and the gates are re-evaluated on real returns, including the
block-shuffled and phase-randomised surrogates that preserve the real
distribution while removing the real structure.
