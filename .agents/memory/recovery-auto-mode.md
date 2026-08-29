---
name: Recovery Auto Mode
description: New recoveryAutoMode boolean field — auto vs manual stake calculation in recovery.
---

# Recovery Auto Mode

## The rule
`recoveryAutoMode: boolean` (default `true`) controls how the recovery stake is calculated:

- **Auto (true)**: stake = `(unrecoveredAmount / netPayout) × 1.02` — the exact minimum to cover the accumulated debt. No multiplier, no progressive split cap. The `recoveryMultiplier` field is ignored.
- **Manual (false)**: user's `recoveryMultiplier` is used as a progressive split-cap floor (existing behaviour before this feature).

In both modes, `recoveryMethod` (split/instant) and `maxRecoverySteps` remain active and respected.

**Why:** User reported recovery trades were "too greedy" — staking more than needed relative to the lost amount. The root cause was that even in the correct case where `minRecovery = splitCap`, the formula produces `profit ≈ debt × 1.05` (the 5% buffer becomes pure profit on top of the recovered amount). Auto mode drops the buffer to 2% and removes all multiplier floors so the stake is always just the mathematical minimum.

## How to apply
- When adding a new TradingSettings consumer, include `recoveryAutoMode: s?.recoveryAutoMode ?? true` in its `buildTradingSettings`.
- Pass `recoveryAutoMode` as the last argument to `getDynamicRecoveryStake(...)`.
- The DB column is `recovery_auto_mode boolean NOT NULL DEFAULT true` (already migrated).
- `UpdateSettingsBody` in `lib/api-zod/src/generated/api.ts` includes `recoveryAutoMode: zod.boolean().optional()` — any new field in `TradingSettings` must also be added there or it is silently stripped.

## UI
Settings page → Recovery Mode card → Auto/Manual toggle button appears when recovery mode is ON.
- Auto: hides the multiplier input, shows a barrier-aware stake preview (debt/netPayout × 1.02 per step).
- Manual: shows multiplier input + "Auto {suggested}×" calibration button.
- Both: show Recovery Method (split/instant) and Max Recovery Steps.
