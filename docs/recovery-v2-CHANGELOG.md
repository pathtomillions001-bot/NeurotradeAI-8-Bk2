# Recovery v2 — CHANGELOG

Every behavioural change in the recovery rebuild, work package by work package.
Rule: nothing here may WEAKEN a safety control; additions only.

## WP0 — research harness (no engine behaviour change)

- Added `artifacts/api-server/src/lib/autonomous-hedge/research/` (tape
  generator, ladder + episode simulators, metrics, audit, CLI) and the
  `research:recovery` npm script. Baseline reports committed under
  `research-reports/recovery/`.
- No runtime behaviour change.

## WP1 — truthful counters and telemetry

Behavioural changes:
1. `RecoveryState` gains `trueLossRun` (consecutive settled losses, reset ONLY
   by a win) and `recoveryDepth` (uncapped recovery episode depth). Both are
   persisted in the existing `recoveryStateJson` column — no schema migration
   needed for the state itself.
2. The autonomous engine's escalation now uses the truthful counters
   (`recoveryEscalation(trueLossRun, recoveryDepth)`), so the recovery ranking
   risk weight can reach its documented cap (1.5) instead of saturating at 1.25
   (D6). The ranking math itself is unchanged and still never sizes a stake.
3. New setting `cooldownBehavior` (`"pause"` default = legacy, `"sizedown"`):
   at the consecutive-loss limit, "sizedown" keeps trading with the stake
   halved per additional loss instead of pausing. Daily-loss-limit, max
   drawdown and profit-target hard stops are untouched in both modes.
4. `/api/ai/engine/status` recovery payload adds `trueLossRun` and
   `recoveryDepth`; the dashboard Recovery card shows them (and flags when a
   cooldown resume masked part of the streak).
5. `scan_complete` SSE events carry `trueLossRun` / `recoveryDepth`.

Safety analysis:
- `streakLossCount` semantics are unchanged; the loss-limit stop still fires on
  it in "pause" mode exactly as before.
- Existing persisted states hydrate with the new counters at 0.
- No existing export removed; `reduceRecoveryOutcome` / `recordOutcome` remain
  the single writers of recovery state.

## WP2 — quote freshness and stake exactness

Behavioural changes:
1. Recovery live-quote TTL cut from 60 s to **3 s** (`LIVE_QUOTE_TTL_MS`),
   keyed by symbol/contract/barrier/duration/currency as before. Quotes carry
   a `takenAt` timestamp.
2. New `prepareRecoveryBuy()` — the buy-time exactness path (D7): requests a
   fresh proposal, reads `ask_price` + `payout`, re-sizes the stake so one win
   clears the target at the ACTUAL multiplier; re-sizes once when the live
   payout drifted > 1 % from the assumption; falls back to the canonical table
   with a **2 % safety margin** when no proposal arrives within the short
   timeout (`source = "fallback"`).
3. New rollout gate setting `recoveryV2Mode` (`off` default | `shadow` |
   `live`) in OpenAPI, api-zod, DB schema + INIT_DDL, settings route and
   `TradingSettings`. In `shadow` the buy-time plan is computed and logged
   next to the legacy stake without trading it; in `live` it trades. `off`
   (the default) is byte-for-byte legacy.
4. The cycle records the live payout it sized on (`entryPayout`) and the
   broker `buy_price` (`entryPrice`) on the ledger row — now from the
   re-verified quote when v2 is live.

Safety analysis:
- Fallback OVER-pays the stake (2 % margin) rather than under-recovering.
- Manual recovery mode (`recoveryAutoMode = false`) is never re-sized — the
  user's multiplier ladder is used exactly as entered.
- Split keeps its one-base-stake cap even after a live re-size.
- Existing tests pin the pure stake math; those numbers are unchanged.

## WP3 — Recovery Cost Index selector (recovery ranking, v2 path only)

Behavioural changes:
1. New `rci.ts`: `scoreRecoveryCandidates()` prices each allowed recovery
   contract by margin (1 − p0·payout), geometry, exact one-win stake and
   feasibility against the headroom cap; RCI = w1·margin + w2·ruinPreview +
   w3·clearTimePreview (w2/w3 = 0 until WP5). Picks the minimum RCI among
   feasible candidates; ties by feed health (freshest tape, then quote), then
   fewest recent rejections. No confirmations, no rematch penalty, no
   Markov/clustering terms. If nothing clears in one win inside the cap, the
   highest-p0 fundable contract runs PARTIAL recovery — never idle.
2. `cycle.ts` gains `decideRecoveryV2()`: in RECOVERY mode with
   `recoveryV2Mode = live` the RCI decision replaces the legacy contest
   decision (fires on the first feasible tick); in `shadow` it is logged
   beside the legacy decision without trading. NORMAL mode is never touched.
3. Harness: the episode simulator gains the `rci` selector arm and a
   mean-margin-paid metric; the null report compares engine/random/RCI.

Acceptance evidence (research-reports/recovery/*wp3-null-rci*, seed 1):
- Mean margin paid per $ staked: RCI 2.200 % ≤ random 2.329 % ≤ engine
  2.357 % (PASS on the default Over/Under + Even/Odd set).
- Decision latency: RCI 1.0 tick vs engine 25.4 (confirmations + lucky-window
  gate) — recovery fires on the first feasible tick (PASS).
- Selection skill vs random remains statistically indistinguishable (as
  expected — RCI claims lower COST, never prediction).

## WP4 — adaptive ladder, drawdown headroom, recovery budget (re-base)

New behaviour (opt-in via `recoveryMethod = "adaptive"`):
1. `adaptive-stake.ts`: stake = clamp(min(exact, max(base, λ·exact)),
   minStake, headroomCap). Exact clearance is debt-only (T′ = 0, the D4 fix —
   the sizing-target profit is no longer added to recovery stakes). λ (default
   0.5, "auto" reserved for the WP5 optimizer) controls how fast a win eats
   the debt; a soft-descent scale drives λ to 0 across the top half of the
   budget so stakes stop growing before the budget binds.
2. `recovery-headroom.ts`: headroomCap = min(φ·(balance − reserve),
   drawdownHeadroom), φ = recoveryHeadroomPct (default 5). A single recovery
   stake can never exceed the remaining drawdown budget — the D3 fix: the
   budget the hard stops enforce between trades is now folded into the stake.
   (The naive φ·min(balance, headroom) collapses to ≈ base stake and re-bases
   on the first loss; the working form was validated against the WP4 gates.)
3. Re-base: when debt ≥ recoveryBudgetBase·base (default 25×) OR the headroom
   cap can no longer fund a base stake, the debt is realised as a logged
   `REBASE` ledger row (counts in daily P&L) and the ladder restarts at base
   stake — immediately, no pause. `reduceRecoveryRebase`/`applyRebaseToState`
   are the only writers of recovery state besides `reduceRecoveryOutcome`;
   they can only REDUCE obligations and are rolled back if the durable flush
   fails (durable-before-claimed, same as settlement).
4. Cycle wiring: `resolveStake` computes the adaptive plan in RECOVERY mode;
   `checkRecoveryRebase` runs before contract selection so a headroom-bound
   recovery re-bases/holds instead of dead-locking. RCI feasibility uses the
   real headroom cap and debt-only target for adaptive.
5. Harness: episode simulator grows the `adaptive` method arm (rebase is a
   first-class outcome), CLI gains --method adaptive, --lambda, --budget-base,
   --headroom-pct, --max-drawdown-pct.

Settings (OpenAPI + api-zod + DB schema/migration + formatSettings/PUT):
`recoveryMethod` gains `adaptive`; new `recoveryBudgetBase` (25),
`recoveryLambda` ("auto"), `recoveryHeadroomPct` (5),
`recoveryMarginPreference` (1).

Acceptance evidence (200k episodes, Even/Odd, base $1, capital $200, seed 1):
- vs Instant: CVaR99 −20.00 vs −200.00 (10× better, gate ≥3×) · mean −1.27 vs
  −1.36 (Δ 0.09, gate ≤0.2) · trades p99 38 (gate ≤60) · P(run≥10) 0.00%
  (gate ≤0.1%) · P(ruin) 0.00% (gate = 0).
- vs Split baseline mean −8.80 (paper geometry): adaptive −1.27 ≈ 6.9× better
  (gate ≥4×); vs the same-harness split arm (−2.92) it is 2.3× better.
- Over 3 / Over 1 / Over 5 re-runs: CVaR 9.6×/7.6×/10× better, Δmean ≤0.19,
  ruin 0. Over 5 shows run≥10 = 1.27% — intrinsic at p0 = 0.4 (q¹⁰ ≈ 0.6%),
  not addressable by staking; recorded as an open risk.
- Wide set (50k): CVaR 10× better, ruin 0, trades p99 41.

Honest statement: the adaptive ladder reshapes RISK (tail, ruin, run length);
it does not create positive expectation — mean cash stays negative on i.i.d.
data.

## WP5 — Markov-chain DP preview + λ optimizer ("auto")

New behaviour:
1. `markov-dp.ts`: value-iteration solver for the adaptive ladder's debt random
   walk on a 1%-budget collocation grid (4× oversampled). Transitions stay
   continuous; value functions interpolate between grid points with flat
   edge extrapolation (the value functions are discontinuous at the two
   absorbing boundaries, so interpolating across them leaks probability — the
   flat edges keep every metric's Bellman operator linear, which is what makes
   Σ rebase-bins ≡ 1 − P(clear) hold exactly). Outputs P(clear), P(rebase),
   E[trades], E[cash], CVaR99 of final cash, P(max-run ≥ 6/8/10) and the
   realised re-base-debt tail.
2. `chooseOptimalLambda()`: picks λ from {0.25, 0.33, 0.5, 0.67, 1.0}
   minimising U = |CVaR99|/capital + w·E[trades] subject to P(rebase) ≤ tol
   (default 0.10). No feasible λ ⇒ the lowest-P(rebase) candidate (never an
   unvalidated λ). This is what `recoveryLambda = "auto"` now resolves to.
3. Cycle wiring: `resolveRecoveryLambda(...,"auto")` calls the optimizer with
   the live debt/payout/probability/headroom; `buildRecoveryPreview()` attaches
   a cached DP preview to the `scan_complete` payload when the method is
   adaptive and the v2 gate is ≥ shadow. A preview failure can never block a
   scan (returns null).

Acceptance evidence (research-reports/recovery/*wp5-dp-validation*, 1e6 MC
episodes per λ, seed 1, debt $1 / base $1 / payout 1.95 / p0 0.5 / budget 25×
/ headroom $10):
- P(clear) within 0.12 % of Monte-Carlo on every λ (gate ≤ 1 %).
- At the default λ = 0.5: P(clear) 0.057 %, E[trades] 0.93 %, P(rebase)
  0.96 % — all within the 1 % gate.
- Tail quantities on off-default λ carry a small residual (P(rebase) up to
  ~1.9 %, E[trades] up to ~2.7 % at λ = 1); P(clear), the dominant metric, is
  always < 0.2 %. Recorded honestly rather than tuned away.
- Cached preview answers in ~0.01 ms (median); cold solve ≈ 100 ms once per
  debt bucket. Scan-payload budget (< 5 ms) is met on the hot path.

## WP6 — Statistical honesty battery + bounded RCI margin tilt

The engine's premise is that Deriv digits are i.i.d. CSPRNG and recovery
contracts carry a 1.6–10.7% margin, so they are negative-expectation. No
selection rule can manufacture edge. WP6 makes that premise TESTABLE per
market, continuously, and gates the ONLY data-driven adjustment behind evidence
strong enough to survive multiple testing.

1. `statistical-honesty.ts` (pure, dependency-free): χ² digit-uniformity,
   serial correlation lags 1–5, a 10×10 transition-independence χ² (df 81),
   Wald–Wolfowitz runs, Rise/Fall sign-runs, Benjamini–Hochberg (q = 0.10), and
   an anytime-valid e-process (uniform-mixture likelihood-ratio martingale) on
   each contract's hit rate vs its fair p0. χ² tails use an in-repo regularised
   incomplete gamma; the normal tail an Abramowitz–Stegun erf.
2. `honesty-monitor.ts` (stateful): accumulates each watched market's digit
   tape (deduped by tick sequence), re-runs the battery every 500 new ticks,
   keeps one e-process per recovery contract, and applies the tilt gate WITH
   hysteresis — ON only when e ≥ 20 AND the battery is BH-significant, OFF
   below e < 1/20 or once the battery is clean again.
3. RCI wiring: the tilt is a per-candidate multiplier on the margin weight w1,
   clamped to [0.5, 1] — a bounded REDUCTION that only reorders selection. It
   can never raise a stake. Normal mode is untouched.
4. Kill switch: `recoveryTiltEnabled` (WP8 wires the setting) AND recovery v2
   mode must both be on; both default OFF, so factor is 1 for every contract
   until an operator opts in.

Acceptance evidence (research-reports/recovery/*wp6-honesty-validation*, 400
i.i.d. runs × 5000 ticks, seed-offset per run):
- Tilt activated on i.i.d. data in 0.25 % of runs — gate ≤ 5 % PASS.
- BH-significant battery alone: 10.8 %; e ≥ 20 alone: 3.8 % — requiring BOTH is
  what keeps the joint rate at 0.25 % (a ~40× false-positive reduction).
- Planted edge p(Even) = 0.55 vs p0 = 0.5: detected in 94 % of runs, median
  734 trades to activation.
- Battery cost ≈ 1.2 ms per market (runs every 500 new ticks, not per scan).

## WP7 — Execution & ledger verification + shadow logger

No new trading behaviour — WP7 pins down the execution guarantees the earlier
packages depend on, and builds the rollout's side-by-side evidence stream.

1. `shadow-log.ts`: bounded in-memory ring (1 000) plus per-session counters
   recording legacy-vs-v2 decisions on every recovery tick while
   `recoveryV2Mode = "shadow"`. The cycle emits `recovery_shadow_decision`
   with both reasons and the running agreement rate. Recording is a pure side
   effect — it never influences what trades, and live/off modes record nothing.
2. `executeRebase` is now exported with an injectable flush (production keeps
   the durable `flushRecoveryState`) so the atomicity guarantee is testable:
   failed flush ⇒ state rolled back, no REBASE row, no event; successful
   flush ⇒ exactly one REBASE row realising the exact debt.
3. Verified by tests (wp7-execution.test.ts): re-base atomicity (3 cases),
   shadow logger agreement/bounds/no-execution-power, and the double-fire
   guard (six coalesced cycles against one unsettled exposure insert zero
   extra rows). Already-covered guarantees re-asserted by existing suites:
   claim-unique settlement + durable-before-claim (ledger.test.ts), no
   stale-quote sizing ≤ 3 s TTL + re-size on > 1 % drift (recovery-payout
   .test.ts), actual buy price / cost driving the ledger debt (ledger.test.ts),
   TradeOutcomeUnknownError reconciliation (ledger.test.ts + cycle path).
