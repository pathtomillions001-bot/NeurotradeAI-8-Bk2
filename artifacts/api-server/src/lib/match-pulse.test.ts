import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  PULSE, PulseModel, evaluatePulseMarket, readPulse, freshPulseCadence,
  recordPulseShot, recordPulseResult, pulseCadenceReady, pulseLogEvidence,
  qualifyPulseReport, selectPulseMarket,
} from "./match-pulse-analysis.ts";
import { DigitTape, sameDigitTick, mergeLiveDigitHistory, type DigitTick } from "./digit-tape.ts";
import { assertPulseTick, buyPulseMatch, capPulseStake, readPulseBuyConfirmation, PulseOrderError, type PulseTransport } from "./match-pulse-execution.ts";
import { parsePulseScan, parsePulseConfig, parsePulseAccountScan, parsePulseAccountConfig } from "./match-pulse-config.ts";
import { calculateBotRecoveryStake, applyRecoveryStakeLimits } from "./recovery-math.ts";
import { createRecoveryState, reduceRecoveryOutcome } from "./agents/recovery-engine.ts";
import { runWithSessionId } from "./session.ts";
import { acquireTradingOwnership, releaseTradingOwnership, currentTradingOwner } from "./engine-arbiter.ts";
import { getAccountConnection, closeAccountConnections } from "./deriv.ts";

function random(seed: number) {
  let s = seed;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}
export function pulseFixture(kind: "fair" | "hot" | "context" | "collapse", seed = 123, n = 4999): number[] {
  const rng = random(seed);
  const digits: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = kind === "fair" || (kind === "collapse" && i > n * 0.72) ? 0.1
      : kind === "context" ? (digits.at(-1) === 3 ? 0.72 : 0.04) : 0.4;
    const hit = rng() < p;
    const other = Math.floor(rng() * 9);
    digits.push(hit ? 7 : other >= 7 ? other + 1 : other);
  }
  return digits;
}

const tick: DigitTick = { symbol: "R_100", sequence: 100, generation: 1, source: "live", epoch: 100, receivedAt: 100_000, digit: 7, price: 100.07 };

// These are synthetic control experiments, NOT broker-performance claims.
describe("Match Pulse causal selection and evidence", () => {
  it("does not qualify seeded fair markets after searching 20 markets", () => {
    let qualified = 0;
    for (let seed = 1; seed <= 60; seed++) {
      qualified += Number(evaluatePulseMarket(`R_${seed}`, "fair", pulseFixture("fair", seed), { marketsTested: 20 }).qualified);
    }
    assert.equal(qualified, 0);
  });
  it("finds a planted conditional edge even when the marginal digit rate is near 10%", () => {
    const digits = pulseFixture("context");
    const marginal = digits.filter(d => d === 7).length / digits.length;
    assert.ok(marginal < 0.14);
    const report = evaluatePulseMarket("R_100", "conditional", digits, { marketsTested: 20 });
    assert.equal(report.qualified, true, report.reasons.join("; "));
    assert.ok(report.audit.winRate > 0.5);
    // Judge the whole policy, including its occasional wrong-digit entries.
    assert.ok(report.replay.filter(s => s.digit === 7).length / report.replay.length > 0.9);
    assert.ok(report.replay.some(s => s.order === 1));
  });
  it("requires independent validation and the latest audit, not just a profitable old block", () => {
    const report = evaluatePulseMarket("R_100", "collapsed", pulseFixture("collapse"), { marketsTested: 20 });
    assert.ok(report.validation.winRate > report.breakEven);
    assert.equal(report.qualified, false);
    assert.equal(report.latest.ready, false);
  });
  it("replaying a prefix reproduces each held-out forecast exactly; it never sees its outcome", () => {
    const digits = pulseFixture("context");
    const report = evaluatePulseMarket("R_100", "context", digits);
    for (const shot of report.replay.filter((_, i) => i % 7 === 0)) {
      const live = readPulse(digits.slice(0, shot.index));
      assert.equal(live.digit, shot.digit);
      assert.equal(live.order, shot.order);
      assert.equal(live.probability, shot.probability);
      assert.equal(live.lower, shot.lower);
      assert.equal(live.ready, true);
      assert.equal(shot.won, digits[shot.index] === shot.digit);
    }
  });
  it("future mutations cannot change any earlier forecast or selected digit", () => {
    const digits = pulseFixture("hot");
    const first = evaluatePulseMarket("R_100", "before", digits);
    const changed = evaluatePulseMarket("R_100", "after", [...digits.slice(0, 4000), ...new Array(999).fill(0)]);
    assert.deepEqual(first.replay.filter(s => s.index < 4000), changed.replay.filter(s => s.index < 4000));
  });
  it("does not reject a supported digit simply because it just occurred", () => {
    const prefix = [...pulseFixture("hot"), 7, 7];
    const read = readPulse(prefix);
    assert.equal(read.digit, 7);
    assert.equal(read.ready, true);
  });
  it("locked digit cannot drift to another digit in replay or at entry", () => {
    const report = evaluatePulseMarket("R_100", "hot", pulseFixture("hot"), { lockedDigit: 2 });
    assert.equal(report.qualified, false);
    assert.equal(report.latest.digit, 2);
    assert.ok(report.replay.every(s => s.digit === 2));
  });
  it("rejects short and malformed histories instead of filtering gaps into fake transitions", () => {
    assert.equal(evaluatePulseMarket("R_100", "short", new Array(300).fill(7)).qualified, false);
    for (const digit of [-1, 10, 1.5, NaN]) assert.throws(() => readPulse([1, 2, digit]));
    const model = new PulseModel();
    assert.throws(() => model.read(Infinity));
    assert.throws(() => model.read(8.93, 10));
  });
  it("rechecks actual payout; a formerly good report may become untradeable", () => {
    const report = evaluatePulseMarket("R_100", "hot", pulseFixture("hot"));
    assert.equal(report.qualified, true);
    assert.equal(qualifyPulseReport(report, 1.5, 20, 1).qualified, false);
    assert.ok(qualifyPulseReport(report, 8.93, 20, 2).requiredLogEvidence > qualifyPulseReport(report, 8.93, 20, 1).requiredLogEvidence);
    assert.ok(qualifyPulseReport(report, 8.93, 20, 1).requiredLogEvidence > qualifyPulseReport(report, 8.93, 1, 1).requiredLogEvidence);
  });
  it("evidence is finite for all-win/all-loss tails and does not certify an ordinary 10% rate", () => {
    assert.ok(pulseLogEvidence(100, 1000, 1 / 8.93) < 0);
    assert.ok(Number.isFinite(pulseLogEvidence(0, 1000, 1 / 8.93)));
    assert.ok(pulseLogEvidence(1000, 1000, 1 / 8.93) > 100);
  });
  it("locked mode never rotates; switching uses qualified candidates and hysteresis", () => {
    const a = evaluatePulseMarket("A", "A", pulseFixture("hot"));
    const b = { ...a, symbol: "B", lowerEv: a.lowerEv + 0.05 };
    assert.equal(selectPulseMarket([a, b], "locked", "A")?.symbol, "A");
    assert.equal(selectPulseMarket([a, b], "switching", "A", "A")?.symbol, "A");
    assert.equal(selectPulseMarket([a, { ...b, lowerEv: a.lowerEv + 1 }], "switching", "A", "A")?.symbol, "B");
    assert.equal(selectPulseMarket([{ ...a, qualified: false }, b], "locked", "A"), null);
  });
});

describe("distinct tick identity and paper settlement inputs", () => {
  it("repeated digits and saturated ring lengths still advance the clock", () => {
    const tape = new DigitTape(2);
    const one = tape.push(tick)!;
    const two = tape.push({ ...tick, epoch: 102, receivedAt: 102_000 })!;
    const three = tape.push({ ...tick, epoch: 104, receivedAt: 104_000 })!;
    assert.deepEqual(tape.snapshot(tick.symbol)!.ticks.map(t => t.digit), [7, 7]);
    assert.equal(two.sequence, one.sequence + 1);
    assert.equal(three.sequence, two.sequence + 1);
    assert.equal(sameDigitTick(one, two), false);
    assert.equal(tape.push({ ...tick, epoch: 104 }), null); // duplicate packet
    assert.equal(tape.push({ ...tick, epoch: 102 }), null); // out of order
  });
  it("source changes discard simulation and invalidate old tickets", () => {
    const tape = new DigitTape();
    const simulated = tape.push({ ...tick, source: "simulated" })!;
    const live = tape.push(tick)!;
    assert.notEqual(live.generation, simulated.generation);
    assert.equal(tape.snapshot(tick.symbol)!.ticks.length, 1);
    assert.equal(sameDigitTick(simulated, live), false);
  });
  it("a missing feed block resets context provenance", () => {
    const tape = new DigitTape();
    const first = tape.push(tick)!;
    const later = tape.push({ ...tick, epoch: 140, receivedAt: 140_000 })!;
    assert.notEqual(later.generation, first.generation);
    assert.equal(tape.snapshot(tick.symbol)!.ticks.length, 1);
  });
  it("timestamp merge deduplicates overlap, not equal digit values", () => {
    const tape = new DigitTape(2);
    tape.push(tick);
    tape.push({ ...tick, epoch: 102 });
    assert.deepEqual(mergeLiveDigitHistory([{ epoch: 98, digit: 7 }, { epoch: 100, digit: 7 }], tape.snapshot(tick.symbol)!), [7, 7, 7]);
    assert.throws(() => mergeLiveDigitHistory([{ epoch: 100, digit: 3 }], tape.snapshot(tick.symbol)!));
    assert.throws(() => mergeLiveDigitHistory([{ epoch: 100, digit: 7 }, { epoch: 98, digit: 7 }], tape.snapshot(tick.symbol)!));
  });
  it("only real ticks advance spacing; losses add a cooldown and clusters cannot force fire", () => {
    const cadence = freshPulseCadence();
    recordPulseShot(cadence, 100);
    for (let poll = 0; poll < 1000; poll++) assert.equal(pulseCadenceReady(cadence, 100), false);
    recordPulseResult(cadence, false, 101);
    assert.equal(pulseCadenceReady(cadence, 108), false);
    assert.equal(pulseCadenceReady(cadence, 109), true);
    recordPulseResult(cadence, false, 110);
    recordPulseResult(cadence, false, 121);
    assert.equal(cadence.blockedUntil, 121 + PULSE.clusterCooldown);
  });
});

function guardOptions() {
  return { decision: tick, current: tick, now: 100_050, maxAgeMs: 550, live: true, stopped: false, ownsExecution: true };
}
function fakeTransport(options: { beforeBuy?: () => void; buy?: any; payout?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const transport: PulseTransport = {
    async request(message, _timeout, hooks) {
      if (message.buy) options.beforeBuy?.();
      hooks?.beforeSend?.();
      hooks?.onSent?.();
      sent.push(message);
      return message.proposal
        ? { proposal: { id: "p1", ask_price: 1, payout: options.payout ?? 8.93 } }
        : options.buy === undefined ? { buy: { contract_id: 123, buy_price: 1 } } : options.buy;
    },
  };
  return { transport, sent };
}
function buyInput(transport: PulseTransport) {
  return { transport, symbol: tick.symbol, digit: 7, stake: 1, currency: "USD", guard: () => {}, onBuySent: () => {} };
}

describe("Match Pulse order boundary", () => {
  it("requires current, fresh live data and ownership with no bypass", () => {
    assert.doesNotThrow(() => assertPulseTick(guardOptions()));
    for (const change of [{ current: null }, { now: 100_551 }, { stopped: true }, { ownsExecution: false },
      { current: { ...tick, sequence: 101 } }, { decision: { ...tick, source: "simulated" as const }, current: { ...tick, source: "simulated" as const } }]) {
      assert.throws(() => assertPulseTick({ ...guardOptions(), ...change }), PulseOrderError);
    }
  });
  it("uses the broker epoch deadline, not only the local receipt age", () => {
    const delayed = { ...tick, receivedAt: 101_900 };
    assert.throws(() => assertPulseTick({ ...guardOptions(), decision: delayed, current: delayed, now: 101_910 }), /broker-origin/);
    const nearNext = { ...tick, receivedAt: 100_800 };
    assert.doesNotThrow(() => assertPulseTick({ ...guardOptions(), decision: nearNext, current: nearNext, now: 100_840, expectedIntervalMs: 1000 }));
    assert.throws(() => assertPulseTick({ ...guardOptions(), decision: nearNext, current: nearNext, now: 100_850, expectedIntervalMs: 1000 }), /broker-origin/);
    const future = { ...tick, epoch: 102 };
    assert.throws(() => assertPulseTick({ ...guardOptions(), decision: future, current: future }), /broker-origin/);
  });
  it("only exact-reference late buy replies can resolve an unknown purchase", () => {
    const confirmation = { msg_type: "buy", passthrough: { match_pulse_order: "order-a" },
      buy: { contract_id: 123, buy_price: 1, start_time: 102 } };
    assert.deepEqual(readPulseBuyConfirmation(confirmation, "order-a"), { rejected: false, contractId: 123, buyPrice: 1, startTime: 102 });
    assert.equal(readPulseBuyConfirmation(confirmation, "order-b"), null);
    assert.equal(readPulseBuyConfirmation({ ...confirmation, msg_type: "proposal" }, "order-a"), null);
    assert.equal(readPulseBuyConfirmation({ ...confirmation, buy: { contract_id: 1.2, buy_price: 1 } }, "order-a"), null);
    assert.equal(readPulseBuyConfirmation({ ...confirmation, echo_req: { passthrough: { match_pulse_order: "order-b" } } }, "order-a"), null);
    assert.deepEqual(readPulseBuyConfirmation({ msg_type: "buy", echo_req: { passthrough: { match_pulse_order: "order-a" } }, error: { code: "InsufficientBalance" } }, "order-a"), { rejected: true });
    assert.equal(readPulseBuyConfirmation(null, "order-a"), null);
  });
  it("sends a unique purchase reference and preserves the broker start epoch", async () => {
    const { transport, sent } = fakeTransport({ buy: { buy: { contract_id: 123, buy_price: 1, start_time: 102 } } });
    const result = await buyPulseMatch({ ...buyInput(transport), reference: "unique-order" });
    assert.equal(result.startTime, 102);
    assert.deepEqual(sent[1]!.passthrough, { match_pulse_order: "unique-order" });
  });
  it("never buys when a new tick arrives while the broker queue is waiting", async () => {
    let current = tick;
    const { transport, sent } = fakeTransport({ beforeBuy: () => { current = { ...tick, sequence: 101 }; } });
    await assert.rejects(() => buyPulseMatch({ ...buyInput(transport), guard: () => assertPulseTick({ ...guardOptions(), current }) }), /tick changed/);
    assert.equal(sent.filter(m => m.buy).length, 0);
  });
  it("stop during quoting cancels the queued purchase", async () => {
    let stopped = false;
    const { transport, sent } = fakeTransport({ beforeBuy: () => { stopped = true; } });
    await assert.rejects(() => buyPulseMatch({ ...buyInput(transport), guard: () => assertPulseTick({ ...guardOptions(), stopped }) }), /stopped/);
    assert.equal(sent.filter(m => m.buy).length, 0);
  });
  it("validates actual payout and sends exactly DIGITMATCH / one tick / chosen digit", async () => {
    const { transport, sent } = fakeTransport();
    let checked = 0;
    const purchase = await buyPulseMatch({ ...buyInput(transport), guard: quote => { if (quote) { checked++; assert.equal(quote.multiplier, 8.93); } } });
    assert.equal(purchase.contractId, 123);
    assert.ok(checked >= 2);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.contract_type, "DIGITMATCH");
    assert.equal(sent[0]!.barrier, "7");
    assert.equal(sent[0]!.duration, 1);
    assert.equal(sent[0]!.duration_unit, "t");
  });
  it("unknown purchase freezes rather than silently re-buying", async () => {
    const { transport, sent } = fakeTransport({ buy: null });
    await assert.rejects(() => buyPulseMatch(buyInput(transport)), (error: unknown) => error instanceof PulseOrderError && error.disposition === "unknown");
    assert.equal(sent.filter(m => m.buy).length, 1);
  });
  it("broker rejection is distinct from an ambiguous purchase", async () => {
    const { transport } = fakeTransport({ buy: { error: { message: "Insufficient funds" } } });
    await assert.rejects(() => buyPulseMatch(buyInput(transport)), (error: unknown) => error instanceof PulseOrderError && error.disposition === "not-bought");
  });
  it("invalid pricing never sends a buy", async () => {
    for (const payout of [0, NaN, 1, Infinity]) {
      const { transport, sent } = fakeTransport({ payout });
      await assert.rejects(() => buyPulseMatch(buyInput(transport)));
      assert.equal(sent.filter(m => m.buy).length, 0);
    }
  });
  it("real pooled queue executes guards AFTER throttling", async () => {
    const id = "pulse-test-guard";
    const connection = getAccountConnection("not-a-real-token", id) as any;
    const sent: unknown[] = [];
    connection.ensureConnected = async () => {};
    connection.ws = { readyState: 1, send: (message: string) => sent.push(JSON.parse(message)), terminate: () => {} };
    connection.pausedUntil = Date.now() + 70;
    let stopped = false;
    const request = connection.request({ buy: "p1", price: 1 }, 300, { beforeSend: () => { if (stopped) throw new Error("stopped while queued"); } });
    stopped = true;
    await assert.rejects(request, /stopped while queued/);
    assert.equal(sent.length, 0);
    closeAccountConnections(id);
  });
  it("a timed-out queued buy is never sent after the caller has given up", async () => {
    const id = "pulse-test-timeout";
    const connection = getAccountConnection("not-a-real-token", id) as any;
    const sent: unknown[] = [];
    connection.ensureConnected = async () => {};
    connection.ws = { readyState: 1, send: (message: string) => sent.push(JSON.parse(message)), terminate: () => {} };
    connection.pausedUntil = Date.now() + 100;
    assert.equal(await connection.request({ buy: "p1", price: 1 }, 20), null);
    await delay(180);
    assert.equal(sent.length, 0);
    closeAccountConnections(id);
  });
});

describe("recovery parity, boundaries and validation", () => {
  it("keeps the Match Sniper debt-plus-markup policy without a private live ladder", () => {
    let state = createRecoveryState();
    state = reduceRecoveryOutcome(state, false, -1, 1, 3, "DIGITMATCH", 8.93);
    assert.equal(state.unrecoveredAmount, 1);
    assert.equal(applyRecoveryStakeLimits(calculateBotRecoveryStake(state.unrecoveredAmount, 8.93, 10), 500, 1000), 0.35);
    state = reduceRecoveryOutcome(state, false, -0.35, 0.35, 3, "DIGITMATCH", 8.93);
    assert.equal(state.unrecoveredAmount, 1.35);
    const before = { ...state };
    state = reduceRecoveryOutcome(state, true, 2.78, 0.35, 3, "DIGITMATCH", 8.93);
    assert.equal(before.unrecoveredAmount, 1.35); // pure transition
    assert.equal(state.inRecovery, false);
    assert.equal(state.unrecoveredAmount, 0);
    assert.ok(calculateBotRecoveryStake(20, 8.93, 30) > calculateBotRecoveryStake(20, 8.93, 10));
  });
  it("caps normal and recovery stakes before they can cross the remaining SL or zero balance", () => {
    assert.equal(capPulseStake(5, 500, 1000, 0.34), 0);
    assert.equal(capPulseStake(5, 500, 0, 10), 0);
    assert.equal(capPulseStake(5, 500, 1000, 0.35), 0.35);
    assert.equal(capPulseStake(5, 1.999, 1000, 10), 1.99);
    assert.equal(capPulseStake(5, 500, 1000, 2.005), 2);
    assert.equal(capPulseStake(5, NaN, 1000, 10), 0);
  });
  it("owns a distinct executor lease; another bot cannot acquire it as the same generic owner", () => {
    runWithSessionId("pulse-lease-test", () => {
      assert.equal(acquireTradingOwnership("match-pulse"), true);
      assert.equal(acquireTradingOwnership("bots"), false);
      assert.equal(acquireTradingOwnership("neuroai"), false);
      releaseTradingOwnership("bots");
      assert.equal(currentTradingOwner(), "match-pulse");
      releaseTradingOwnership("match-pulse");
    });
    runWithSessionId("pulse-other-account", () => {
      assert.equal(acquireTradingOwnership("bots"), true);
      releaseTradingOwnership("bots");
    });
  });
  it("rejects forged cards, nonfinite amounts, coercion and fractional digits/steps", () => {
    const valid = { scanId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", selectedSymbol: "R_100", marketMode: "locked", stake: 1, stopLoss: 5, takeProfit: 10 };
    assert.equal(parsePulseConfig(valid).executionMode, "paper");
    assert.equal(parsePulseScan({ lockedDigit: 0 }).lockedDigit, 0);
    for (const change of [{ stake: NaN }, { stake: Infinity }, { stake: "1" }, { stake: -1 }, { stopLoss: 0.5 }, { lockedDigit: 1.1 }, { maxRecoverySteps: 2.5 }, { marketMode: "random" }, { card: { qualified: true } }]) {
      assert.throws(() => parsePulseConfig({ ...valid, ...change }));
    }
    assert.throws(() => parsePulseScan({ executionMode: "real" }));
    assert.throws(() => parsePulseScan({ lockedDigit: 10 }));
    assert.throws(() => parsePulseScan(null));
  });
});


describe("account-driven Match Pulse public configuration", () => {
  const valid = { scanId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", selectedSymbol: "R_100", marketMode: "locked", stake: 1, stopLoss: 5, takeProfit: 10 };
  it("uses broker execution and automatic digits without mode inputs", () => {
    assert.deepEqual(parsePulseAccountScan({}), { executionMode: "live" });
    const config = parsePulseAccountConfig(valid);
    assert.equal(config.executionMode, "live", "Deriv demo accounts use the broker too, not local paper settlement");
    assert.equal(config.lockedDigit, undefined);
    assert.equal(config.marketMode, "locked");
    assert.equal(parsePulseAccountConfig({ ...valid, marketMode: "switching" }).marketMode, "switching");
  });
  it("rejects removed mode/digit overrides and client-selected account types", () => {
    for (const override of [{ executionMode: "paper" }, { executionMode: "live" }, { lockedDigit: 7 }, { lockedDigit: null }, { isVirtual: true }, { accountId: "another-account" }]) {
      assert.throws(() => parsePulseAccountScan(override), /Unsupported field/);
      assert.throws(() => parsePulseAccountConfig({ ...valid, ...override }), /Unsupported field/);
    }
  });
});
