import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAutonomousHedgeAgents } from "./agents";
import type { HedgeAgentInput } from "./agents/common";
import { analyseHedgeCandidate, buildMarketCandidates } from "./hedge-analysis";
import { decideHedge } from "./contest";
import { readHedgeTape } from "./tape";

const EXPECTED_AGENT_IDS = [
  "marketScanner", "tickIntelligence", "digitProbability", "riseFallAgent",
  "marketRegime", "executionTiming", "confidenceFusion", "recoveryIntelligence",
  "durationOptimizer", "portfolioManager", "riskIntelligence", "learningAgent",
  "patternDiscovery", "tradeExplainability",
];

function baseInput(overrides: Partial<HedgeAgentInput> = {}): HedgeAgentInput {
  return {
    mode: "NORMAL",
    decision: null,
    rows: [],
    tapes: [],
    configuredMarkets: 0,
    lossRun: 0,
    recovery: { inRecovery: false, step: 0, debt: 0 } as any,
    risk: { hardStop: false, riskBudget: 1, riskLevel: "low", stakeMultiplier: 1, recommendedStake: 1 } as any,
    memory: {},
    exposureOpen: false,
    ...overrides,
  };
}

function assertWellFormed(outputs: Record<string, any>): void {
  assert.deepEqual(Object.keys(outputs).sort(), [...EXPECTED_AGENT_IDS].sort());
  for (const id of EXPECTED_AGENT_IDS) {
    const out = outputs[id];
    assert.equal(out.agentId, id);
    assert.ok(Number.isFinite(out.score) && out.score >= 0 && out.score <= 100, `${id} score in range`);
    assert.ok(Number.isFinite(out.confidence) && out.confidence >= 0 && out.confidence <= 100, `${id} confidence in range`);
    assert.equal(typeof out.reasoning, "string");
  }
}

describe("autonomous Nexus-logic agents", () => {
  it("runs all 14 agents on an empty cycle without throwing", () => {
    assertWellFormed(runAutonomousHedgeAgents(baseInput()));
  });

  it("runs all 14 agents on a real ranked cycle", () => {
    const digits = Array.from({ length: 120 }, (_, i) => (i * 3 + 1) % 10);
    const prices = digits.map((d, i) => 100 + i * 0.01 + d * 0.001);
    const rows = buildMarketCandidates({
      symbol: "R_100", group: 1, digits, prices, tickSequence: 999,
      specs: [{ type: "DIGITOVER", barrier: 2 }, { type: "CALL", barrier: -1 }, { type: "DIGITEVEN", barrier: -1 }],
      mode: "NORMAL",
    });
    const decision = decideHedge({ rows, mode: "NORMAL", memory: {}, lossRun: 0 });
    assert.ok(decision);
    const tape = readHedgeTape("R_100", 120);
    const outputs = runAutonomousHedgeAgents(baseInput({
      decision,
      rows,
      tapes: tape ? [tape] : [],
      configuredMarkets: 1,
      lossRun: 2,
      recovery: { inRecovery: true, step: 2, debt: 3.5 } as any,
      risk: { hardStop: false, riskBudget: 0.6, riskLevel: "medium", stakeMultiplier: 0.7, recommendedStake: 0.7 } as any,
      exposureOpen: true,
    }));
    assertWellFormed(outputs);
    assert.equal(outputs.portfolioManager.score, 0, "an open exposure blocks a new trade");
  });

  it("recovery intelligence reflects the debt it is given", () => {
    const outputs = runAutonomousHedgeAgents(baseInput({
      mode: "RECOVERY",
      recovery: { inRecovery: true, step: 1, debt: 2 } as any,
    }));
    assert.ok(outputs.recoveryIntelligence.reasoning.length > 0);
  });

  it("the analysis helper keeps candidate statistics consistent for the agents", () => {
    const stats = analyseHedgeCandidate({ wins: Array.from({ length: 30 }, () => true), p0: 0.5, payout: 1.9, mode: "NORMAL" });
    assert.equal(stats.losses, 0);
    assert.equal(stats.samples, 30);
  });
});
