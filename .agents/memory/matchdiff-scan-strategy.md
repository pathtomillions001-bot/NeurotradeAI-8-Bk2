---
name: Matchdiff scan strategy
description: How DIGITMATCH/DIGITDIFF are scanned by the autonomous engine and the normal→recovery contract-type switch.
---

## Rule
- **Normal mode**: scan with `["DIGITDIFF"]` — cold digit, ~96% win rate, payout 1.04×.
- **Recovery mode**: scan with `["DIGITMATCH"]` — hottest digit, ~10-15% win rate, payout 9.0×. A tiny stake ($1.28 on a $10 DIFF loss) recovers the full debt.
- The switch is driven by `recoveryEngine.isInRecovery()` inside the per-market family-push loop in `routes/ai.ts`.
- Fallback: if only one of DIGITMATCH/DIGITDIFF is in `preferredContractTypes`, use whichever is present.

## Confidence threshold
- `matchdiff` family uses threshold `min(settings.minConfidenceThreshold, 45)` — DIGITMATCH's 10% win rate naturally produces lower agent scores than OVER/UNDER; the EV gate in master-decision.ts is the real quality filter.

## Enabled families array
```ts
const mdTypes = preferredContractTypes.filter(t => ["DIGITMATCH", "DIGITDIFF"].includes(t));
if (!isBullBear && m.digitEnabled && mdTypes.length > 0) {
  const activeMdTypes = (inRecovery && mdTypes.includes("DIGITMATCH"))
    ? ["DIGITMATCH"]
    : mdTypes.includes("DIGITDIFF") ? ["DIGITDIFF"] : mdTypes;
  families.push({ name: "matchdiff", types: activeMdTypes });
}
```

**Why:** DIGITMATCH 9× payout means a loss on DIGITDIFF (~96% win) is recovered with a fraction of the original stake — optimal recovery vehicle. Normal-mode DIGITDIFF accumulates profit steadily at high win rate.

**How to apply:** Any change to recovery logic in `routes/ai.ts` must preserve this family push pattern and keep the recovery method check consistent with `recoveryEngine.isInRecovery()`.
