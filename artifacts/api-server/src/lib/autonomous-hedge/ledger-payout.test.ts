import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ledgerPayoutFor, recoveryTargetProfitFor } from "../recovery-math";

/**
 * The autonomous engine must feed the recovery ledger the same payout the
 * NeuroAI FAB does. A lost trade's quoted payout is what sets the recovery
 * target profit, so recording 1 on a loss (the old behaviour) zeroes it.
 */
describe("autonomous ledger payout", () => {
  it("a loss carries the quoted payout, so the recovery target is not zeroed", () => {
    const payout = ledgerPayoutFor({ won: false, buyPrice: 1, profit: -1, quotedPayout: 1.95 });
    assert.equal(payout, 1.95);
    assert.equal(recoveryTargetProfitFor(1, payout), 0.95);
  });

  it("the old 1-on-loss rule is gone: an unknown quote on a loss is 1, never a guess", () => {
    assert.equal(ledgerPayoutFor({ won: false, buyPrice: 1, profit: -1, quotedPayout: 0 }), 1);
    assert.equal(ledgerPayoutFor({ won: false, buyPrice: 1, profit: -1, quotedPayout: Number.NaN }), 1);
  });

  it("a win uses the realised multiplier (buy + profit) / buy", () => {
    assert.equal(ledgerPayoutFor({ won: true, buyPrice: 2, profit: 1.9, quotedPayout: 1.95 }), 1.95);
  });
});
