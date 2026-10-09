import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  closeAccountConnections,
  DerivTradeError,
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

beforeEach(() => {
  // Settlement snapshots are now cached per account. Isolate each fixture so
  // it actually reaches its own stub rather than reusing a prior test's data.
  params.accountId = `single-trade-test-${randomUUID()}`;
});

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

  // ── The "Unknown contract proposal" handoff ─────────────────────────────────
  // Deriv answers a `buy` whose proposal ID it does not know with
  // InvalidContractProposal / "Unknown contract proposal". That rejection is
  // proof no contract exists, so the purchase is completed once against a FRESH
  // quote. It is the one rejection that may be re-quoted; every other one still
  // fails on the first attempt.
  it("completes the single purchase once when the proposal id is rejected as unknown", async () => {
    let quotes = 0;
    let buys = 0;
    const sent = fakeTransport((m) => {
      if (m.proposal) {
        quotes += 1;
        return { msg_type: "proposal", proposal: { id: `proposal-${quotes}`, ask_price: 1, payout: 1.63 } };
      }
      buys += 1;
      return buys === 1
        ? { msg_type: "buy", error: { code: "InvalidContractProposal", message: "Unknown contract proposal" } }
        : purchase;
    });

    const result = await executeLiveTrade(token, params);

    assert.equal(result.contractId, 1234, "the trade the caller asked for is placed exactly once");
    assert.equal(sent.filter((m) => m.proposal).length, 2, "one stale quote, one fresh quote");
    const buyMessages = sent.filter((m) => m.buy);
    assert.equal(buyMessages.length, 2, "the refused purchase placed nothing, so one more is allowed");
    assert.deepEqual(
      buyMessages.map((m) => m.buy),
      ["proposal-1", "proposal-2"],
      "the retry buys the FRESH proposal id, never the refused one",
    );
  });

  it("never sends a third purchase when the fresh quote is refused the same way", async () => {
    let quotes = 0;
    const sent = fakeTransport((m) => m.proposal
      ? { msg_type: "proposal", proposal: { id: `proposal-${++quotes}`, ask_price: 1, payout: 1.63 } }
      : { msg_type: "buy", error: { code: "InvalidContractProposal", message: "Unknown contract proposal" } });

    const err = await executeLiveTrade(token, params).then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(err instanceof DerivTradeError);
    assert.equal(err.stage, "buy");
    assert.equal(err.code, "InvalidContractProposal");
    assert.equal(err.kind, "unknown-proposal");
    assert.equal(err.symbol, params.symbol);
    assert.equal(err.contractType, params.contractType);
    assert.match(err.message, /Unknown contract proposal/);
    assert.equal(sent.filter((m) => m.buy).length, 2, "exactly one re-quote — never an unbounded retry loop");
  });

  it("never buys a proposal the account itself was refused, and says why", async () => {
    // The SAME broker text out of `proposal` means this account is not offered
    // that contract: retrying would fail identically on every tick.
    const sent = fakeTransport(() => ({
      msg_type: "proposal",
      error: { code: "InvalidContractProposal", message: "Unknown contract proposal" },
    }));

    const err = await executeLiveTrade(token, params).then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(err instanceof DerivTradeError);
    assert.equal(err.stage, "proposal");
    assert.equal(err.kind, "contract-unavailable");
    assert.equal(sent.length, 1, "no re-quote");
    assert.equal(sent.filter((m) => m.buy).length, 0);
  });

  it("keeps the broker code on an account-level refusal", async () => {
    const sent = fakeTransport(() => ({
      msg_type: "proposal",
      error: { code: "InsufficientBalance", message: "Insufficient balance" },
    }));

    const caught = await executeLiveTrade(token, params).then(
      () => null,
      (error: unknown) => error,
    );

    assert.ok(caught instanceof DerivTradeError);
    assert.equal(caught.kind, "account-blocked");
    assert.equal(caught.stage, "proposal");
    assert.match(caught.message, /Deriv code InsufficientBalance/);
    assert.equal(sent.filter((m) => m.buy).length, 0);
  });

  for (const [unit, factor] of [["seconds", 1], ["milliseconds", 1000]] as const) {
    it(`preserves single-contract settlement with broker timestamps in ${unit}`, async () => {
      const sent = fakeTransport(() => ({
        profit_table: { transactions: [{
          contract_id: 1234,
          buy_price: 1,
          sell_price: 1.63,
          purchase_time: 1_750_000_000 * factor,
          sell_time: 1_750_000_002 * factor,
        }] },
      }));
      const result = await waitForContractResult(token, params.accountId, 1234);
      assert.equal(result.contractId, 1234);
      assert.equal(result.won, true);
      assert.ok(Math.abs(result.profit - 0.63) < 1e-10);
      assert.equal(result.purchasedAtMs, 1_750_000_000_000);
      assert.equal(result.exitedAtMs, 1_750_000_002_000);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].profit_table, 1);
      assert.equal(sent[0].description, 1);
      assert.equal(sent.filter((m) => m.buy).length, 0);
    });
  }

  it("shares one settlement snapshot across concurrent single-contract waiters", async () => {
    const sent = fakeTransport(() => ({
      profit_table: { transactions: [
        { contract_id: 1234, buy_price: 1, sell_price: 1.63 },
        { contract_id: 5678, buy_price: 1, sell_price: 0 },
      ] },
    }));
    const [won, lost] = await Promise.all([
      waitForContractResult(token, params.accountId, 1234),
      waitForContractResult(token, params.accountId, 5678),
    ]);
    assert.equal(won.contractId, 1234);
    assert.equal(won.won, true);
    assert.equal(lost.contractId, 5678);
    assert.equal(lost.won, false);
    assert.equal(lost.profit, -1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].profit_table, 1);

    // A later waiter inside the snapshot window also reuses the result.
    await waitForContractResult(token, params.accountId, 1234);
    assert.equal(sent.length, 1);
    assert.equal(sent.filter((m) => m.buy).length, 0);
  });

  it("retains the shared single-order quote retry classification", () => {
    assert.equal(isRetryableDerivError({ error: { code: "RateLimit" } }), true);
    assert.equal(isRetryableDerivError({ error: { code: "TemporaryUnavailable" } }), true);
    assert.equal(isRetryableDerivError({ error: { code: "InsufficientBalance" } }), false);
    assert.equal(isRetryableDerivError({ error: { code: "InvalidBarrier" } }), false);
  });
});
