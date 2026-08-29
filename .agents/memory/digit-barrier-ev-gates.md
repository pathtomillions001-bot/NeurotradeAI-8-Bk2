---
name: Digit barrier EV gates
description: How master-decision.ts classifies digit barriers into tiers for EV gating, and the coordinator's allBarrierOptions scoping rule for matchdiff-family scans.
---

## Rule

**Tier classification must use user-configured barrier values, not hardcoded numbers.**

`master-decision.ts` previously had:
```typescript
const isDigitTier1 = (bestEV.barrier === 2) || ...  // WRONG — hardcoded
```

Correct form reads from `ctx.settings`:
```typescript
const normalOverBarrier  = ctx.settings.normalOverDigit   ?? 2;
const normalUnderBarrier = ctx.settings.normalUnderDigit  ?? 7;
const recoveryOverBarrier  = ctx.settings.recoveryOverDigit  ?? 4;
const recoveryUnderBarrier = ctx.settings.recoveryUnderDigit ?? 5;

const isDigitTier1 = (
  (bestEV.product === "DIGITOVER"  && bestEV.barrier === normalOverBarrier) ||
  (bestEV.product === "DIGITUNDER" && bestEV.barrier === normalUnderBarrier)
);
const isDigitTier2 = (
  (bestEV.product === "DIGITOVER"  && bestEV.barrier === recoveryOverBarrier) ||
  (bestEV.product === "DIGITUNDER" && bestEV.barrier === recoveryUnderBarrier)
);
```

## DIGITDIFF gate

DIGITDIFF should NOT use the tier-1 edge gate (`edge > 0`).
- DIGITDIFF needs >96.2% win rate for positive edge (payout 1.04x → breakeven = 1/1.04)
- In practice DIGITDIFF win rates are 90-96% — always negative edge
- Using the edge gate means DIGITDIFF is always rejected

Use EV > -0.05 instead (same as DIGITMATCH's gate):
```typescript
const isDigitDiff = bestEV.product === "DIGITDIFF";
if (isDigitDiff) {
  if (bestEV.expectedValue < -0.05) { /* reject */ }
}
```

## allBarrierOptions scoping in matchdiff-family scans

`agent-coordinator.ts` must NOT seed `allBarrierOptions` with OVER/UNDER barrier options
when `wantDigit = false` (i.e. the family being scanned is `matchdiff` with preferred = `["DIGITDIFF"]`
or `["DIGITMATCH"]`).

Wrong:
```typescript
const allBarrierOptions = [...barrierOptions]; // always includes OVER/UNDER from digitAgent
```

Correct:
```typescript
const allBarrierOptions = wantDigit ? [...barrierOptions] : [];
```

**Why:** If OVER/UNDER options are present in the matchdiff-family EV tournament, they can
win (better raw EV than DIFF) and the coordinator recommends DIGITOVER/DIGITUNDER from a
scan whose `preferred` was `["DIGITDIFF"]`. The trade executes the wrong contract type.

## candidateProduct for matchdiff

Use the preferred type, not always "DIGITMATCH":
```typescript
: wantMatchDiff
  ? (preferred.includes("DIGITDIFF") ? "DIGITDIFF" : "DIGITMATCH")
```

Normal mode has `preferred = ["DIGITDIFF"]` → candidateProduct = "DIGITDIFF".
Recovery mode has `preferred = ["DIGITMATCH"]` → candidateProduct = "DIGITMATCH".
