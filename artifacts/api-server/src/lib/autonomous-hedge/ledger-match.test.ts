import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchAutonomousRows, pickUniquePurchase, portfolioAsTransaction, settledProfit, type DerivTx, type ReconRow } from "./ledger-match";

const created = new Date("2026-10-09T10:00:00Z");
const createdSec = Math.floor(created.getTime() / 1000);

function row(over: Partial<ReconRow> = {}): ReconRow {
  return { id: 1, symbol: "R_100", contractType: "CALL", stake: "1.00", derivContractId: null, createdAt: created, ...over };
}

function tx(over: Partial<DerivTx> = {}): DerivTx {
  return {
    contract_id: 900,
    contract_type: "CALL",
    underlying_symbol: "R_100",
    buy_price: 1,
    sell_price: 1.9,
    purchase_time: createdSec + 1,
    sell_time: createdSec + 2,
    ...over,
  };
}

describe("autonomous ledger matching", () => {
  it("matches a row to its exact contract id", () => {
    const r = row({ id: 1, derivContractId: "900" });
    const out = matchAutonomousRows([r], [tx({ contract_id: 900 })], new Set());
    assert.equal(out.get(1)?.contract_id, 900);
  });

  it("matches a no-id row only when the pairing is unique in both directions", () => {
    const out = matchAutonomousRows([row()], [tx()], new Set());
    assert.equal(out.get(1)?.contract_id, 900);
  });

  it("never matches a no-id row when two transactions fit it", () => {
    const out = matchAutonomousRows([row()], [tx({ contract_id: 900 }), tx({ contract_id: 901 })], new Set());
    assert.equal(out.size, 0);
  });

  it("never matches a contract already attached to a row", () => {
    const out = matchAutonomousRows([row()], [tx({ contract_id: 900 })], new Set(["900"]));
    assert.equal(out.size, 0);
  });

  it("rejects transactions with a different symbol, family, stake or time", () => {
    assert.equal(matchAutonomousRows([row()], [tx({ underlying_symbol: "R_50" })], new Set()).size, 0);
    assert.equal(matchAutonomousRows([row()], [tx({ contract_type: "PUT" })], new Set()).size, 0);
    assert.equal(matchAutonomousRows([row()], [tx({ buy_price: 2 })], new Set()).size, 0);
    assert.equal(matchAutonomousRows([row()], [tx({ purchase_time: createdSec + 10_000 })], new Set()).size, 0);
  });

  it("accepts RISE for a CALL row (Deriv journal naming)", () => {
    assert.equal(matchAutonomousRows([row()], [tx({ contract_type: "RISE" })], new Set()).size, 1);
  });

  it("settles profit as sell minus buy and reports the outcome", () => {
    assert.deepEqual(settledProfit(tx({ buy_price: 1, sell_price: 1.9 })), { buy: 1, sell: 1.9, profit: 0.9, won: true });
    assert.deepEqual(settledProfit(tx({ buy_price: 1, sell_price: 0 })), { buy: 1, sell: 0, profit: -1, won: false });
  });

  it("picks the single unclaimed purchase that fits an ambiguous buy", () => {
    const r = row();
    const picked = pickUniquePurchase(r, [tx({ contract_id: 901 }), tx({ contract_id: 902, buy_price: 9 })], new Set());
    assert.equal(picked?.contract_id, 901);
  });

  it("returns null when two unclaimed purchases fit an ambiguous buy", () => {
    assert.equal(pickUniquePurchase(row(), [tx({ contract_id: 1 }), tx({ contract_id: 2 })], new Set()), null);
  });

  it("ignores claimed purchases and de-duplicates the same contract seen twice", () => {
    const r = row();
    assert.equal(pickUniquePurchase(r, [tx({ contract_id: 5 })], new Set(["5"])), null);
    const dup = pickUniquePurchase(r, [tx({ contract_id: 7 }), tx({ contract_id: 7 })], new Set());
    assert.equal(dup?.contract_id, 7);
  });

  it("maps a portfolio entry into the purchase shape", () => {
    const mapped = portfolioAsTransaction({ contract_id: 3, contract_type: "PUT", symbol: "R_25", buy_price: 1, purchase_time: 5 });
    assert.equal(mapped.contract_id, 3);
    assert.equal(mapped.underlying_symbol, "R_25");
    assert.equal(mapped.purchase_time, 5);
  });
});
