import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  closeAccountConnections,
  executeLiveTrade,
  getAccountConnection,
  isRetryableDerivError,
  UnknownContractProposalError,
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

  // ── The reported failure: "Deriv rejected 3 consecutive 1-tick buys — last:
  // Unknown contract proposal". A buy handed a proposal id the receiving session
  // does not know created NO contract, so the purchase is completed on a fresh
  // quote instead of costing the engine one of its three strikes.
  const deadProposal = {
    error: { code: "InvalidContractProposal", message: "Unknown contract proposal" },
  };

  it("completes the purchase when the broker has forgotten the proposal id", async () => {
    let quotes = 0;
    const sent = fakeTransport((m) => {
      if (m.proposal) {
        quotes += 1;
        return { msg_type: "proposal", proposal: { id: `proposal-${quotes}`, ask_price: quotes, payout: 1.63 } };
      }
      return m.buy === "proposal-1" ? deadProposal : purchase;
    });
    const result = await executeLiveTrade(token, params);
    assert.equal(result.contractId, 1234);
    assert.equal(sent.filter((m) => m.proposal).length, 2);
    const buys = sent.filter((m) => m.buy);
    assert.equal(buys.length, 2);
    // The replay buys the NEW id, at that quote's OWN ask price.
    assert.deepEqual(buys.map((m) => m.buy), ["proposal-1", "proposal-2"]);
    assert.deepEqual(buys.map((m) => m.price), [1, 2]);
  });

  it("recognises the reported broker sentence even when it carries no error code", async () => {
    let quotes = 0;
    const sent = fakeTransport((m) => {
      if (m.proposal) {
        quotes += 1;
        return { msg_type: "proposal", proposal: { id: `proposal-${quotes}`, ask_price: 1 } };
      }
      return m.buy === "proposal-1" ? { error: { message: "Unknown contract proposal" } } : purchase;
    });
    const result = await executeLiveTrade(token, params);
    assert.equal(result.contractId, 1234);
    assert.equal(sent.filter((m) => m.buy).length, 2);
  });

  it("re-quotes a dead proposal id at most once, then reports the code", async () => {
    const sent = fakeTransport((m) => m.proposal
      ? { msg_type: "proposal", proposal: { id: "dead", ask_price: 1 } }
      : deadProposal);
    await assert.rejects(
      executeLiveTrade(token, params),
      (err: unknown) => {
        // Typed as a no-trade outcome: at the buy stage Deriv created no
        // contract, so the autonomous engine must not count this toward its
        // consecutive-execution-failure stop.
        assert.ok(err instanceof UnknownContractProposalError);
        assert.match((err as Error).message, /Unknown contract proposal \(Deriv code InvalidContractProposal\)/);
        return true;
      },
    );
    assert.equal(sent.filter((m) => m.proposal).length, 2);
    assert.equal(sent.filter((m) => m.buy).length, 2);
  });

  it("never re-quotes a contract this account is not offered at all", async () => {
    // The same words from the PROPOSAL stage are a capability verdict, not a
    // dead quote: deterministic, so it must fail fast without a second request.
    const sent = fakeTransport(() => deadProposal);
    await assert.rejects(
      executeLiveTrade(token, params),
      (err: unknown) => {
        assert.ok(!(err instanceof UnknownContractProposalError), "a proposal-stage refusal stays a plain, countable failure");
        assert.match((err as Error).message, /Unknown contract proposal \(Deriv code InvalidContractProposal\)/);
        return true;
      },
    );
    assert.equal(sent.length, 1);
    assert.equal(sent.filter((m) => m.buy).length, 0);
  });

  it("serialises purchases on one account: the second trade quotes only after the first buy is acknowledged", async () => {
    // The reported production failure: concurrent purchases on one Deriv
    // account interleaved proposal → buy on the shared socket, so buys were
    // handed proposal ids Deriv no longer knew. Only the single analysed,
    // timed trade may be in flight; the next one quotes fresh when its turn
    // comes — never alongside the trade ahead of it.
    let releaseFirstBuy!: () => void;
    const firstBuyGate = new Promise<void>((resolve) => { releaseFirstBuy = resolve; });
    let buys = 0;
    const sent = fakeTransport((m) => {
      if (m.proposal) return proposal;
      buys += 1;
      return buys === 1 ? firstBuyGate.then(() => purchase) : purchase;
    });

    const first = executeLiveTrade(token, params);
    while (!sent.some((m) => m.buy)) await new Promise((r) => setTimeout(r, 5));

    const second = executeLiveTrade(token, params);
    // Give the second purchase every chance to interleave if it could.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.filter((m) => m.proposal).length, 1, "the second trade must not quote while the first buy is in flight");
    assert.equal(sent.filter((m) => m.buy).length, 1, "exactly one buy may be in flight per account");

    releaseFirstBuy();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.contractId, 1234);
    assert.equal(b.contractId, 1234);
    assert.deepEqual(
      sent.map((m) => (m.proposal ? "proposal" : "buy")),
      ["proposal", "buy", "proposal", "buy"],
      "each purchase is a complete, uninterleaved proposal → buy sequence",
    );
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
