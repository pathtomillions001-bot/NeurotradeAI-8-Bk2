import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  closeAccountConnections,
  executeLiveTrade,
  getAccountConnection,
  isRetryableDerivError,
  waitForContractResult,
} from "./deriv";

// No broker credentials or network: stub the account transport, not the
// production proposal -> buy function that all single-order callers share.
const token = "single-trade-test-token";
const params = {
  accountId: "single-trade-test-account",
  symbol: "R_10",
  contractType: "DIGITOVER",
  barrier: 3,
  stake: 1,
  duration: 1,
  durationUnit: "t",
  currency: "USD",
};
const proposal = {
  msg_type: "proposal",
  proposal: { id: "one-proposal", ask_price: 1, payout: 1.63 },
};
const purchase = {
  msg_type: "buy",
  buy: { contract_id: 1234, buy_price: 1, longcode: "One contract" },
};

afterEach(() => {
  mock.restoreAll();
  closeAccountConnections();
});

function fakeTransport(reply: (message: any) => any) {
  const sent: any[] = [];
  const connection = getAccountConnection(token, params.accountId);
  mock.method(connection, "request", async (message: any) => {
    sent.push(message);
    return reply(message);
  });
  return sent;
}

describe("single-contract execution", () => {
  it("quotes the selected contract and buys exactly one proposal", async () => {
    const sent = fakeTransport((m) => m.proposal ? proposal : purchase);
    const result = await executeLiveTrade(token, params);
    assert.equal(result.contractId, 1234);
    assert.deepEqual(sent, [
      {
        proposal: 1,
        amount: 1,
        basis: "stake",
        contract_type: "DIGITOVER",
        currency: "USD",
        duration: 1,
        duration_unit: "t",
        underlying_symbol: "R_10",
        barrier: "3",
      },
      { buy: "one-proposal", price: 1 },
    ]);
  });

  it("can retry a throttled quote without multiplying purchases", async () => {
    let quotes = 0;
    const sent = fakeTransport((m) => {
      if (!m.proposal) return purchase;
      return ++quotes === 1
        ? { error: { code: "RateLimit", message: "Too many requests" } }
        : proposal;
    });
    await executeLiveTrade(token, params);
    assert.equal(sent.filter((m) => m.proposal).length, 2);
    assert.equal(sent.filter((m) => m.buy).length, 1);
  });

  it("does not buy when the proposal is rejected", async () => {
    const sent = fakeTransport(() => ({
      error: { code: "InvalidContract", message: "Invalid contract" },
    }));
    await assert.rejects(executeLiveTrade(token, params), /Invalid contract/);
    assert.equal(sent.length, 1);
    assert.equal(sent.filter((m) => m.buy).length, 0);
  });

  it("never automatically repeats an unacknowledged purchase", async () => {
    const sent = fakeTransport((m) => m.proposal ? proposal : null);
    await assert.rejects(executeLiveTrade(token, params), /did not confirm the purchase/);
    assert.equal(sent.filter((m) => m.buy).length, 1);
  });

  it("never retries a rejected buy, even for a transient broker error", async () => {
    const sent = fakeTransport((m) => m.proposal ? proposal : {
      error: { code: "RateLimit", message: "Rate limit on purchase" },
    });
    await assert.rejects(executeLiveTrade(token, params), /Rate limit on purchase/);
    assert.equal(sent.filter((m) => m.buy).length, 1);
  });

  for (const [unit, factor] of [["seconds", 1], ["milliseconds", 1000]] as const) {
    it(`preserves single-contract settlement with broker timestamps in ${unit}`, async () => {
      const sent = fakeTransport((m) => m.portfolio
        ? { portfolio: { contracts: [] } }
        : { profit_table: { transactions: [{
            contract_id: 1234,
            buy_price: 1,
            sell_price: 1.63,
            purchase_time: 1_750_000_000 * factor,
            sell_time: 1_750_000_002 * factor,
          }] } });
      const result = await waitForContractResult(token, params.accountId, 1234);
      assert.equal(result.contractId, 1234);
      assert.equal(result.won, true);
      assert.ok(Math.abs(result.profit - 0.63) < 1e-10);
      assert.equal(result.purchasedAtMs, 1_750_000_000_000);
      assert.equal(result.exitedAtMs, 1_750_000_002_000);
      assert.equal(sent.length, 2);
      assert.equal(sent.filter((m) => m.buy).length, 0);
    });
  }

  it("retains the shared single-order quote retry classification", () => {
    assert.equal(isRetryableDerivError({ error: { code: "RateLimit" } }), true);
    assert.equal(isRetryableDerivError({ error: { code: "TemporaryUnavailable" } }), true);
    assert.equal(isRetryableDerivError({ error: { code: "InsufficientBalance" } }), false);
    assert.equal(isRetryableDerivError({ error: { code: "InvalidBarrier" } }), false);
  });
});
