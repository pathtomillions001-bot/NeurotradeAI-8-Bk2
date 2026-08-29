---
name: Recovery Instant mode exposure ceiling
description: Instant recovery mode's stake is now capped to match Split mode's worst case.
---

User reported Instant recovery mode staking a large multiple of the base stake to cover a loss
(described as ~2.72×). No literal multiplier constant matching that number was found anywhere
in code or the live settings row (`recovery_multiplier=1.62`, `recovery_method=split` at time of
investigation — Instant wasn't even the active mode). The Instant formula itself
(`minRecovery = unrecoveredAmount / netPayout * 1.02`) is mathematically already the minimal
stake needed to net back the loss plus a 2% buffer — it can only be capped lower by
maxExposure/maxTradeStake, never inflated.

**Why:** for low-payout contracts (e.g. 1.62×), the minimal stake to recover a large loss in one
trade is necessarily much bigger than the loss itself (netPayout=0.62 → ~1.6x the debt) — this
can look like "overexposure" even though it's the correct minimum for full one-shot recovery.

**How to apply:** as a safety measure, Instant mode's stake is now also bounded by the same
worst-case ceiling Split mode uses: `baseStake × (recoveryMultiplier + maxRecoverySteps)`. If a
user reports Instant overshooting, capture the exact loss amount + payout + resulting stake to
trace whether the payout fed into `getDynamicRecoveryStake` (in `ai.ts`, from `rec.payoutMultiplier`)
actually matches the contract type that was selected — that's the most likely remaining lead if
the ceiling doesn't resolve it.
