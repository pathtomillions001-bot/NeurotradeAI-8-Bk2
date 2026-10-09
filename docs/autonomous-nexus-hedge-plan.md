# Autonomous engine: Nexus Hedge Forge logic

Status: IMPLEMENTED on branch `arena/df06b251-neurotradeai-8-bk2`. Decisions below
are the user's answers. One item (agents advisory-only) still needs confirmation.

## Goal

Replace the autonomous engine's NORMAL and RECOVERY trade analysis, timing and
execution with the Nexus Hedge Forge runtime logic (1-tick everywhere). Keep the
autonomous settings, the recovery staking ladder and the 4-group contest mode.
Fix the recovery ledger so a settlement timeout can never drop or understate debt.

## Hard constraints

1. The Nexus Hedge Forge bot (dbot-builder Ticks.js / Purchase.js / Total.js,
   nexus-hedge-dbot.ts, nexus-hedge-analysis.js) is NOT modified and shares no
   code path with the autonomous engine. Logic is copied, not imported.
2. Shared agents under `lib/agents/` are NOT edited: FAB engines and specialist
   bots import them. The autonomous engine has its own copies under
   `lib/autonomous-hedge/agents/`.
3. Autonomous settings and the recovery stake ladder (`recovery-math.ts`
   Auto Instant / Auto Split / Manual) are unchanged. `recovery-engine.ts` gained
   one additive export (`flushRecoveryState`) and its existing persistence path is
   unchanged.
4. Ledger changes are scoped to autonomous rows by the agentReasoning prefix
   `[Autonomous 1T] `. `isAutonomous` cannot scope them: bots and FAB also set it.
5. No DB schema change.

## Nexus logic ported (from source)

- Families: Over d (p0 = (9−d)/10), Under d (p0 = d/10), Even/Odd (0.5),
  Matches (0.1, digit = most frequent), Differs (0.9, digit = least frequent),
  Rise/Fall (0.5, price direction). Trades: DIGITOVER/UNDER, DIGITEVEN/ODD,
  DIGITMATCH/DIFF, CALL/PUT.
- Window: last 120 digits (clamped 20–300).
- Posterior: (hits + 20·p0)/(n + 20). Wilson one-sided LCB (z = 1.282).
  EV = prob·payout − 1. Markov afterLoss/afterWin, add-one smoothed.
- Clustering: applied only when losses ≥ 10. Instability: |recent − prior| hit rate,
  half = max(10, floor(n/2)).
- Normal gate: n ≥ 30, EV > 0, LCB > BE − 0.025, instability < 0.16, clustering < 1.45.
  Recovery gate: n ≥ 20, EV > −0.01, LCB > BE − 0.05, clustering < 1.6, no instability cap.
- Score = 100·((LCB−BE)·0.5 + condEdge·0.22 + EV·0.18 − instability·0.18 − max(0, clustering−1)·0.07).
  The hedge term is inert in Nexus and is not ported. condEdge: normal uses Markov, recovery uses afterLoss.
- Ranking: eligible first, then score.
- Normal entry: first eligible candidate, no confirmation (as Nexus).
- Recovery entry: the same best candidate (symbol:contract:barrier) must stay best
  across 2 distinct fresh ticks, or 3 when the loss run is ≥ 3. A settlement clears it.
- Rematch: after a loss, the losing tuple is penalised by 8 + 2·(lossRun−1), decaying
  ×0.8 per fresh tick. A win clears all penalties.
- Breaker (autonomous): the consecutive-loss limit from the existing risk settings stops the session with the cooldown from settings. Separately, 3 consecutive definitive buy rejections by Deriv stop the session with no cooldown and show the reason in stopReasons.

## Decisions (user answers)

- Normal stake: the existing `computeStake` plus the soft reduction. Kelly is dropped.
- Duration: forced to 1 tick for every family. No runtime `contracts_for` broker check.
- Contest: the same 4 parallel groups (1HZ→Volatility 1s, R_→Volatility, JD→Jump,
  else Bull/Bear). Each group ranks its markets on the 1-tick tape and produces one
  winner. The best group winner executes if the gate and rescan memory allow it.
  The contest is 1-tick for analysis, timing and execution, and the group ranker adapts to that.
- Recovery stake: the ladder is unchanged. It is sized from the candidate's win
  probability and payout through `getDynamicRecoveryStake`.

## Mapping onto the autonomous engine

| Piece | Old | New |
|---|---|---|
| Analysis | master-decision evidence log-odds, quality/confidence gates, 5–8 tick variants | Nexus ranker on the 1-tick digit tape (`lib/autonomous-hedge/hedge-analysis.ts`) |
| Timing | 3 s / 500 ms / 15 s scheduler, 12 s journal wait, 2 trades per symbol per 8 min | Tick-driven: evaluate on each tick of a watched market, coalesced. No timers. One open trade at a time. |
| Execution | Buy with bespoke durations (5-tick minimum for Even/Odd) | 1-tick buy. Exact contract id stored at buy time. |
| Recovery | Ledger debt drives the stake | Ledger and ladder unchanged. Entry = Nexus confirmation + rematch. |
| Contest | 4 parallel groups, quality/confidence winner | Same 4 groups, each runs the Nexus ranker, best group winner by score |
| Stake | computeStake plus Kelly | Normal: computeStake plus soft reduction (Kelly removed). Recovery: ladder unchanged. |

Removed from the trade path: admission gating, quality floor, family rotation hint,
per-symbol cap, DIGITMATCH→DIGITDIFF switch, duration guard, scheduleNext timers.

## Agents (autonomous copies in `lib/autonomous-hedge/agents/`)

Fourteen agents run each cycle and publish scores under the same keys the dashboard
expects: market-scanner, tick-intelligence, digit-probability, rise-fall-agent,
market-regime, execution-timing, confidence-fusion, recovery-intelligence,
duration-optimizer, portfolio-manager, risk-intelligence, learning-agent,
pattern-discovery, trade-explainability. Each is calibrated to the 1-tick Nexus model.

**Current behaviour: advisory only.** They publish scores and do not gate or veto.
The trade decision comes from the Nexus gate, the rescan memory and the risk
hard-stops. Nexus itself has no agent layer. This is a scope decision. If you want
an agent to veto, tell us which one.

## Ledger fix

Background (verified): the old reconciler ran every 60 s on rows older than 90 s,
used fuzzy matching, and called `recordOutcome`. Gaps were: 60–150 s lag; no stored
contract id on autonomous rows; fuzzy matches not claim-unique; a no-ack buy left no
id; a 2-min stale guard marked open trades "error"; and the requested stake was
recorded instead of the actual one.

Fix:
- Store the contract id at buy time. Autonomous rows only.
- Keep a row exposure-open until its exact settlement. Never move it to "error" while exposure is unresolved.
- Gate the engine while any autonomous row is unresolved.
- Autonomous 1-tick rows reconcile after 15 s. Other rows keep the original rule.
- Claim-unique matching: each Deriv transaction and each row can match only once. Loose matches must be unique both ways.
- A row with no broker record after 10 minutes is released as "error" with NO ledger change.
- A settlement timeout keeps the row open. It is never recorded as a loss, and it is never dropped.
- **Durable before claimed (`settleAutonomousRow`, ledger.ts).** Settlements run one at a time under a lock.
  Each one re-reads the row's status, applies the outcome to the in-memory ledger once,
  awaits a durable write of the ledger (`flushRecoveryState`), and only then claims the row.
  If the durable write fails, the row stays open and is retried, and the outcome is not recorded twice.
  A crash before the durable write leaves the row open, so it is recorded once on restart.
  A crash after the write but before the claim overstates debt, which is the safe direction.
- Debt is never reduced without an exact or uniquely claimed settlement.

## Duration

Deriv's public docs show 5-tick Rise/Fall examples and do not state a per-type
minimum. Nexus sends 1 tick for every family, so the autonomous engine does the same.
There is no runtime `contracts_for` check (user decision). If the broker rejects a
1-tick buy, that is handled as a definitive rejection: the row goes to "error" with no
ledger change, and after 3 consecutive rejections the engine stops.

## Settings that decisions no longer read

These are still stored and shown, but the Nexus path does not use them:
`minConfidenceThreshold`, `requirePositiveEv`, `tradeDurationSec`, `loopIntervalSec`,
`marketRotationAfter`, `maxRiskPerTrade`.

Stored values are used, defaults are unchanged. Known default conflicts (schema vs
buildTradingSettings) are left as they were: consecutive losses 4 vs 3, cooldown 1 vs
30, dailyTarget 5000 vs 50, dailyLoss 2999 vs 30, normal barriers 1/8 vs 2/7,
recovery barriers 3/6 vs 4/5, multiplier 1.62 vs 1.5.

## Known limits (disclosed)

- The Matches/Differs auto digit is chosen in-sample from the same window that is
  scored, so the edge is optimistic. Nexus does the same.
- Over/Under barriers come from settings only. Nexus scans all digits.
- Rematch and confirmation state lives in memory per session and is lost on restart.
- Live (non-paper) execution against Deriv has not been exercised end to end in this
  sandbox. Paper mode was run on the simulated feed.

## Verification

- `tsc --noEmit` in artifacts/api-server: exit 0.
- Autonomous-hedge suites (7 files, incl. ledger durability tests): 51/51 pass.
- Full api-server suite: 877 pass, 0 fail.
- Paper smoke on the simulated feed through the real cycle path: trade_started and
  trade_completed events match; ledger rows match; recovery stepped; the 6-consecutive-loss
  stop with a 1-minute cooldown worked.
- Nexus Hedge Forge JS spec (`dbot-builder nexus-hedge-recovery.spec.js`): 7 pass, 1 FAIL.
  The failing test is "the loser may re-enter only by topping every penalised fresh scan".
  It fails on untouched code: `git diff main` shows no changes under `artifacts/dbot-builder`,
  so this failure predates this work. It was not modified, because the Nexus bot must stay intact.
- Nexus Hedge Forge api-server tests (`nexus-hedge-dbot.test.ts`): part of the full suite, passing.
