---
name: Exact live-payout recovery formula
description: Current canonical Auto/Manual recovery math shared by the main engine and NeuroAI FAB; supersedes older multiplier/calibration/K-cap notes.
---

# Canonical recovery stake policy (current)

This memory supersedes `recovery-method-multiplier.md`, `recovery-multiplier-calibration.md`,
`recovery-auto-mode.md`, `recovery-instant-mode-ceiling.md`, and the K-calibrated auto-mode notes.

## Payout meaning

Every payout multiplier is the **total winning return including the original stake**.
The usable net profit rate is therefore:

```text
netProfitRate = payoutMultiplier - 1
```

Canonical fallbacks live in `artifacts/api-server/src/lib/payouts.ts` and the frontend mirror:

- OVER 0..8: 1.09, 1.23, 1.40, 1.63, 1.95, 2.43, 3.21, 4.72, 8.93
- UNDER 9..1: the mirrored sequence
- Even/Odd 1.95; Rise/Fall 1.92; Match 8.93; Differ 1.09

Immediately before execution, `resolveRecoveryPayout()` requests a live $1 Deriv proposal.
The canonical table is only the timeout/error fallback.

## Target profit

When the normal trade first loses, `recordOutcome()` captures:

```text
targetProfit = lostNormalStake × (normalTradePayout - 1)
```

The state separately tracks `remainingTargetProfit`. Partial wins pay debt first and then
the target. Recovery resets only when BOTH debt and remaining target are within $0.005.

## Auto mode

Shared pure implementation: `lib/recovery-math.ts`, consumed by both the main engine and
NeuroAI FAB.

```text
exactStake = (unrecoveredAmount + remainingTargetProfit)
             / (liveRecoveryPayout - 1)
```

- **Instant:** exactStake, rounded UP to cents.
- **Split:** `min(exactStake, normalBaseStake)`; all residual debt/target carries forward.
- Auto never reads or derives a recovery multiplier.
- Deriv's $0.35 minimum, Max Stake Per Trade, and available balance remain hard limits.

## Manual mode

- The entered multiplier has no UI/API payout-calibration floor or ceiling.
- It compounds as `baseStake × multiplier^recoveryStep` up to `maxRecoverySteps`.
- Manual Split uses that ladder amount as a cap on the exact target.
- Manual Instant uses the ladder amount directly.
- Max Stake Per Trade remains the explicit execution hard cap.

## $0.70 example

Normal OVER 1/UNDER 8 fallback payout is 1.23, so a $0.70 normal loss preserves a
`$0.70 × 0.23 = $0.161` target. Recovery OVER 4/UNDER 5 pays 1.95 (net 0.95):

```text
Instant = ($0.70 + $0.161) / 0.95 = $0.9063... → $0.91
Split first attempt = min($0.91, $0.70) = $0.70
```
