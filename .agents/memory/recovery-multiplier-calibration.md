---
name: Recovery auto-mode intelligent stake formula
description: Auto-mode recovery uses K-calibrated step 1, then debt-aware linear-capped stakes for steps 2+ with method-specific baseFactor (instant=3.0, split=2.0).
---

## Auto-mode recovery: intelligent debt-aware formula

`computeDynamicStake()` in `recovery-engine.ts`, auto-mode block:

### Step 1: K-calibrated entry (always)
```
K = 0.777
step1Mult      = min(K / netPayout, 15)
step1Reference = baseStake × step1Mult
stake          = step1Reference
```
e.g. OVER 3/UNDER 6 (net=0.37): step1Mult=2.10, step1Reference=$1.47 for $0.70 base.
A win at step 1 recovers ~77.7% of the original loss (partial by design — keeps entry conservative).

### Steps 2+: debt-aware with linearly growing cap
```
stepOffset = recoveryStep - 2        // 0 at step 2, 1 at step 3, …
baseFactor = instant ? 3.0 : 2.0    // method-specific starting ceiling
capFactor  = baseFactor + stepOffset × 0.5
cap        = step1Reference × capFactor

stake = min(minRecovery, cap)        // accept partial recovery when capped
```

Where `minRecovery = unrecoveredAmount / netPayout × 1.02`.

Cap schedule for OVER 3 (step1Ref=$1.47):
| Step | Instant cap | Split cap |
|------|------------|-----------|
| 1    | $1.47      | $1.47     |
| 2    | $4.41 (3.0×) | $2.94 (2.0×) |
| 3    | $5.15 (3.5×) | $3.68 (2.5×) |
| 4    | $5.88 (4.0×) | $4.41 (3.0×) |
| 5    | $6.62 (4.5×) | $5.15 (3.5×) |

**Old geometric produced: step 2=$4.56, step 3=$14.13, step 4=$43.80 — rejected as too aggressive.**

### Key properties
- When `minRecovery < cap` (debt is small after partial wins), only the exact-needed stake is used — never overshoot.
- When capped, partial recovery: remaining debt carries forward and shrinks with each subsequent win.
- **Split**: starts lower (2×), grows slower — conservative, takes more wins but stakes stay small.
- **Instant**: starts higher (3×), same growth rate — faster recovery attempt but still bounded.
- Both caps grow linearly (+0.5× per consecutive loss), never exponentially.

### Why K=0.777
Derived from user example: OVER 3/UNDER 6 step-1 multiplier = 2.10; 2.10 × 0.37 = 0.777.
Each step-1 win recovers ~77.7% of the base stake, not 100% — intentionally partial to keep entry gentle.

### Manual mode (recoveryAutoMode=false)
Uses `recoveryMultiplier` from settings.  
- Instant: `splitEquivalentStake = baseStake × recoveryMultiplier`; jumps to `minRecovery` only when that's insufficient.
- Split: progressive cap = `max(recoveryMultiplier, 1/netPayout×1.05) + stepOffset` per loss.

## Analytics 500-trade oscillation fix (separate issue, same file context)
`getDerivTransactions()` in `trades.ts` no longer falls back to `fetchDerivProfitTable(500)` when the JournalManager cache is empty. Returns `[]` + kicks `forceRefresh()`. Prevents 500→full-count flip in the Analytics UI.
