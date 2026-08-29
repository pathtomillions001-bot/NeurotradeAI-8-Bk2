---
name: Digit barriers — settings-driven normal/recovery pair
description: How OVER/UNDER barriers are selected today; supersedes the old "always OVER 2/UNDER 7, no recovery" rule.
---

## Rule
Recovery-digit switching was reintroduced (user-requested) and is settings-driven, not hardcoded. `recoveryEngine.isInRecovery()` in the autonomous loop (`ai.ts`) selects `{normalOverDigit, normalUnderDigit}` vs `{recoveryOverDigit, recoveryUnderDigit}` from Settings, passed as `ScanContext.recoveryBarrierOverride` and consumed by `buildBarrierOptions()` in `digit-probability.ts`. Manual (non-autonomous) trades do NOT apply this override — only the autonomous loop's per-market scan does.

**Why:** An earlier iteration removed all recovery barriers per a since-superseded user request; a later request restored settings-configurable normal/recovery pairs. Always check the current `digit-probability.ts` / `ai.ts` code rather than trusting a memory that a barrier set is "hardcoded" — this has flip-flopped before.

**How to apply:**
- Before assuming barriers are fixed/hardcoded, grep for `ALLOWED_BARRIERS` default and `recoveryBarrierOverride` usage to see the current behavior.
- If recovery-digit switching appears "not working," first verify trades are actually settling as won/lost (not erroring) — `recoveryEngine.recordOutcome()` only fires on real settlement. See [live trade settlement via portfolio+profit_table](live-trade-settlement-poc-fix.md).
