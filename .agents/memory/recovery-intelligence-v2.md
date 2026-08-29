---
name: Recovery Intelligence Engine v2
description: Architecture of the AI-driven recovery candidate evaluation system — all 8 barriers evaluated per symbol, symbol-scoped cache, hard gate.
---

## The Rule
When over/under family is in recovery, `evaluateRecoveryCandidates(ctx, "overunder", symbol)` must run **before** `runCoordinator()`. If `shouldTrade=false`, return `null` immediately — do NOT call runCoordinator() with undefined override.

**Why:** If coordinator runs with `recoveryBarrierOverride=undefined`, it falls back to OVER2/UNDER7 normal barriers, bypassing the recovery intelligence gate entirely.

## Cache Key
`lastEvaluations` is `Map<string, RecoveryEvaluationResult>` keyed by `"family|symbol"` (e.g. `"overunder|R_25"`). Use `evalKey(family, symbol)` to build the key.

**Why:** Parallel market scans overwrite each other if keyed only by family. The winning market's stake must come from its own evaluation.

## getDynamicRecoveryStake
Pass `symbol` parameter: `getDynamicRecoveryStake(family, baseStake, maxStake, balance, symbol)`. Falls back to 1.2^step formula if no symbol-scoped evaluation cached.

## Cache Cleanup
All `lastEvaluations.delete(family)` calls were replaced with `clearFamilyEvals(family)` which iterates keys matching `"family|"` prefix and deletes them all.

## Intelligence Page Fix
`analyzeCompletedTrade` was not being called for manual trades. Fix: in `trades.ts`, promote `coordinatorOutput` to `savedCoordinatorOutput` in outer scope, then call `analyzeCompletedTrade({...}).catch(() => {})` after both live and paper trade DB writes.

## API Endpoints Added
- `GET /api/ai/recovery/evaluation` — returns current recovery state + last evaluation result for "overunder" family
- `GET /api/ai/recovery/candidates?symbol=R_10` — runs fresh evaluation for any symbol

## How to Apply
Any future change to the autonomous loop that touches recovery barrier selection must maintain the pre-coordinator gate pattern — check, evaluate, return null if no trade, then build famCtx with the computed override.
