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
