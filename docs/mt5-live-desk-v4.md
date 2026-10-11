# MT5 Desk v4 — calibrated probabilities, hard permissions

Status: **WP0 and WP1 complete and verified. WP2+ not started.**
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
| WP2 | Research harness + BASELINE report on real broker data | not started |
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
| D3 | MC treated regime drift as truth, bootstrapped i.i.d., and marked timed-out paths to market | open — WP6 |
| D4 | Evidence confidence inflated on noise (~65.6 against a 60–62 bar) | open — WP5 |
| D5 | Auto-select had no multiple-testing correction | open — WP5 |
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
| Multiasset suite | `cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx --test --test-timeout=120000 src/lib/multiasset/*.test.ts` | **341 tests, 341 pass** |
| Position-manager goldens | `... src/lib/multiasset/position-manager.test.ts` | 29 pass |
| EA wire contract | `... src/lib/multiasset/ea-contract.test.ts` | 24 pass |
| Full typecheck | `pnpm run typecheck` (api-server, trading-platform, mockup-sandbox, scripts) | clean |
| EA download parity | `pnpm --filter @workspace/trading-platform run test` | pass (v4.00) |
| EA compiles in a terminal | — | **not verifiable here** |

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
* **Baseline reporting needs real data.** The WP2 harness will run headless on
  a broker export; without one it can only run on generated series, which is a
  control, not evidence.
* **Sub-minute bars from 500 ms quotes (D7)** — the desk still builds decisions
  on quote-derived series for the fastest modes. Untouched.
* **Auto-select multiple-testing (D5)** — still uncorrected; every symbol the
  desk scans is another chance to find noise. WP5.
