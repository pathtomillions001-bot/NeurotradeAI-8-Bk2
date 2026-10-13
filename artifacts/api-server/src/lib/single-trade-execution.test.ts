import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  closeAccountConnections,
  executeLiveTrade,
  UnsupportedDerivProposalError,
  getAccountConnection,
  isLiveOrderInFlight,
  isRetryableDerivError,
  LiveOrderInFlightError,
  proposalNeedsRefresh,
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
  mock.method(connection, "request", async (message: any, _timeoutMs?: number, hooks?: { beforeSend?: () => void; onSent?: () => void }) => {
    // Mimic production order: validate before send, capture session, then reply.
    hooks?.beforeSend?.();
    hooks?.onSent?.();
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
      /Unknown contract proposal \(Deriv code InvalidContractProposal\)/,
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
      UnsupportedDerivProposalError,
    );
    assert.equal(sent.length, 1);
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

  // ── One account = one order pipeline ────────────────────────────────────────
  // Racing purchases are what interleave proposals and buys on the shared socket,
  // and an interleaved buy is what Deriv refuses with a dead proposal id. The
  // reported engine failure ("3 consecutive 1-tick buys — last: Unknown contract
  // proposal") is exactly that: trades that should never have been concurrent.
  it("never runs two purchase pipelines at once on one account", async () => {
    let releaseProposal!: () => void;
    const proposalGate = new Promise<void>((resolve) => { releaseProposal = resolve; });
    const sent: any[] = [];
    const connection = getAccountConnection(token, params.accountId);
    mock.method(connection, "request", async (message: any) => {
      sent.push(message);
      if (message.proposal) {
        await proposalGate;
        return proposal;
      }
      return purchase;
    });

    const first = executeLiveTrade(token, params);
    // The first call is now parked inside its proposal: it holds the order slot.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(isLiveOrderInFlight(params.accountId), true, "the account's order slot is held while an order is in flight");
    await assert.rejects(executeLiveTrade(token, params), LiveOrderInFlightError);

    releaseProposal();
    const result = await first;
    assert.equal(result.contractId, 1234);
    assert.equal(sent.filter((m) => m.proposal).length, 1, "the skipped caller never even quoted");
    assert.equal(sent.filter((m) => m.buy).length, 1, "exactly one purchase left the account");
    assert.equal(isLiveOrderInFlight(params.accountId), false, "the slot is released when the order ends");
  });

  it("releases the order slot even when the purchase is refused", async () => {
    fakeTransport(() => ({ error: { code: "InvalidContract", message: "Invalid contract" } }));
    await assert.rejects(executeLiveTrade(token, params), /Invalid contract/);
    assert.equal(isLiveOrderInFlight(params.accountId), false, "a refusal must not wedge the account's order slot");
  });

  // ── A buy must ride the session that quoted it ──────────────────────────────
  // A proposal id only exists inside the socket session that issued it. If the
  // socket re-handshook between the two calls, the id is dead — buying it anyway
  // is what produced "Unknown contract proposal" on a 1-tick buy.
  it("re-quotes when the socket reconnects while the proposal response is in flight", async () => {
    let generation = 1;
    let quotes = 0;
    const sent: any[] = [];
    const connection = getAccountConnection(token, params.accountId);
    mock.method(connection, "sessionGeneration", () => generation);
    mock.method(connection, "request", async (message: any, _timeoutMs?: number, hooks?: { beforeSend?: () => void; onSent?: () => void }) => {
      hooks?.beforeSend?.();
      hooks?.onSent?.();
      sent.push(message);
      if (message.proposal) {
        const quoteNumber = ++quotes;
        // The first quote was sent on generation 1, but its response arrives
        // after the socket has reconnected to generation 2.
        if (quoteNumber === 1) generation = 2;
        return {
          msg_type: "proposal",
          proposal: { id: `proposal-${quoteNumber}`, ask_price: quoteNumber, payout: 1.63 },
        };
      }
      return purchase;
    });

    const result = await executeLiveTrade(token, params);
    assert.equal(result.contractId, 1234);
    assert.equal(sent.filter((m) => m.proposal).length, 2, "the pre-reconnect quote is replaced");
    assert.deepEqual(
      sent.filter((m) => m.buy).map((m) => m.buy),
      ["proposal-2"],
      "only the proposal issued by the current session is bought",
    );
  });

  it("re-quotes when the session changes after preflight but before the BUY is sent", async () => {
    let generation = 1;
    let quotes = 0;
    const sent: any[] = [];
    const connection = getAccountConnection(token, params.accountId);
    mock.method(connection, "sessionGeneration", () => generation);
    mock.method(connection, "request", async (message: any, _timeoutMs?: number, hooks?: { beforeSend?: () => void; onSent?: () => void }) => {
      // Simulate a reconnect while the queued BUY is waiting, after preflight.
      // The beforeSend guard must block this stale request before recording it.
      if (message.buy && generation === 1) generation = 2;
      hooks?.beforeSend?.();
      hooks?.onSent?.();
      sent.push(message);
      if (message.proposal) {
        const n = ++quotes;
        return { msg_type: "proposal", proposal: { id: `proposal-${n}`, ask_price: n, payout: 1.63 } };
      }
      return purchase;
    });

    const result = await executeLiveTrade(token, params);
    assert.equal(result.contractId, 1234);
    assert.equal(sent.filter((m) => m.proposal).length, 2, "a new proposal is requested after reconnect");
    assert.equal(sent.filter((m) => m.buy).length, 1, "only one BUY is sent");
    assert.equal(sent.filter((m) => m.buy)[0].buy, "proposal-2", "the stale proposal is never purchased");
  });

  it("re-quotes and buys the fresh id when the socket re-handshook after the quote", async () => {
    let generations = 0;
    let quotes = 0;
    const sent = fakeTransport((m) => m.proposal
      ? { msg_type: "proposal", proposal: { id: `proposal-${++quotes}`, ask_price: 1, payout: 1.63 } }
      : purchase);
    const connection = getAccountConnection(token, params.accountId);
    // First read is the session that quoted (1); the re-handshake happens before
    // the buy, so every later read reports the new session (2).
    mock.method(connection, "sessionGeneration", () => (++generations === 1 ? 1 : 2));

    const result = await executeLiveTrade(token, params);
    assert.equal(result.contractId, 1234);
    assert.equal(sent.filter((m) => m.proposal).length, 2, "the dead quote is replaced");
    assert.deepEqual(
      sent.filter((m) => m.buy).map((m) => m.buy),
      ["proposal-2"],
      "the buy carries the id of the session that is live, never the abandoned one",
    );
  });

  it("measures proposal age from send time when the quote response is delayed", async () => {
    let clock = 1_000_000;
    mock.method(Date, "now", () => clock);
    try {
      let quotes = 0;
      const sent: any[] = [];
      const connection = getAccountConnection(token, params.accountId);
      mock.method(connection, "request", async (message: any, _timeoutMs?: number, hooks?: { beforeSend?: () => void; onSent?: () => void }) => {
        hooks?.beforeSend?.();
        hooks?.onSent?.();
        sent.push(message);
        if (message.proposal) {
          const n = ++quotes;
          if (n === 1) clock += 5_000; // response arrives after the quote has expired
          return { msg_type: "proposal", proposal: { id: `proposal-${n}`, ask_price: 1, payout: 1.63 } };
        }
        return purchase;
      });
      const result = await executeLiveTrade(token, params);
      assert.equal(result.contractId, 1234);
      assert.equal(sent.filter((m) => m.proposal).length, 2, "the delayed quote is replaced");
      assert.deepEqual(sent.filter((m) => m.buy).map((m) => m.buy), ["proposal-2"]);
    } finally {
      mock.restoreAll();
    }
  });

  it("re-quotes a quote that ages out while the BUY waits in the socket queue", async () => {
    let clock = 1_000_000;
    mock.method(Date, "now", () => clock);
    try {
      let quotes = 0;
      let agedFirstBuy = false;
      const sent: any[] = [];
      const connection = getAccountConnection(token, params.accountId);
      mock.method(connection, "request", async (message: any, _timeoutMs?: number, hooks?: { beforeSend?: () => void; onSent?: () => void }) => {
        // Advance time only after preflight and just before the first buy's
        // send guard, simulating a queue/rate-limit delay rather than making
        // every operation take five seconds.
        if (message.buy && !agedFirstBuy) {
          agedFirstBuy = true;
          clock += 5_000;
        }
        hooks?.beforeSend?.();
        hooks?.onSent?.();
        sent.push(message);
        if (message.proposal) {
          const n = ++quotes;
          return { msg_type: "proposal", proposal: { id: `proposal-${n}`, ask_price: 1, payout: 1.63 } };
        }
        return purchase;
      });
      const result = await executeLiveTrade(token, params);
      assert.equal(result.contractId, 1234);
      assert.equal(sent.filter((m) => m.proposal).length, 2, "the aged quote is replaced");
      assert.deepEqual(sent.filter((m) => m.buy).map((m) => m.buy), ["proposal-2"]);
    } finally {
      mock.restoreAll();
    }
  });

  it("buys without a needless re-quote while the quote is fresh and its session is live", async () => {
    const sent = fakeTransport((m) => (m.proposal ? proposal : purchase));
    const connection = getAccountConnection(token, params.accountId);
    mock.method(connection, "sessionGeneration", () => 1);
    const result = await executeLiveTrade(token, params);
    assert.equal(result.contractId, 1234);
    assert.equal(sent.filter((m) => m.proposal).length, 1, "a fresh quote on the live session is bought as-is");
    // The buy is a PRIORITY message so the paced queue cannot push it past the
    // proposal's short life.
    assert.equal((connection.request as any).mock.calls.at(-1).arguments[2]?.priority, true);
  });

  it("classifies a quote by session and age", () => {
    const quoted = { generation: 7, quotedAtMs: 1_000_000 };
    assert.equal(proposalNeedsRefresh(quoted, 7, 1_000_500), false, "same session, young id");
    assert.equal(proposalNeedsRefresh(quoted, 8, 1_000_500), true, "a re-handshake invalidates the id");
    assert.equal(proposalNeedsRefresh(quoted, 7, 1_060_000), true, "an id older than a proposal's life is dead");
  });

  it("retains the shared single-order quote retry classification", () => {
    assert.equal(isRetryableDerivError({ error: { code: "RateLimit" } }), true);
    assert.equal(isRetryableDerivError({ error: { code: "TemporaryUnavailable" } }), true);
    assert.equal(isRetryableDerivError({ error: { code: "InsufficientBalance" } }), false);
    assert.equal(isRetryableDerivError({ error: { code: "InvalidBarrier" } }), false);
  });
});
