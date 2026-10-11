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
