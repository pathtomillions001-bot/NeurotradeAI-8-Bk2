---
name: CALL/PUT canonical contract types
description: CALL and PUT are the canonical internal contract types for Rise/Fall direction trades. RISE/FALL are legacy aliases that must be normalized on ingestion.
---

## Rule
Use `"CALL"` (price ends higher = Rise) and `"PUT"` (price ends lower = Fall) everywhere internally. Display as "Rise" / "Fall" in the UI. Never store or produce `"RISE"` / `"FALL"` from the backend.

**Why:** The Deriv API accepts both CALL/PUT and RISE/FALL for synthetic-index tick contracts, but the codebase had drifted to using RISE/FALL inconsistently. Unified to CALL/PUT to match Deriv's own documentation and to enable cleaner type routing.

**How to apply:**
- On input normalization: `t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t`
- In `ProductType` (types.ts): CALL and PUT are both listed
- In `isDirectionProduct()`: check for all four (`["CALL","PUT","RISE","FALL"]`)
- In `normalizeDerivContractType()` in trades.ts: maps RISE→CALL, FALL→PUT (NOT the reverse)
- In UI labels: CALL → "Rise", PUT → "Fall" everywhere; never show raw contract type
- ev-calculator.ts `DEFAULT_PAYOUTS` includes both CALL/PUT and RISE/FALL keys for backward compat
- Backward compat: trade records in DB may still have "RISE"/"FALL"; analytics filters include all four
