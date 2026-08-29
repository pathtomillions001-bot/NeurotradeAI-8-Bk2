---
name: SpeedAI recovery scanner constraints
description: findSafestRecoverySetup() rules — tiered priority, payout floor, forbidden types
---

# SpeedAI recovery scanner constraints

## Rule
`findSafestRecoverySetup(recoveryBarriers)` uses strict tiered priority, never mixing tiers:
1. **OVER/UNDER** on any market — but ONLY barriers with equal-or-better payout than user's configured recovery barriers:
   - OVER: only `barrier >= userOverBarrier` (higher = higher payout)
   - UNDER: only `barrier <= userUnderBarrier` (lower = higher payout)
2. **EVEN/ODD** — only if tier 1 found zero candidates
3. **DIGITMATCH** — only if tiers 1+2 found nothing
- **Never**: DIGITDIFF (over-exposes capital), RISE/FALL

**Why:** User wants the AI to find better *markets* for their configured contract, not weaker payouts. OVER 3 with 1.37× payout is "worse recovery" than user-set OVER 4 at 1.63× because they need a bigger stake to recover the same loss. The scan must respect the payout floor.

**How to apply:** Pass `barriers` (the current recovery barriers from config) to `findSafestRecoverySetup()`. The function extracts `userOverBarrier` and `userUnderBarrier` via `extractBarriers()` and filters accordingly.
