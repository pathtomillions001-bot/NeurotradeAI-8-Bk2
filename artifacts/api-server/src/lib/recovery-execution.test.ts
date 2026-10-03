import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  executeLiveTrade,
  getAccountConnection,
  closeAccountConnections,
  PurchaseOutcomeUnknownError,
  tickManager,
} from "./deriv";
import { waitForPaperExpiry } from "./recovery-paper";
const token = "test-only";
let id = 0;
const params = () => ({
  accountId: `recovery-test-${++id}`,
  symbol: "R_10",
  contractType: "DIGITOVER",
  barrier: 3,
  stake: 1,
  duration: 5,
  durationUnit: "t",
  currency: "USD",
});
const quote = {
  msg_type: "proposal",
  proposal: { id: "q", ask_price: 1, payout: 1.63 },
};
const bought = { msg_type: "buy", buy: { contract_id: 123, buy_price: 1 } };
afterEach(() => {
  mock.restoreAll();
  closeAccountConnections();
});
describe("purchase boundary safeguards", () => {
  it("rechecks stop permission after the request waits in the queue", async () => {
    const p = params();
    let running = true,
      buys = 0,
      checks = 0;
    mock.method(
      getAccountConnection(token, p.accountId),
      "request",
      async (message: any, _timeout: any, hooks: any) => {
        if (message.proposal) return quote;
        running = false; // user stops after initial validation, before transmission
        hooks?.beforeSend?.();
        hooks?.onSent?.();
        buys++;
        return bought;
      },
    );
    await assert.rejects(
      executeLiveTrade(token, {
        ...p,
        guards: {
          validateBuy: () => {
            checks++;
            if (!running) throw new Error("stopped");
          },
        },
      }),
      /stopped/,
    );
    assert.equal(checks, 2);
    assert.equal(buys, 0);
  });
  it("checks the actual quote and refuses it before creating purchase intent", async () => {
    const p = params();
    let intent = 0,
      buys = 0;
    mock.method(
      getAccountConnection(token, p.accountId),
      "request",
      async (m: any) => {
        if (m.proposal) return quote;
        buys++;
        return bought;
      },
    );
    await assert.rejects(
      executeLiveTrade(token, {
        ...p,
        guards: {
          validateBuy: (q) => {
            assert.equal(q.payout, 1.63);
            throw new Error("edge vanished");
          },
          beforeBuy: async () => {
            intent++;
          },
        },
      }),
      /edge vanished/,
    );
    assert.equal(intent, 0);
    assert.equal(buys, 0);
  });
  it("does not buy if durable intent cannot be written", async () => {
    const p = params();
    let buys = 0;
    mock.method(
      getAccountConnection(token, p.accountId),
      "request",
      async (m: any) => {
        if (m.proposal) return quote;
        buys++;
        return bought;
      },
    );
    await assert.rejects(
      executeLiveTrade(token, {
        ...p,
        guards: {
          validateBuy: () => {},
          beforeBuy: async () => {
            throw new Error("database unavailable");
          },
        },
      }),
      /database unavailable/,
    );
    assert.equal(buys, 0);
  });
  it("persists the exact contract id before returning the purchased order", async () => {
    const p = params();
    const order: string[] = [];
    mock.method(
      getAccountConnection(token, p.accountId),
      "request",
      async (m: any, _t: any, hooks: any) => {
        if (m.proposal) return quote;
        hooks?.beforeSend?.();
        hooks?.onSent?.();
        order.push("buy");
        return bought;
      },
    );
    await executeLiveTrade(token, {
      ...p,
      guards: {
        validateBuy: () => {},
        beforeBuy: async () => {
          order.push("intent");
        },
        onBuy: async (r) => {
          assert.equal(r.contractId, 123);
          order.push("persist");
        },
      },
    });
    assert.deepEqual(order, ["intent", "buy", "persist"]);
  });
  it("an unacknowledged buy or persistence failure is unknown, never automatically retried", async () => {
    for (const persistFailure of [false, true]) {
      const p = params();
      let buys = 0;
      mock.method(
        getAccountConnection(token, p.accountId),
        "request",
        async (m: any, _t: any, hooks: any) => {
          if (m.proposal) return quote;
          hooks?.beforeSend?.();
          hooks?.onSent?.();
          buys++;
          return persistFailure ? bought : null;
        },
      );
      await assert.rejects(
        executeLiveTrade(token, {
          ...p,
          guards: {
            validateBuy: () => {},
            onBuy: async () => {
              throw new Error("write failed");
            },
          },
        }),
        PurchaseOutcomeUnknownError,
      );
      assert.equal(buys, 1);
    }
  });
  it("broker rejection is a known failure, not an uncertain outcome", async () => {
    const p = params();
    mock.method(
      getAccountConnection(token, p.accountId),
      "request",
      async (m: any) =>
        m.proposal ? quote : { error: { message: "InsufficientBalance" } },
    );
    await assert.rejects(
      executeLiveTrade(token, { ...p, guards: { validateBuy: () => {} } }),
      (e) => e instanceof Error && !(e instanceof PurchaseOutcomeUnknownError),
    );
  });
});
describe("paper expiry uses observed future ticks", () => {
  it("counts only new ticks of the selected symbol and cleans up its listener", async () => {
    let tick = {
      symbol: "R_10",
      sequence: 1,
      generation: 1,
      source: "live" as const,
      epoch: 1,
      receivedAt: 1,
      digit: 9,
      price: 100,
    };
    mock.method(tickManager, "getDigitSnapshot", () => ({
      tick,
      ticks: [tick],
    }));
    const listeners = tickManager.listenerCount("tick");
    const result = waitForPaperExpiry("R_10", "DIGITOVER", 3, 2);
    tickManager.emit("tick", { symbol: "R_25" });
    tickManager.emit("tick", { symbol: "R_10" }); // duplicate sequence
    tick = { ...tick, sequence: 2, digit: 9 };
    tickManager.emit("tick", { symbol: "R_10" });
    tick = { ...tick, sequence: 3, digit: 1, price: 101 };
    tickManager.emit("tick", { symbol: "R_10" });
    assert.deepEqual(await result, { won: false, entry: 100, exit: 101 });
    assert.equal(tickManager.listenerCount("tick"), listeners);
  });
  it("does not invent an outcome after a source transition", async () => {
    let tick = {
      symbol: "R_10",
      sequence: 1,
      generation: 1,
      source: "live" as const,
      epoch: 1,
      receivedAt: 1,
      digit: 9,
      price: 100,
    };
    mock.method(tickManager, "getDigitSnapshot", () => ({
      tick,
      ticks: [tick],
    }));
    const result = waitForPaperExpiry("R_10", "CALL", null, 1);
    tick = { ...tick, sequence: 2, generation: 2 };
    tickManager.emit("tick", { symbol: "R_10" });
    await assert.rejects(result, /changed/);
  });
});

it("quarantines unknown outcomes across executors without blocking other accounts", async () => {
  const {
    quarantineTrading,
    clearTradingQuarantine,
    acquireTradingOwnership,
    releaseTradingOwnership,
    tradingBlockReason,
  } = await import("./engine-arbiter");
  const session = "quarantine-test";
  quarantineTrading(session, "unresolved");
  for (const owner of ["autonomous", "neuroai", "bots"] as const)
    assert.equal(acquireTradingOwnership(owner, session), false);
  assert.equal(tradingBlockReason(session), "unresolved");
  assert.equal(
    acquireTradingOwnership("autonomous", "other-account-test"),
    true,
  );
  releaseTradingOwnership("autonomous", "other-account-test");
  clearTradingQuarantine(session);
  assert.equal(acquireTradingOwnership("autonomous", session), true);
  releaseTradingOwnership("autonomous", session);
});

describe("main autonomous original recovery sizing", () => {
  async function fixture(run: (settings: import('./agents/types').TradingSettings) => void) {
    const recovery = await import('./agents/recovery-engine');
    const { runWithSession } = await import('./session');
    runWithSession(`original-sizing-${++id}`, () => {
      recovery.seedState({ ...recovery.getState(), inRecovery:true, unrecoveredAmount:10,
        baseStake:2, remainingTargetProfit:2, targetProfit:2, recoveryStep:2 });
      run({ riskAmountType:'fixed', riskAmountValue:2, maxTradeStake:100,
        riskProfile:'conservative', recoveryMultiplier:3, recoveryMethod:'split',
        maxRecoverySteps:3, recoveryAutoMode:true } as import('./agents/types').TradingSettings);
    });
  }
  it('Auto Split caps at base stake while Auto Instant targets debt plus remaining profit', async()=>{
    const {autonomousRecoveryStake:stake}=await import('./autonomous-recovery-sizing');
    await fixture(s=>{
      assert.equal(stake(s,100,2,.7),2);
      assert.equal(stake({...s,recoveryMethod:'instant'},100,2,.7),12);
      // Neither the 0.5% balance cap nor a confidence/Kelly override applies.
      assert.equal(stake({...s,recoveryMethod:'instant'},100,2,.51),12);
    });
  });
  it('Manual Split caps the exact target; Manual Instant uses the user multiplier ladder',async()=>{
    const {autonomousRecoveryStake:stake}=await import('./autonomous-recovery-sizing');
    await fixture(s=>{
      assert.equal(stake({...s,recoveryAutoMode:false},100,2,.7),12);
      assert.equal(stake({...s,recoveryAutoMode:false,recoveryMethod:'instant'},100,2,.7),18);
      assert.equal(stake({...s,recoveryAutoMode:false,recoveryMethod:'instant',maxRecoverySteps:1},100,2,.7),6);
    });
  });
  it('retains upward rounding, payout sensitivity, maximum stake and available balance',async()=>{
    const {autonomousRecoveryStake:stake}=await import('./autonomous-recovery-sizing');
    await fixture(s=>{
      const instant={...s,recoveryMethod:'instant' as const};
      assert.equal(stake(instant,100,1.63,.7),19.05);
      assert.equal(stake({...instant,maxTradeStake:5},100,1.63,.7),5);
      assert.equal(stake(instant,4,1.63,.7),4);
      assert.equal(stake(instant,.2,1.63,.7),0);
      assert.equal(stake(instant,0,1.63,.7),0);
    });
  });
});
