---
name: Live trade execution in manual trades route
description: How real Deriv live trades work in the POST /trades route vs autonomous engine
---

The manual POST /trades route previously used Math.random() even with a live token. Fixed:
- When `token && !paperTradeMode && !isDemo`: calls executeLiveTrade + waitForContractResult
- Inserts trade as status="open" first, then updates to won/lost after result
- Proper error handling: cancels the open trade (marks lost profit=0) if live execution fails
- getLiveBalance is imported statically, not dynamically

The autonomous engine (ai.ts) already did this correctly before the fix.

**Why:** The manual trades route was simulating results instead of executing real orders.

**How to apply:** Any new manual trade execution paths should follow the same pattern: insert "open", execute live, await result, update status.
