---
name: Live trade settlement — proposal_open_contracts rejected
description: Deriv rejects proposal_open_contracts with "UnrecognisedRequest" for this account/app_id; use portfolio+profit_table polling instead.
---

## Rule
The Deriv WS call `{ proposal_open_contracts: 1, contract_id, subscribe: 1 }` returns `{"code":"UnrecognisedRequest"}` for this account/app_id — verified with a raw, isolated WS script outside the app, with and without `contract_id`/`subscribe`, always errors. `balance`, `portfolio`, and `profit_table` all work fine on the same token. Every live trade was settling as `status:"error"` because of this, which also silently broke recovery-state transitions (`recoveryEngine.recordOutcome()` never fired with a real win/loss).

Fix: `waitForContractResult` in `deriv.ts` now polls `portfolio` every 1s to detect when a contract leaves the open-contracts list, then queries `profit_table` for the settled `buy_price`/`sell_price` to compute profit/won. No tick-level entry/exit spot is available from `profit_table`, so `exitSpot`/`entrySpot` are 0 from this function — callers should fall back to `buyPrice`/`entryPrice` for display.

**Why:** `proposal_open_contracts` is a documented, normally-valid Deriv API call — its rejection here is account/app_id-specific, not a request-format bug. If this surfaces again (e.g. after a token/app_id change), re-verify with a standalone script before assuming the request payload is wrong.

**How to apply:**
- If live trades start erroring again, first test `proposal_open_contracts` (and other calls) in isolation via a raw WS script with the real token before touching app code — isolates account/app_id-level API restrictions from app bugs.
- Any new code needing contract settlement status should reuse the portfolio+profit_table polling pattern, not `proposal_open_contracts`.
