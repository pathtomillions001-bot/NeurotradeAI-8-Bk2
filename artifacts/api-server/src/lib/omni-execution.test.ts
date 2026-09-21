import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  omniContracts,
  priceOmniOpportunity,
  type OmniRisk,
} from "./omni-analysis";
import {
  matchOmniPurchase,
  omniTickIsExecutable,
  placeOmniOrder,
  readOmniQuote,
  type OmniBroker,
} from "./omni-execution";
import { DigitTape, type DigitTick } from "./digit-tape";

const risk: OmniRisk = {
  baseStake: 1,
  debt: 0,
  markupPercent: 10,
  balance: 1000,
  maxStake: 100,
  lossBudget: 100,
};
const prediction = {
  contract: omniContracts(["DIGITEVEN"])[0]!,
  probability: 0.8,
  rawProbability: 0.8,
  uncertainty: 0.005,
  lossAfterLoss: 0.2,
  samples: 500,
  expertWeights: [0.2, 0.2, 0.2, 0.2, 0.2],
};
const market = { symbol: "R_10", displayName: "Volatility 10" };
const shot = priceOmniOpportunity(prediction, market, risk);
function fixture(
  options: {
    payout?: number;
    buy?: "unknown" | "throw" | "rejected";
    lateQueue?: boolean;
  } = {},
) {
  const calls: Record<string, unknown>[] = [];
  let allowed = true;
  let prepared = 0;
  let sent = 0;
  const broker: OmniBroker = {
    async request(message, _timeout, hooks) {
      if (message.buy && options.lateQueue) allowed = false;
      hooks?.beforeSend?.();
      hooks?.onSent?.();
      calls.push(message);
      if (message.proposal)
        return {
          proposal: {
            id: `q${calls.length}`,
            ask_price: message.amount,
            payout: Number(message.amount) * (options.payout ?? 1.95),
          },
        };
      if (options.buy === "unknown") return null;
      if (options.buy === "throw") throw new Error("Socket dropped after send");
      if (options.buy === "rejected")
        return { error: { message: "Insufficient balance" } };
      return { buy: { contract_id: 991, buy_price: message.price } };
    },
  };
  return {
    calls,
    cancel: () => {
      allowed = false;
    },
    get prepared() {
      return prepared;
    },
    get sent() {
      return sent;
    },
    input: {
      opportunity: shot,
      currency: "USD",
      broker,
      guard: () => {
        if (!allowed) throw new Error("Cancelled while queued");
      },
      reprice: (multiplier: number) =>
        priceOmniOpportunity(prediction, market, risk, multiplier, "live"),
      prepare: async () => {
        prepared++;
      },
      onBuySent: () => {
        sent++;
      },
    },
  };
}

describe("Omni live order commit", () => {
  it("requires a valid broker quote, journals first, then confirms exactly one buy", async () => {
    const f = fixture();
    let preparedBeforeSend = false;
    const result = await placeOmniOrder({
      ...f.input,
      onBuySent: () => {
        preparedBeforeSend = f.prepared === 1;
        f.input.onBuySent();
      },
    });
    assert.equal(result.kind, "bought");
    assert.equal(result.kind === "bought" && result.contractId, 991);
    assert.equal(f.calls.filter((x) => x.buy).length, 1);
    assert.equal(f.sent, 1);
    assert.ok(preparedBeforeSend);
    assert.equal(f.calls[0]?.underlying_symbol, "R_10");
    assert.equal(f.calls[0]?.duration, 1);
  });
  it("does not buy when the real payout invalidates the estimated opportunity", async () => {
    const f = fixture({ payout: 1.1 });
    const result = await placeOmniOrder(f.input);
    assert.equal(result.kind, "skipped");
    assert.equal(f.sent, 0);
    assert.equal(f.prepared, 0);
  });
  it("does not turn an unavailable quote into a fallback-priced live order", async () => {
    const f = fixture();
    f.input.broker.request = async () => ({
      error: { message: "Unsupported contract" },
    });
    const result = await placeOmniOrder(f.input);
    assert.equal(result.kind, "skipped");
    assert.equal(result.kind === "skipped" && result.quoteUnavailable, true);
    assert.equal(f.sent, 0);
  });
  it("re-quotes at the actual recovery stake when a changed payout alters sizing", async () => {
    const f = fixture({ payout: 2.1 });
    const recoveryRisk = { ...risk, debt: 1 };
    const initial = priceOmniOpportunity(
      prediction,
      market,
      recoveryRisk,
      1.95,
    );
    assert.equal(initial.stake, 1.16);
    const result = await placeOmniOrder({
      ...f.input,
      opportunity: initial,
      reprice: (multiplier) =>
        priceOmniOpportunity(
          prediction,
          market,
          recoveryRisk,
          multiplier,
          "live",
        ),
    });
    assert.equal(result.kind, "bought");
    assert.deepEqual(
      f.calls.filter((x) => x.proposal).map((x) => x.amount),
      [1.16, 1],
    );
    assert.equal(f.calls.filter((x) => x.buy)[0]?.price, 1);
  });
  it("honors Stop after a proposal and while the actual buy waits in the socket queue", async () => {
    const prepareStop = fixture();
    const stopped = await placeOmniOrder({
      ...prepareStop.input,
      prepare: async () => {
        prepareStop.cancel();
      },
    });
    assert.equal(stopped.kind, "skipped");
    assert.equal(prepareStop.sent, 0);
    const queued = fixture({ lateQueue: true });
    const late = await placeOmniOrder(queued.input);
    assert.equal(late.kind, "skipped");
    assert.equal(queued.sent, 0);
    assert.equal(queued.calls.filter((x) => x.buy).length, 0);
  });
  it("never sends a buy when durable journaling fails", async () => {
    const f = fixture();
    const result = await placeOmniOrder({
      ...f.input,
      prepare: async () => {
        throw new Error("Database offline");
      },
    });
    assert.equal(result.kind, "skipped");
    assert.equal(f.sent, 0);
  });
  it("treats lost acknowledgements and post-send errors as UNKNOWN, never retryable losses", async () => {
    for (const buy of ["unknown", "throw"] as const) {
      const f = fixture({ buy });
      const result = await placeOmniOrder(f.input);
      assert.equal(result.kind, "unknown");
      assert.equal(f.calls.filter((x) => x.buy).length, 1);
      assert.equal(f.sent, 1);
    }
    const rejected = fixture({ buy: "rejected" });
    assert.equal(
      (await placeOmniOrder(rejected.input)).kind,
      "skipped",
      "an explicit broker rejection proves no purchase",
    );
  });
  it("rejects malformed/non-finite proposals", () => {
    for (const proposal of [
      null,
      {},
      { id: "a", ask_price: 1, payout: "NaN" },
      { id: "a", ask_price: 1, payout: 1 },
      { id: "a", ask_price: 0, payout: 2 },
    ]) {
      assert.equal(readOmniQuote({ proposal }), null);
    }
  });
});

describe("Omni entry clock and provenance", () => {
  const now = 2_000_000;
  const tick: DigitTick = {
    symbol: "R_10",
    source: "live",
    sequence: 77,
    generation: 1,
    price: 100,
    digit: 0,
    epoch: (now - 100) / 1000,
    receivedAt: now - 100,
  };
  it("checks the same tick at send time, source and fixed execution headroom", () => {
    assert.ok(omniTickIsExecutable(tick, tick, now, 1000, true));
    for (const current of [
      { ...tick, sequence: 78 },
      { ...tick, generation: 2 },
      { ...tick, source: "simulated" as const },
      null,
    ]) {
      assert.equal(omniTickIsExecutable(tick, current, now, 1000, true), false);
    }
    assert.equal(
      omniTickIsExecutable(tick, tick, now + 750, 1000, true),
      false,
    );
    assert.equal(
      omniTickIsExecutable(tick, tick, now + 3000, 1000, false),
      false,
    );
    const sim = { ...tick, source: "simulated" as const };
    assert.equal(omniTickIsExecutable(sim, sim, now, 1000, true), false);
    assert.equal(omniTickIsExecutable(sim, sim, now, 1000, false), true);
  });
  it("advances through repeated identical ticks and a full ring buffer", () => {
    const tape = new DigitTape(3);
    for (let i = 0; i < 5; i++)
      tape.push({
        symbol: "R_10",
        price: 100.02,
        digit: 2,
        epoch: 100 + i * 2,
        receivedAt: 1000 + i * 2000,
        source: "live",
      });
    const before = tape.snapshot("R_10")!;
    tape.push({
      symbol: "R_10",
      price: 100.02,
      digit: 2,
      epoch: 110,
      receivedAt: 11_000,
      source: "live",
    });
    const after = tape.snapshot("R_10")!;
    assert.equal(before.ticks.length, after.ticks.length);
    assert.equal(after.tick.price, before.tick.price);
    assert.equal(after.tick.sequence, before.tick.sequence + 1);
    assert.equal(
      omniTickIsExecutable(before.tick, after.tick, 11_010, 2000, true),
      false,
    );
  });
});

describe("Omni unknown purchase reconciliation", () => {
  const expected = {
    symbol: "R_10",
    contractType: "DIGITMATCH",
    barrier: 7,
    stake: 1,
    sentAt: 10_000,
  };
  const valid = {
    contract_id: 123,
    underlying_symbol: "R_10",
    contract_type: "DIGITMATCH",
    barrier: "7",
    buy_price: 1,
    purchase_time: 10,
  };
  it("accepts only one unambiguous broker contract id", () => {
    assert.equal(matchOmniPurchase([valid], expected), 123);
    assert.equal(matchOmniPurchase([valid, valid], expected), 123);
    assert.equal(
      matchOmniPurchase([valid, { ...valid, contract_id: 124 }], expected),
      null,
    );
    assert.equal(
      matchOmniPurchase([{ ...valid, underlying_symbol: "R_25" }], expected),
      null,
    );
    assert.equal(matchOmniPurchase([{ ...valid, barrier: 6 }], expected), null);
    assert.equal(
      matchOmniPurchase([{ ...valid, purchase_time: 2 }], expected),
      null,
    );
  });
  it("never treats missing identity, price or barrier fields as wildcards", () => {
    for (const field of [
      "underlying_symbol",
      "contract_type",
      "barrier",
      "buy_price",
      "purchase_time",
      "contract_id",
    ]) {
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      assert.equal(matchOmniPurchase([broken], expected), null, field);
    }
    assert.equal(
      matchOmniPurchase([{ ...valid, buy_price: "NaN" }], expected),
      null,
    );
  });
});
