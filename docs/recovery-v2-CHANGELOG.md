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
