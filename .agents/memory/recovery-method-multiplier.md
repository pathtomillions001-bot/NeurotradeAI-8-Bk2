---
name: Recovery method and multiplier
description: How recoveryMethod and recoveryMultiplier flow through the system and the progressive split-mode cap formula.
---

## Rule
- `recoveryMethod` ("split" | "instant") and `recoveryMultiplier` (number) flow: DB settings → `buildTradingSettings()` → `getDynamicRecoveryStake()`.
- DB column default: `recoveryMultiplier = 1.62`, `recoveryMethod = "split"`.
- Default digits: normal OVER 1 / UNDER 8, recovery OVER 3 / UNDER 6.

## Stake formula

**Instant mode:** `stake = unrecoveredAmount / (payout - 1) × 1.02` (no cap) — always recovers full debt in one win.

**Split mode (progressive cap):**
```
progressiveMultiplier = recoveryMultiplier + (recoveryStep - 1)
splitCap = baseStake × progressiveMultiplier
stake = min(minRecovery, splitCap, maxExposure, maxTradeStake)
```

This produces the sequence: 1.62 → 2.62 → 3.62 → … (step 1, 2, 3, …).

At OVER 3 / UNDER 6 (payout 1.62×, net 0.62):
- Step 1: stake = base × 1.62 → profit = base × 1.004 ≈ covers base loss ✓
- Step 2: stake = base × 2.62 → profit = base × 1.624 ≈ covers step-1 stake ✓

## Auto-suggest multiplier (UI)
`suggestedMultiplier ≈ (10 / (9 - overDigit)) × 0.972`
- OVER 3 → 1.62, OVER 1 → 1.22, OVER 5 → 2.43, OVER 4 → 1.94

**Why:** At 1.5× (old default) with OVER 3 payout, stake = $1.50 but profit = $1.50 × 0.62 = $0.93 < $1 loss — recovery never converges. At 1.62×, profit = $1.004 > $1 — exact coverage.

**How to apply:** Any change to `computeDynamicStake` or `getDynamicRecoveryStake` must preserve the progressive cap formula. The `recoveryStep` parameter comes from `state.recoveryStep` inside the module — do not pass a hardcoded value.
