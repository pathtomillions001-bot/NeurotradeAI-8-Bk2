import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DigitTape } from "./digit-tape";
import { evaluatePrism } from "./prism-match-analysis";
import {
  advancePrismMarket,
  PrismRejected,
  PrismPaperFeedError,
  PrismRunner,
  selectPrismMarket,
  type PrismMarket,
  type PrismOutcome,
  type PrismPurchase,
  type PrismQuote,
  type PrismRuntime,
} from "./prism-match-runner";
import {
  createRecoveryState,
  reduceRecoveryOutcome,
} from "./agents/recovery-engine";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
} from "./engine-arbiter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail("Expected lifecycle state was not reached");
}

function harness(mode: "paper" | "live" = "paper") {
  const tape = new DigitTape(5000),
    symbol = "R_100";
  let clock = 1_000_000,
    listener: ((symbol: string) => void) | null = null;
  const source = mode === "live" ? "live" : "simulated";
  function push(
    digit = 7,
    emit = true,
    feedSource: "live" | "simulated" = source,
  ) {
    clock += 2000;
    tape.push({
      symbol,
      digit,
      price: 100 + digit / 100,
      source: feedSource,
      epoch: clock / 1000,
      receivedAt: clock,
    });
    if (emit) listener?.(symbol);
  }
  for (let i = 0; i < 400; i++) push(7, false);
  const config = {
    activity: "balanced" as const,
    stake: 1,
    stopLoss: 20,
    takeProfit: 50,
    maxRecoverySteps: 3,
    executionMode: mode,
  };
  const evaluated = evaluatePrism(Array(400).fill(7), {
    ...config,
    maxStake: 100,
    markupPercent: 10,
  });
  evaluated.policy.threshold = 0.005;
  const market: PrismMarket = {
    ...evaluated,
    symbol,
    displayName: "Volatility 100",
    source,
    historySource: mode === "live" ? "broker" : "simulated",
    tick: tape.snapshot(symbol)!.tick,
    waitedTicks: 0,
    refreshedAtSequence: tape.snapshot(symbol)!.tick.sequence,
    valid: true,
  };
  let ledger = createRecoveryState();
  const events: string[] = [],
    orders: PrismQuote["order"][] = [];
  let buys = 0,
    releases = 0,
    commits = 0,
    intents = 0,
    cancelled = 0,
    owned = true;
  const settled = new Set<number>();
  const runtime: PrismRuntime = {
    now: () => clock + 20,
    snapshot: (sym) => tape.snapshot(sym),
    periodMs: () => 2000,
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    owns: () => owned,
    risk: async () => ({ balance: 1000, maxStake: 100, markupPercent: 10 }),
    recovery: () => ledger,
    refresh: async () => null,
    async quote(order, guard) {
      guard();
      events.push("quote");
      return {
        id: "q1",
        askPrice: order.stake,
        payout: order.stake * 8.93,
        order,
        receivedAt: clock + 20,
      };
    },
    async createIntent(order) {
      orders.push(order);
      events.push("intent");
      return ++intents;
    },
    async confirmIntent() {
      events.push("confirmed-id");
    },
    async cancelIntent() {
      cancelled++;
      events.push("cancelled");
    },
    async buy(quote, guard, onSent) {
      guard();
      onSent();
      buys++;
      events.push("buy");
      return {
        contractId: String(buys),
        buyPrice: quote.askPrice,
        startedAtMs: clock,
      };
    },
    async settle() {
      events.push("settle");
      return { won: false, profit: -1 };
    },
    async findPurchase() {
      return null;
    },
    async commit(id, outcome, stake, payout) {
      if (settled.has(id)) return;
      settled.add(id);
      commits++;
      events.push("commit");
      ledger = reduceRecoveryOutcome(
        ledger,
        outcome.won,
        outcome.profit,
        stake,
        3,
        "DIGITMATCH",
        payout,
      );
    },
    delay: flush,
    publish() {},
    release() {
      owned = false;
      releases++;
      events.push("release");
    },
  };
  const runner = new PrismRunner(
    "test-prism",
    config,
    "locked",
    symbol,
    [market],
    runtime,
  );
  return {
    runner,
    runtime,
    market,
    push,
    config,
    tape,
    orders,
    events,
    emitAgain: () => listener?.(symbol),
    get buys() {
      return buys;
    },
    countBuy: () => buys++,
    get releases() {
      return releases;
    },
    get commits() {
      return commits;
    },
    get cancelled() {
      return cancelled;
    },
    get ledger() {
      return ledger;
    },
    seed: (next: typeof ledger) => {
      ledger = next;
    },
  };
}

describe("Prism tick-driven execution lifecycle", () => {
  it("deploys without purchasing, executes once per fresh tick and never widens the contract", async () => {
    const h = harness();
    h.runner.start();
    assert.equal(h.buys, 0);
    h.push();
    await h.runner.whenIdle();
    assert.equal(h.buys, 1);
    assert.deepEqual(
      [
        h.orders[0]!.contractType,
        h.orders[0]!.duration,
        h.orders[0]!.durationUnit,
        h.orders[0]!.barrier,
      ],
      ["DIGITMATCH", 1, "t", 7],
    );
    h.emitAgain();
    await h.runner.whenIdle();
    assert.equal(
      h.buys,
      1,
      "ring length/price equality is not used as a new-tick trigger",
    );
    h.runner.stop();
    assert.equal(h.releases, 1);
  });
  it("stops during quote I/O with zero buys", async () => {
    const h = harness(),
      gate = deferred<void>();
    const normal = h.runtime.quote;
    h.runtime.quote = async (order, guard) => {
      await gate.promise;
      return normal(order, guard);
    };
    h.runner.start();
    h.push();
    await until(() => h.runner.status().prism.phase === "quoting");
    h.runner.stop();
    assert.equal(h.releases, 0);
    gate.resolve();
    await h.runner.whenIdle();
    assert.equal(h.buys, 0);
    assert.equal(h.runner.isRunning, false);
    assert.equal(h.releases, 1);
  });
  it("re-checks stop when a buy leaves the transport queue, not just before enqueue", async () => {
    const h = harness(),
      queued = deferred<void>(),
      send = deferred<void>();
    h.runtime.buy = async (quote, guard, onSent) => {
      queued.resolve();
      await send.promise;
      guard();
      onSent();
      h.countBuy();
      return { contractId: "never", buyPrice: quote.askPrice };
    };
    h.runner.start();
    h.push();
    await queued.promise;
    h.runner.stop();
    send.resolve();
    await h.runner.whenIdle();
    assert.equal(h.buys, 0);
    assert.equal(h.cancelled, 1);
    assert.equal(h.commits, 0);
    assert.equal(h.releases, 1);
  });
  it("keeps ownership and records the outcome when stopped after buy was sent", async () => {
    const h = harness(),
      settlement = deferred<PrismOutcome>();
    h.runtime.settle = () => settlement.promise;
    h.runner.start();
    h.push();
    await until(() => h.buys === 1);
    h.runner.stop();
    assert.equal(h.runner.isRunning, true);
    assert.equal(h.releases, 0);
    for (let i = 0; i < 12; i++) h.push();
    assert.equal(
      h.buys,
      1,
      "ticks received while settling do not queue more orders",
    );
    settlement.resolve({ won: false, profit: -1 });
    await h.runner.whenIdle();
    assert.equal(h.commits, 1);
    assert.equal(h.ledger.unrecoveredAmount, 1);
    assert.equal(h.runner.isRunning, false);
    assert.equal(h.releases, 1);
    assert.ok(h.events.indexOf("confirmed-id") < h.events.indexOf("commit"));
    assert.ok(h.events.indexOf("commit") < h.events.indexOf("release"));
  });
  it("abandons an otherwise good quote when a repeated-digit tick arrives before buy", async () => {
    const h = harness(),
      quote = deferred<PrismQuote>();
    let pendingOrder: PrismQuote["order"] | null = null;
    h.runtime.quote = async (order) => {
      pendingOrder = order;
      return quote.promise;
    };
    h.runner.start();
    h.push();
    await until(() => pendingOrder !== null);
    h.push(7);
    quote.resolve({
      id: "old",
      askPrice: 1,
      payout: 8.93,
      order: pendingOrder!,
      receivedAt: h.runtime.now(),
    });
    await h.runner.whenIdle();
    assert.equal(h.buys, 0);
    assert.match(h.runner.status().message, /new tick/);
    h.runner.stop();
  });
  it("aborts if the actual quote turns the estimated opportunity negative", async () => {
    const h = harness();
    h.market.policy.calibration = 0.2;
    h.runtime.quote = async (order) => ({
      id: "poor",
      askPrice: order.stake,
      payout: order.stake * 1.01,
      receivedAt: h.runtime.now(),
      order,
    });
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(h.buys, 0);
    assert.match(h.runner.status().message, /payout/);
    h.runner.stop();
  });
  it("re-sizes recovery against the actual payout, still only buying Matches", async () => {
    const h = harness();
    h.seed({
      ...h.ledger,
      inRecovery: true,
      unrecoveredAmount: 10,
      recoveryStep: 3,
      consecutiveMatchLosses: 80,
    });
    h.runtime.quote = async (order) => ({
      id: "exact",
      askPrice: order.stake,
      payout: order.stake * 6,
      receivedAt: h.runtime.now(),
      order,
    });
    h.runtime.settle = async () => ({ won: true, profit: 11 });
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(h.orders[0]!.stake, 2.2, "10 debt × 1.1 / (6 − 1)");
    assert.equal(h.orders[0]!.contractType, "DIGITMATCH");
    assert.equal(h.ledger.inRecovery, false);
    h.runner.stop();
  });
  it("a settlement timeout never writes a fake loss or retries the buy", async () => {
    const h = harness(),
      settlement = deferred<PrismOutcome>();
    let attempts = 0;
    h.runtime.settle = async () => {
      attempts++;
      if (attempts === 1) throw new Error("timeout");
      return settlement.promise;
    };
    h.runner.start();
    h.push();
    await until(() => attempts === 2);
    assert.equal(h.buys, 1);
    assert.equal(h.commits, 0);
    assert.equal(h.runner.status().tradeCount, 0);
    assert.equal(h.ledger.inRecovery, false);
    settlement.resolve({ won: true, profit: 7.93 });
    await h.runner.whenIdle();
    assert.equal(h.buys, 1);
    assert.equal(h.commits, 1);
    assert.equal(h.runner.status().totalProfit, 7.93);
    h.runner.stop();
  });
  it("an ambiguous buy is never retried and even stop must wait for a confirmed receipt", async () => {
    const h = harness(),
      receipt = deferred<PrismPurchase | null>();
    h.runtime.buy = async (_quote, guard, onSent) => {
      guard();
      onSent();
      h.countBuy();
      throw new Error("socket lost after send");
    };
    h.runtime.findPurchase = () => receipt.promise;
    h.runner.start();
    h.push();
    await until(() => h.runner.status().prism.phase === "attention");
    h.runner.stop();
    h.push();
    h.push();
    assert.equal(h.buys, 1);
    assert.equal(h.releases, 0);
    assert.equal(h.cancelled, 0);
    assert.equal(h.commits, 0);
    receipt.resolve({ contractId: "confirmed-later", buyPrice: 1 });
    await h.runner.whenIdle();
    assert.equal(h.buys, 1);
    assert.equal(h.commits, 1);
    assert.equal(h.releases, 1);
  });
  it("accepts a correlated late rejection without inventing a purchase or loss", async () => {
    const h = harness();
    h.runtime.buy = async (_q, guard, onSent) => {
      guard();
      onSent();
      h.countBuy();
      throw new Error("timeout");
    };
    h.runtime.findPurchase = async () => {
      throw new PrismRejected("late rejection");
    };
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(h.buys, 1);
    assert.equal(h.cancelled, 1);
    assert.equal(h.commits, 0);
    assert.equal(h.runner.status().tradeCount, 0);
    h.runner.stop();
  });
  it("stops before quoting if the account/risk provider fails", async () => {
    const h = harness("live");
    h.runtime.risk = async () => {
      throw new Error("account disconnected");
    };
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(h.runner.isRunning, false);
    assert.equal(h.buys, 0);
    assert.equal(h.releases, 1);
    assert.equal(h.events.includes("quote"), false);
    assert.equal(h.commits, 0);
    assert.match(h.runner.status().message, /Risk\/account/);
  });
  it("stops an unscorable paper entry after a feed gap without fabricating an outcome", async () => {
    const h = harness();
    h.runtime.settle = async () => {
      throw new PrismPaperFeedError("paper feed changed");
    };
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(h.runner.isRunning, false);
    assert.equal(h.runner.status().tradeCount, 0);
    assert.equal(h.commits, 0);
    assert.equal(h.releases, 1);
    assert.equal(h.ledger.unrecoveredAmount, 0);
    assert.match(h.runner.status().message, /unscored/);
  });
  it("a definite broker rejection cancels the intent without changing recovery", async () => {
    const h = harness();
    h.runtime.buy = async (_q, guard, onSent) => {
      guard();
      onSent();
      throw new PrismRejected("Insufficient balance");
    };
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(h.cancelled, 1);
    assert.equal(h.commits, 0);
    assert.equal(h.ledger.unrecoveredAmount, 0);
    assert.equal(h.runner.status().tradeCount, 0);
    h.runner.stop();
  });
  it("retries durable ID storage before settlement, without buying twice", async () => {
    const h = harness();
    let stores = 0;
    h.runtime.confirmIntent = async () => {
      stores++;
      if (stores === 1) throw new Error("DB retry");
      h.events.push("durable");
    };
    h.runtime.settle = async () => {
      assert.ok(h.events.includes("durable"));
      return { won: false, profit: -1 };
    };
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(stores, 2);
    assert.equal(h.buys, 1);
    assert.equal(h.commits, 1);
    h.runner.stop();
  });
  it("retries an atomic commit while preserving ownership and the settled outcome", async () => {
    const h = harness();
    let attempts = 0;
    const realCommit = h.runtime.commit;
    h.runtime.commit = async (...args) => {
      attempts++;
      if (attempts === 1) throw new Error("DB rollback");
      return realCommit(...args);
    };
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(attempts, 2);
    assert.equal(h.buys, 1);
    assert.equal(h.commits, 1);
    assert.equal(h.ledger.unrecoveredAmount, 1);
    h.runner.stop();
  });
  it("zero balance and exhausted stop-loss room stop before any quote or purchase", async () => {
    const h = harness();
    h.runtime.risk = async () => ({
      balance: 0,
      maxStake: 100,
      markupPercent: 10,
    });
    h.runner.start();
    h.push();
    await h.runner.whenIdle();
    assert.equal(h.buys, 0);
    assert.equal(h.runner.isRunning, false);
    assert.equal(h.releases, 1);
    const g = harness();
    g.config.stopLoss = 1;
    g.runner.start();
    g.push();
    await g.runner.whenIdle();
    assert.equal(g.runner.isRunning, false);
    assert.equal(g.runner.status().totalProfit, -1);
    g.push();
    assert.equal(g.buys, 1);
  });
  it("a live runner cannot authorize an entry after live-to-simulated feed transition", async () => {
    const h = harness("live");
    h.runner.start();
    h.push(7, true, "simulated");
    await h.runner.whenIdle();
    assert.equal(h.market.valid, false);
    assert.equal(h.buys, 0);
    h.runner.stop();
  });
});

describe("Prism market identity and execution isolation", () => {
  it("updates on the first unseen tick, not on digit inequality", () => {
    const h = harness();
    const before = h.market.model.samples;
    h.push(7, false);
    assert.equal(advancePrismMarket(h.market, h.tape.snapshot("R_100")), 1);
    assert.equal(h.market.model.samples, before + 1);
    assert.equal(advancePrismMarket(h.market, h.tape.snapshot("R_100")), 0);
  });
  it("invalidates a generation/missing sequence instead of appending discontinuous history", () => {
    const h = harness();
    const snapshot = h.tape.snapshot("R_100")!;
    const broken = { ...snapshot.tick, sequence: snapshot.tick.sequence + 2 };
    assert.equal(
      advancePrismMarket(h.market, { tick: broken, ticks: [broken] }),
      0,
    );
    assert.equal(h.market.valid, false);
  });
  it("locked mode never escapes the selected symbol; switching uses hysteresis", () => {
    const a = harness().market,
      b = {
        ...harness().market,
        symbol: "R_50",
        decision: {
          ...a.decision,
          utility: a.decision.utility + 0.5,
          ready: true,
        },
      };
    a.decision.ready = true;
    assert.equal(
      selectPrismMarket([a, b], "locked", a.symbol, a.symbol, 100)?.symbol,
      a.symbol,
    );
    assert.equal(
      selectPrismMarket([a, b], "switching", a.symbol, a.symbol, 1)?.symbol,
      a.symbol,
    );
    assert.equal(
      selectPrismMarket([a, b], "switching", a.symbol, a.symbol, 6)?.symbol,
      b.symbol,
    );
    b.decision.utility = a.decision.utility + 0.01;
    assert.equal(
      selectPrismMarket([a, b], "switching", a.symbol, a.symbol, 100)?.symbol,
      a.symbol,
    );
  });
  it("uses a distinct lease so another specialist cannot share its account execution slot", () => {
    const a = "prism-account-a",
      b = "prism-account-b";
    assert.equal(acquireTradingOwnership("prism-match", a), true);
    assert.equal(acquireTradingOwnership("bots", a), false);
    assert.equal(acquireTradingOwnership("neuroai", a), false);
    assert.equal(acquireTradingOwnership("autonomous", a), false);
    assert.equal(acquireTradingOwnership("prism-match", b), true);
    releaseTradingOwnership("bots", a); // wrong owner cannot release Prism
    assert.equal(acquireTradingOwnership("bots", a), false);
    releaseTradingOwnership("prism-match", a);
    releaseTradingOwnership("prism-match", b);
    assert.equal(acquireTradingOwnership("bots", a), true);
    releaseTradingOwnership("bots", a);
  });
});
