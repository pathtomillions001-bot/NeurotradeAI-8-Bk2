# Recovery v2 — design and evidence log

Status: **in progress** (work packages land as separate commits on this branch).

> **Plain statement.** Deriv synthetic indices are produced by a
> cryptographically secure RNG: digits and tick directions are independent.
> Every recovery contract therefore has *negative* expectation —
> margin = 1 − p0·payout, from ≈1.6 % (Over 1) to ≈10.7 % (Matches, Over 8,
> Under 1). **On i.i.d. outcomes no staking policy can create positive
> expectation.** Recovery v2 does not predict digits. It shapes *risk*: how
> much ruin costs, how heavy the tail is, how long episodes take, and how much
> margin is paid per dollar staked. Every claim below is backed by a stored
> harness report, never by eye-balling.

## 1. Problem recap (verified defects of the shipped pipeline)

| # | Defect | Where |
|---|--------|-------|
| D1 | Split drift trap: once debt+target exceeds ~19× base (Even/Odd) expected log-debt drifts up; P90 344 trades, 6.7 % episodes ≥ 10 straight losses | `calculateRecoveryStakeRequest` (split) |
| D2 | Instant ×2.05 ladder hits maxTradeStake/balance → win can no longer clear debt (cap trap); capping without re-basing *raises* ruin (0.75 % → 1.25 % at a 5 % cap) | `applyRecoveryStakeLimits` |
| D3 | Stake sized to debt, never to remaining drawdown headroom; one stake can exceed the risk-manager headroom | `getDynamicRecoveryStake` |
| D4 | Stake includes `remainingTargetProfit` (≤ 1 base) although recovery completes on debt clearance: first stake 1.47× instead of 1.05× on Even/Odd | `calculateExactRecoveryStake` |
| D5 | Ranker `(lowerBound − breakEven)` structurally favours high-p low-payout contracts whose Instant stake is huge; ranker uses the static payout table while the stake uses a live quote | `analyseHedgeCandidate`, `resolveStake` |
| D6 | Counters mislead: cooldown resets `streakLossCount`; `recoveryStep` saturates at `maxRecoverySteps`; dashboard under-reports the true run | `resumeAfterCooldown`, `reduceRecoveryOutcome` |
| D7 | Live quote cached 60 s, never re-verified at buy; stake exactness fails when buy price differs; unused parameters in `getDynamicRecoveryStake` | `recovery-payout.ts` |
| D8 | Confirmations/rematch/Markov terms carry no information on i.i.d. data — only contract hopping and tick delay; no test measures selection skill | `hedge-state.ts`, `analyseHedgeCandidate` |

## 2. Design pillars (hard constraints honoured)

1. `recordOutcome()` / `reduceRecoveryOutcome()` stay the **single writer** of
   recovery state. Durable-before-claimed settlement (`settleAutonomousRow` →
   `flushRecoveryState`), claim-unique ledger matching, one-exposure-at-a-time,
   the exposure ceiling and every existing hard stop are preserved. v2 may add
   safeguards; it never weakens one.
2. **No waiting gates in recovery.** Recovery fires on the first tick where
   feasibility + freshness checks pass. Quality is expressed as *price*
   (margin), *geometry* (feasible stake), *freshness* (live quote) and
   *exposure budget* — never as confirmations or cool-downs. Legacy normal
   mode keeps its existing gate untouched.
3. **Backwards compatibility.** `recoveryMethod` values `instant` and `split`
   keep exactly their numbers (pinned by
   `src/lib/recovery-staking-invariant.test.ts`). The new method is
   `adaptive`; existing users keep their stored method until they opt in.
4. Every new setting exists in **all four** places: `TradingSettings`
   (api-zod), `formatSettings`, `UpdateSettingsBody`, the OpenAPI source —
   plus DB schema + `INIT_DDL` migration and the settings UI.
5. Deterministic seeded RNG everywhere in the harness; no lookahead; flags
   default OFF / shadow. Shadow mode computes and logs the v2 decision next to
   the legacy one without trading.

## 3. The adaptive method (WP4)

```
exact      = D / (payout − 1)                       # no target profit (D4 fix)
lambdaEff  = lambda · descentScale(D, B)             # soft descent near budget
candidate  = clamp( min(exact, max(base, lambdaEff·exact)), minStake, headroomCap )
headroomCap = phi · min(balance − reserve, drawdownHeadroom)
drawdownHeadroom = maxDrawdown% · peakBalance − (peakBalance − balance)
```

- `lambda` ∈ (0,1], default 0.5. `"auto"` delegates to the WP5 optimizer.
- Budget `B` (default 25× base): when `D ≥ B·base`, or when the next clearing
  stake cannot fit under `headroomCap`, the engine **re-bases**: the debt is
  realised as a logged loss (ledger row `REBASE`), debt → 0, trading resumes
  immediately at base stake. A re-base never waits and never hides the loss —
  it is logged, published to the dashboard and counted in daily P&L.
- Soft descent: as `D → B·base`, `lambdaEff` scales linearly to its floor so
  stakes stop growing *before* the budget binds.
- A stake a win cannot clear is only allowed when `headroomCap` forces partial
  recovery; the episode is marked `partial` and the budget rule handles it.

## 4. Contract selection — Recovery Cost Index (WP3)

For each allowed recovery contract `c` (live quote when fresh, table otherwise):

```
margin_c    = 1 − p0_c · payout_c
geometry_c  = payout_c / (payout_c − 1)
firstStake_c = D / (payout_c − 1)                    # T′ = 0
feasible_c  = firstStake_c ≤ headroomCap
RCI_c       = w1·margin_c + w2·ruinPreview_c + w3·clearTimePreview_c
```

Choose the minimum RCI among feasible candidates; ties by feed health
(freshest tape, lowest quote latency), then lowest recent rejection count.
If nothing is fully feasible, take the partial-stake-feasible contract with
the highest p0 and run partial recovery. **Never idle.** No confirmations, no
rematch penalty, no Markov/clustering terms on the recovery path. The legacy
ranker remains for normal mode, as an optional tilt (WP6) and for shadow
comparison.

## 5. Risk preview and optimizer (WP5)

Markov-chain DP on a debt grid (1 % of budget per bucket) computes exactly:
P(clear), P(rebase), E[trades], loss-run distribution, expected final cash,
CVaR99 — cached by parameter hash. The optimizer picks `lambda` on the grid
{0.25, 0.33, 0.5, 0.67, 1.0} minimising `U = CVaR99/capital + w·E[trades]`
subject to `P(rebase) ≤ tolerance`. The cycle's scan payload carries a
lightweight preview: P(win next), next stake, P(≥5 more losses), P(rebase),
expected trades to clear.

## 6. Statistical honesty (WP6)

Per market, on ≥ 5 000 ticks: chi-square digit uniformity, serial correlation
lags 1–5, 10×10 transition chi-square, runs test, Rise/Fall sign runs;
Benjamini–Hochberg at q = 0.10 across markets × tests. An anytime-valid
e-process (mixture likelihood-ratio betting martingale) monitors
"hit rate > p0" per live contract/market stream. A selection tilt is allowed
only when e ≥ 20 *and* BH-significant, and only as a bounded multiplicative
reduction of the RCI margin weight (never a stake increase). The tilt kills
itself when the e-process of realised outcomes vs the claimed edge falls below
1/20. The expected, published result on Deriv data is: **no exploitable
pattern detected.**

Implementation: `statistical-honesty.ts` holds the pure battery, BH, and the
uniform-mixture e-process; `honesty-monitor.ts` accumulates each market's tape
(deduped by tick sequence), re-runs the battery every 500 new ticks, and owns
the per-contract e-processes with hysteresis. The RCI scorer takes a
per-candidate `marginWeightFactor` clamped to [0.5, 1], so the tilt can only
reorder selection — never a stake increase. Kill switch: `recoveryTiltEnabled`
plus recovery-v2 mode, both defaulting OFF.

## 7. Quote freshness (WP2)

Live-quote TTL ≤ 3 s keyed by symbol/contract/barrier/duration/currency. At
buy time the engine requests the proposal, reads `ask_price` and `payout`, and
re-sizes so a win clears the target at the ACTUAL multiplier; if the proposal
payout differs > 1 % from the assumption it re-sizes once; if no proposal
arrives within the short timeout it falls back to the table with
`source = "fallback"` and a 2 % safety margin on the stake. Actual buy price
and payout are recorded on the ledger row.

## 8. Truthful counters (WP1)

- `trueLossRun`: consecutive settled losses across cooldowns, reset only by a
  win. Persisted. `streakLossCount` is kept untouched for existing consumers.
- Recovery depth is tracked UNCAPPED (`recoveryDepth`); `recoveryStep` stays
  capped at `maxRecoverySteps` for legacy staking. Escalation reporting uses
  the uncapped depth.
- Cooldown keeps its setting, plus a new `cooldownBehavior = "sizeDown"`
  option. Documented fact: a time pause changes nothing statistically about
  i.i.d. outcomes; size-down expresses the same caution through exposure.

## 9. Rollout

- Phase 1 — shadow ≥ 2 weeks: `recoveryV2Mode = "shadow"` logs the v2 decision
  beside the legacy one, no behaviour change. WP7's `shadow-log.ts` keeps a
  bounded ring plus per-session agreement counters and the cycle emits
  `recovery_shadow_decision` each recovery tick, so the side-by-side record is
  the rollout's evidence base.
- Phase 2 — opt-in `adaptive` on demo/virtual ≥ 300 recovery episodes.
- Phase 3 — default for NEW users only; legacy users keep their setting.
- Kill switches: flag off restores legacy exactly; any ledger inconsistency
  stops the engine.

## 10. Evidence register

All reports live in `artifacts/api-server/research-reports/recovery/`
(timestamped JSON + markdown pairs). Headline baseline (200k episodes,
seed 1, capital $200, base $1, max stake $500):

| Report | Key numbers | Paper reference |
|--------|-------------|-----------------|
| `baseline-evenodd-instant` | mean cash −1.39/−1.37, P(ruin) 1.17/1.16 %, CVaR99 −200 | −1.26, 0.75 %→1.25 % cap-trap discussion |
| `baseline-paper-ladder-replica` (`--origin-payout 1.4`) | mean −1.31, P(ruin) 0.86 %, CVaR99 −171.7, first rung $1.48 ×2.05 | −1.26, ladder 1.48→957.55, −167 |
| `baseline-evenodd-split` | mean −8.80, unresolved 8.4 %, P(run≥10) 8.3 %, CVaR99 −184.6 | −7.24, 6.7 % unresolved/≥10-run, −180 |
| `baseline-default-instant` / `-split` (Over 3 / Under 6) | instant mean −1.28/−1.24; split mean −7.78/−7.72, P(run≥8) 7.3 % | 14× base trap (D1) |
| `baseline-wide-instant` | Matches: P(run≥10) 38.5 %, mean −2.45; Differs: cheapest (mean −1.49, run≥6 = 0 %) | margin table 1.6 %–10.7 % |
| `baseline-null-instant` | engine hit 49.80 % vs random 48.49 % (±2.22 pt power) → indistinguishable; latency 41.5 vs 2.6 ticks | 47.7–53.6 % vs 49.7 % |

Null-test verdict (WP0 acceptance): the shipped recovery ranker is
statistically indistinguishable from uniform random selection on i.i.d. data;
its confirmations/gates add ~25–40 ticks of decision latency per recovery trade.

WP3 RCI gate (`wp3-null-rci*`): mean margin paid per $ staked — RCI 2.200 % ≤
random 2.329 % ≤ engine 2.357 % (default set) and RCI 1.924 % ≤ engine 1.961 %
≤ random 2.259 % (wide set); RCI decision latency 1.0 tick. Note: on the wide
set the raw hit rates differ between arms because RCI deterministically shifts
the mix toward low-margin high-p0 contracts (Differs) — that is the cost
optimisation itself, not selection skill; margin-paid is the honest comparison.

WP5 DP validation (`*wp5-dp-validation*`): collocation-grid value iteration vs
1e6-episode Monte-Carlo — P(clear) within 0.12 % on every λ in the optimizer
grid; default λ = 0.5 within 1 % on P(clear)/P(rebase)/E[trades]. Cached
preview ≈ 0.01 ms (gate < 5 ms); cold solve ≈ 100 ms per debt bucket (one-off).
The optimizer ("auto") minimises |CVaR99|/capital + w·E[trades] s.t.
P(rebase) ≤ 0.10 over λ ∈ {0.25, 0.33, 0.5, 0.67, 1.0}.

WP6 honesty validation (`*wp6-honesty-validation*`, 400 i.i.d. runs × 5000
ticks): tilt activated on i.i.d. data in 0.25 % of runs (gate ≤ 5 %). Requiring
BOTH e ≥ 20 AND a BH-significant battery drops the joint false-positive rate to
~1/40th of either alone. Planted edge p = 0.55 vs p0 = 0.5 detected in 94 % of
runs (median 734 trades). The tilt factor is clamped to [0.5, 1] — selection
order only, stakes never grow — and the kill switch (recoveryTiltEnabled +
v2 mode, both default OFF) forces factor 1 everywhere.

WP4 adaptive acceptance (`wp4-accept-*`, 200k episodes, Even/Odd, base $1,
capital $200, seed 1): adaptive λ=0.5, budget 25×, φ=5% — CVaR99 −20.00 vs
Instant −200.00 (10×, gate ≥3×); mean −1.27 vs −1.36 (Δ 0.09, gate ≤0.2);
trades p99 38 (gate ≤60); P(run≥10) 0.00% (gate ≤0.1%); P(ruin) 0.00%
(gate = 0); P(rebase) 6.94%. vs Split paper-geometry mean −8.80: 6.9× better
(gate ≥4×). Over 3/1/5 re-runs all pass CVaR/mean/ruin gates. The re-base is
what removes ruin: the legacy Instant arm ruins 1.15% of episodes (the −200
tail) while adaptive realises the debt and restarts instead.

## 11. Open risks / unverified

- **No positive expectation anywhere.** Every arm above has NEGATIVE mean cash
  on i.i.d. data. The adaptive ladder only reshapes the tail (CVaR, ruin,
  run length); it cannot and does not create edge. This is the single most
  important fact in this document.
- **Over 5 / low-p0 markets:** P(run≥10) = 1.27% is intrinsic (q¹⁰ ≈ 0.6% at
  p0 = 0.4) and cannot be reduced by any staking policy; only avoiding such
  contracts in recovery sets can.
- **Wide-set mean gap:** adaptive mean −1.42 vs Instant −1.80 is a 0.38 gap
  (> the 0.2 gate) because the wide set mixes in high-margin Rise/Fall; the
  gate is met on the Even/Odd acceptance set.
- **λ = "auto"** resolves through the WP5 Markov-DP optimizer. Cold solve is
  ≈ 100 ms per debt bucket (≈ 0.5 s when the optimizer evaluates all five
  lambdas at once); it happens once per visited bucket and is cached
  afterwards, so the 1-tick cycle absorbs it, but it is the most expensive
  thing the v2 path does.
- **Live Deriv quote behaviour** (WP2 buy-time re-verify, WP7 one-tick buy) is
  exercised only against injected fake fetchers in tests; the sandbox cannot
  reach Deriv WS, so live-path behaviour is untested here by design.
- **Headroom formula interpretation:** the spec's φ·min(balance, headroom)
  degenerates to ≈ base stake (re-base on the first loss); we implement
  min(φ·(balance−reserve), drawdownHeadroom), the only form that satisfies the
  WP4 gates. Flagged for review.
