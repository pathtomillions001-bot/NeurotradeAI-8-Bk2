import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findTransaction,
  isUnsettledTradeRecord,
  NO_PURCHASE_CONFIRMED_MARKER,
} from "./trade-reconciler.ts";

const row = {
  id: 1,
  sessionId: "session-a",
  symbol: "R_10",
  contractType: "CALL",
  stake: "1.00",
  derivContractId: null,
  agentReasoning: null,
  createdAt: new Date(1_700_000_000_000),
};

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    contract_id: 44,
    underlying_symbol: "R_10",
    contract_type: "RISE",
    buy_price: 1,
    purchase_time: 1_700_000_000,
    sell_price: 1.9,
    ...overrides,
  };
}

describe("unsettled autonomous trade reconciliation", () => {
  it("uses an exact contract id and never falls back to another same-stake contract", () => {
    const knownId = { ...row, derivContractId: "99" };
    assert.equal(findTransaction(knownId, [transaction({ contract_id: 44 })]), null);
    assert.equal(findTransaction(knownId, [transaction({ contract_id: 99 })])?.contract_id, 99);
  });

  it("requires an unambiguous, closest fuzzy match when older rows lack an id", () => {
    assert.equal(findTransaction(row, [
      transaction({ contract_id: 44, purchase_time: 1_700_000_000 }),
      transaction({ contract_id: 45, purchase_time: 1_700_000_001 }),
    ]), null);

    const nearest = findTransaction(row, [
      transaction({ contract_id: 44, purchase_time: 1_700_000_040 }),
      transaction({ contract_id: 45, purchase_time: 1_700_000_100 }),
    ]);
    assert.equal(nearest?.contract_id, 44);
  });

  it("does not fuzzy-match if required identity fields are missing", () => {
    assert.equal(findTransaction(row, [transaction({ underlying_symbol: undefined })]), null);
    assert.equal(findTransaction(row, [transaction({ contract_type: undefined })]), null);
    assert.equal(findTransaction(row, [transaction({ purchase_time: undefined })]), null);
  });

  it("blocks new orders for open/unknown rows but ignores confirmed no-buy failures", () => {
    assert.equal(isUnsettledTradeRecord({ status: "open" }), true);
    assert.equal(isUnsettledTradeRecord({ status: "error", agentReasoning: "timeout; outcome unknown" }), true);
    assert.equal(isUnsettledTradeRecord({ status: "error", agentReasoning: NO_PURCHASE_CONFIRMED_MARKER }), false);
    assert.equal(isUnsettledTradeRecord({ status: "won" }), false);
    assert.equal(isUnsettledTradeRecord({ status: "lost" }), false);
  });
});
