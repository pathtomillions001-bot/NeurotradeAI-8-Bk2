import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyseHedgeCandidate, type HedgeCandidate, type HedgeContractType, type HedgeMode, candidateKey } from "./hedge-analysis";
import { decideHedge } from "./contest";
import { applyRematch, applySettlement, requiredConfirmations, type HedgeMemory } from "./hedge-state";

function edgeWins(n: number): boolean[] {
  return Array.from({ length: n }, (_, i) => i % 5 !== 4);
}

function row(opts: {
  symbol: string;
  group: number;
  contract?: HedgeContractType;
  barrier?: number;
  seq: number;
  strong: boolean;
  mode?: HedgeMode;
}): HedgeCandidate {
  const mode = opts.mode ?? "NORMAL";
  const wins = opts.strong ? edgeWins(120) : Array.from({ length: 120 }, (_, i) => i % 2 === 0);
  const payout = opts.strong ? 1.9 : 1.2;
  const barrier = opts.barrier ?? -1;
  const contract = opts.contract ?? "CALL";
  const stats = analyseHedgeCandidate({ wins, p0: 0.5, payout, mode });
  return {
    ...stats,
    symbol: opts.symbol,
    group: opts.group,
    contract,
    barrier,
    payout,
    tickSequence: opts.seq,
    key: candidateKey(opts.symbol, contract, barrier),
  };
}

describe("autonomous contest (1-tick, 4 groups)", () => {
  it("returns null and clears a pending confirmation when no market ranked", () => {
    const memory: HedgeMemory = { confirmation: { key: "x", sequence: 1, count: 1 } };
    assert.equal(decideHedge({ rows: [], mode: "NORMAL", memory, lossRun: 0 }), null);
    assert.equal(memory.confirmation, undefined);
  });

  it("normal mode fires immediately on an eligible best candidate", () => {
    const memory: HedgeMemory = {};
    const decision = decideHedge({
      rows: [row({ symbol: "R_100", group: 1, seq: 10, strong: true }), row({ symbol: "1HZ10V", group: 0, seq: 10, strong: false })],
      mode: "NORMAL",
      memory,
      lossRun: 0,
    });
    assert.ok(decision);
    assert.equal(decision.best.symbol, "R_100");
    assert.equal(decision.eligible, true);
    assert.match(decision.reason, /^READY/);
    assert.equal(decision.groupWinners.length, 2, "one winner per group that has rows");
  });

  it("holds with the blocking reason when the best candidate is not eligible", () => {
    const decision = decideHedge({
      rows: [row({ symbol: "R_100", group: 1, seq: 10, strong: false })],
      mode: "NORMAL",
      memory: {},
      lossRun: 0,
    });
    assert.ok(decision);
    assert.equal(decision.eligible, false);
    assert.match(decision.reason, /^HOLD/);
  });

  it("recovery needs the same eligible candidate on two DISTINCT ticks", () => {
    const memory: HedgeMemory = {};
    const first = decideHedge({ rows: [row({ symbol: "R_50", group: 1, seq: 100, strong: true, mode: "RECOVERY" })], mode: "RECOVERY", memory, lossRun: 1 });
    assert.ok(first);
    assert.equal(first.eligible, false);
    assert.equal(first.confirmations, 1);

    // The same tick evaluated twice must not count twice.
    const repeat = decideHedge({ rows: [row({ symbol: "R_50", group: 1, seq: 100, strong: true, mode: "RECOVERY" })], mode: "RECOVERY", memory, lossRun: 1 });
    assert.ok(repeat);
    assert.equal(repeat.confirmations, 1);
    assert.equal(repeat.eligible, false);

    const second = decideHedge({ rows: [row({ symbol: "R_50", group: 1, seq: 101, strong: true, mode: "RECOVERY" })], mode: "RECOVERY", memory, lossRun: 1 });
    assert.ok(second);
    assert.equal(second.confirmations, 2);
    assert.equal(second.eligible, true);
  });

  it("escalates recovery confirmations to three once the loss run is three or more", () => {
    assert.equal(requiredConfirmations(1), 2);
    assert.equal(requiredConfirmations(2), 2);
    assert.equal(requiredConfirmations(3), 3);
    assert.equal(requiredConfirmations(7), 3);
  });

  it("a different best candidate restarts the confirmation count", () => {
    const memory: HedgeMemory = {};
    decideHedge({ rows: [row({ symbol: "R_50", group: 1, seq: 1, strong: true, mode: "RECOVERY" })], mode: "RECOVERY", memory, lossRun: 1 });
    const other = decideHedge({ rows: [row({ symbol: "R_25", group: 1, seq: 2, strong: true, mode: "RECOVERY" })], mode: "RECOVERY", memory, lossRun: 1 });
    assert.ok(other);
    assert.equal(other.confirmations, 1);
  });

  it("a settled loss arms a rematch penalty on the losing tuple, decaying with fresh tape", () => {
    const memory: HedgeMemory = {};
    applySettlement(memory, { won: false, key: "R_100:CALL:-1", lossRun: 1, decisionSequence: 50 });
    assert.deepEqual(memory.rematch, { key: "R_100:CALL:-1", penalty: 8, epoch: 50 });

    const rows = [row({ symbol: "R_100", group: 1, seq: 51, strong: true })];
    const before = rows[0].score;
    const rescan = applyRematch(rows, memory);
    assert.equal(rescan, true);
    assert.ok(Math.abs(rows[0].score - (before - 8)) < 1e-9);
    assert.ok(Math.abs((memory.rematch?.penalty ?? 0) - 7.2) < 1e-9, "penalty decays 0.8 per fresh tick");
  });

  it("the penalty grows with the loss run and a win clears every penalty", () => {
    const memory: HedgeMemory = {};
    applySettlement(memory, { won: false, key: "a", lossRun: 3, decisionSequence: 1 });
    assert.equal(memory.rematch?.penalty, 12);
    applySettlement(memory, { won: true, key: "a", lossRun: 0, decisionSequence: 2 });
    assert.equal(memory.rematch, undefined);
    assert.equal(memory.confirmation, undefined);
  });

  it("a rematch that has fully decayed is removed", () => {
    const memory: HedgeMemory = { rematch: { key: "k", penalty: 0.5, epoch: 1 } };
    applyRematch([row({ symbol: "R_10", group: 1, seq: 2, strong: true })], memory);
    assert.equal(memory.rematch, undefined);
  });
});
