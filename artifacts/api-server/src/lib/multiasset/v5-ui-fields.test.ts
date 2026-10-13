/**
 * v5 UI — the additive, optional API fields the Desk rebuild reads.
 *
 * Every field here is derived from a value the server ALREADY held (the
 * decision's own gatekeeper, the position's own stop geometry, the stored
 * weekly rows, the fill→plan join). None of them changes a behaviour, and a
 * client that predates them sees exactly the responses it saw before. The rule
 * these tests enforce is the rollout's own: a derived field is either the
 * honest reading of a stored value or null — never a fabricated zero.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import express from "express";

import { runWithSession } from "../session";
import { resolveDeskV4Config, setDeskV4ForTests, deskV4Summary } from "./desk-v4-config";
import {
  analysisThresholds,
  positionManagementState,
  scanEdgeFields,
  withManagementState,
} from "./presenter";
import { MIN_COST_COVERAGE, MIN_RR_FILL } from "./desk-constants";
import { DEFAULT_MIN_EDGE_R } from "./agent";
import {
  CALIBRATION_BUCKET_EDGES,
  calibrationBuckets,
  LOWER80_Z,
  meanRLower80,
  weeklyReport,
  type WeeklyTrade,
} from "./governance";
import {
  __resetGovernanceRuntimeForTests,
  agentsForTicket,
  bindTicket,
  rememberPlan,
} from "./governance-runtime";
import { getDesk, resetDesk } from "./store";
import type { Position } from "./types";
import router from "../../routes/desk";

const SESSION = "55555555-6666-7777-8888-999999999999";

function position(overrides: Partial<Position>): Position {
  return {
    ticket: 1,
    symbol: "EURUSD",
    side: "buy",
    volume: 0.1,
    openPrice: 1.1,
    openTime: 0,
    sl: null,
    tp: null,
    profit: 0,
    swap: 0,
    commission: 0,
    ...overrides,
  };
}

function trade(overrides: Partial<WeeklyTrade>): WeeklyTrade {
  return {
    symbol: "EURUSD",
    mode: "intraday",
    side: "buy",
    closedAtMs: 0,
    realisedR: null,
    netProfit: 0,
    predictedProbability: null,
    slippageR: null,
    ...overrides,
  };
}

describe("v5 UI fields — pure derivations", () => {
  it("reads the management state from stop geometry only", () => {
    // No stop ⇒ nothing has been moved ⇒ open (never "be").
    assert.equal(positionManagementState(position({ sl: null })), "open");
    // A buy's stop below entry still carries the initial risk.
    assert.equal(positionManagementState(position({ openPrice: 1.1, sl: 1.095 })), "open");
    // At entry, or beyond it, the initial risk is gone: breakeven armed.
    assert.equal(positionManagementState(position({ openPrice: 1.1, sl: 1.1 })), "be");
    assert.equal(positionManagementState(position({ openPrice: 1.1, sl: 1.102 })), "be");
    // Mirrored for a sell: the stop must be at or BELOW entry.
    assert.equal(positionManagementState(position({ side: "sell", openPrice: 1.1, sl: 1.105 })), "open");
    assert.equal(positionManagementState(position({ side: "sell", openPrice: 1.1, sl: 1.1 })), "be");
    assert.equal(positionManagementState(position({ side: "sell", openPrice: 1.1, sl: 1.098 })), "be");
    // A nonsense stop (0 from the wire) is not geometry: open.
    assert.equal(positionManagementState(position({ sl: 0 })), "open");
    // The wrapper adds the field and keeps every other byte.
    const wrapped = withManagementState(position({ ticket: 7, sl: 1.2 }));
    assert.equal(wrapped.managementState, "be");
    assert.equal(wrapped.ticket, 7);
    assert.equal(wrapped.sl, 1.2);
  });

  it("derives the scan edge columns from the decision alone, null when absent", () => {
    assert.deepEqual(scanEdgeFields({ monteCarlo: null, gatekeeper: null }), {
      rrFill: null,
      edgeFloorR: null,
      edgeRequiredR: null,
    });
    // monteCarlo.rewardRisk IS the R:R at the expected fill (agent.ts §5a).
    assert.deepEqual(
      scanEdgeFields({ monteCarlo: { rewardRisk: 2.456 }, gatekeeper: null }),
      { rrFill: 2.46, edgeFloorR: null, edgeRequiredR: null },
    );
    // The gatekeeper supplies the floor and the bar it had to beat — including
    // a null evLcbR (no model ⇒ no floor), which must stay null.
    assert.deepEqual(
      scanEdgeFields({ monteCarlo: null, gatekeeper: { evLcbR: 0.31, requiredEvLcbR: 0.2 } }),
      { rrFill: null, edgeFloorR: 0.31, edgeRequiredR: 0.2 },
    );
    assert.deepEqual(
      scanEdgeFields({ monteCarlo: null, gatekeeper: { evLcbR: null, requiredEvLcbR: 0.25 } }),
      { rrFill: null, edgeFloorR: null, edgeRequiredR: 0.25 },
    );
  });

  it("serves the gate constants the Decision panel prints, from desk-constants", () => {
    assert.deepEqual(analysisThresholds(), {
      minRrFill: MIN_RR_FILL,
      minCostCoverage: MIN_COST_COVERAGE,
      minEdgeR: DEFAULT_MIN_EDGE_R,
    });
    assert.equal(analysisThresholds().minRrFill, 2.0);
    assert.equal(analysisThresholds().minCostCoverage, 4);
    // The live routes never override minEdgeR, so the legacy expectancy floor
    // the UI prints is the agent's own default.
    assert.equal(analysisThresholds().minEdgeR, 0.15);
  });

  it("summarises the v4 flags without changing them", () => {
    const restore = setDeskV4ForTests(resolveDeskV4Config({} as NodeJS.ProcessEnv));
    const off = deskV4Summary();
    assert.equal(off.enabled, false);
    assert.equal(off.shadow, true, "shadow defaults to TRUE — the safe reading of an unset switch");
    assert.equal(off.layers.governance, false);
    restore();

    const restore2 = setDeskV4ForTests(
      resolveDeskV4Config({
        DESK_V4_ENABLED: "1",
        DESK_V4_SHADOW: "1",
        DESK_V4_GOVERNANCE: "1",
        DESK_V4_REGIME_HMM: "1",
      } as NodeJS.ProcessEnv),
    );
    const on = deskV4Summary();
    assert.equal(on.enabled, true);
    assert.equal(on.shadow, true, "shadow is the shipped default even with the master switch on");
    assert.equal(on.layers.governance, true);
    assert.equal(on.layers.regimeHmm, true);
    assert.equal(on.layers.gatekeeper, false, "a flag nobody set stays off");
    restore2();
  });

  it("buckets calibration from stored rows only, and omits empty buckets", () => {
    // Two measurable trades in 60–70%, one win one loss; an unmeasured trade
    // and an unpredicted trade cannot calibrate and must be excluded.
    const buckets = calibrationBuckets([
      trade({ predictedProbability: 0.62, realisedR: 1.8 }),
      trade({ predictedProbability: 0.68, realisedR: -1 }),
      trade({ predictedProbability: 0.55, realisedR: null }),
      trade({ predictedProbability: null, realisedR: 2 }),
      // p = 1 lands in the TOP bucket, not off the table.
      trade({ predictedProbability: 1, realisedR: 0.5 }),
    ]);
    assert.equal(buckets.length, 2);
    const bucket = buckets.find((b) => b.label === "60–70%");
    assert.ok(bucket);
    assert.equal(bucket.n, 2);
    assert.ok(Math.abs((bucket.meanPredicted ?? 0) - 0.65) < 1e-9);
    assert.equal(bucket.realisedHitRate, 0.5);
    assert.ok(Math.abs((bucket.gapPoints ?? 0) - (50 - 65)) < 1e-9, "realised 50% vs predicted 65% ⇒ −15 pts");
    assert.equal(buckets.find((b) => b.label === "90–100%")?.n, 1);
    // No measurable trades ⇒ no buckets at all (never a 0% hit rate row).
    assert.deepEqual(calibrationBuckets([trade({}), trade({ predictedProbability: 0.7, realisedR: null })]), []);
    // The edges are the documented table, in order, and the top bucket catches 1.
    assert.equal(CALIBRATION_BUCKET_EDGES[0].label, "<50%");
    assert.ok(CALIBRATION_BUCKET_EDGES[CALIBRATION_BUCKET_EDGES.length - 1].upper > 1);
  });

  it("computes the one-sided 80% lower bound, and refuses to guess below n=2", () => {
    assert.equal(meanRLower80([]), null);
    assert.equal(meanRLower80([1.2]), null, "one sample has no sd; a bound there would be the sample itself");
    // [1, −1]: mean 0, sample sd √2 ⇒ 0 − 1.2816·√2/√2 = −1.2816.
    const bound = meanRLower80([1, -1]);
    assert.ok(bound !== null && Math.abs(bound + LOWER80_Z) < 1e-9, `got ${bound}`);
    // A tight, positive stream keeps a positive bound.
    const tight = meanRLower80([0.5, 0.6, 0.55, 0.65, 0.5]);
    assert.ok(tight !== null && tight > 0);
  });

  it("carries the new fields through the weekly report", () => {
    const report = weeklyReport({
      weekStartMs: 0,
      weekEndMs: 7 * 86_400_000,
      generatedAtMs: 0,
      trades: [
        trade({ closedAtMs: 86_400_000, predictedProbability: 0.62, realisedR: 1.8 }),
        trade({ closedAtMs: 2 * 86_400_000, predictedProbability: 0.66, realisedR: -1 }),
        trade({ closedAtMs: 3 * 86_400_000, predictedProbability: null, realisedR: null }),
      ],
      evaluations: [],
      registry: [],
    });
    assert.equal(report.trades.calibrationBuckets.length, 1);
    assert.equal(report.trades.calibrationBuckets[0].n, 2);
    assert.ok(report.trades.meanRLower80 !== null);
    // measured [1.8, −1]: mean 0.4, SAMPLE sd √3.92 ⇒ 0.4 − 1.2816·√3.92/√2.
    const expected = 0.4 - (LOWER80_Z * Math.sqrt(3.92)) / Math.sqrt(2);
    assert.ok(Math.abs((report.trades.meanRLower80 ?? 0) - expected) < 1e-9);
  });

  it("joins a filled ticket to the agents that proposed it, or null", () => {
    __resetGovernanceRuntimeForTests();
    rememberPlan({
      sessionId: SESSION,
      planId: "plan-9",
      symbol: "EURUSD",
      mode: "intraday",
      direction: "buy",
      agents: ["trend"],
      predictedProbability: null,
      armedAtMs: 1,
    });
    bindTicket(9, "plan-9");
    assert.deepEqual(agentsForTicket(9), ["trend"]);
    // A ticket nobody bound, and a plan whose memory is gone, are both null —
    // "unknown", never "no agents".
    assert.equal(agentsForTicket(1234), null);
    bindTicket(10, "plan-that-was-evicted");
    assert.equal(agentsForTicket(10), null);
    __resetGovernanceRuntimeForTests();
  });
});

describe("v5 UI fields — on the wire", () => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    runWithSession(SESSION, next);
  });
  app.use("/api/desk", router);
  const server = createServer(app);
  let baseUrl = "";
  let restore: () => void = () => {};

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });
  after(async () => {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${baseUrl}${path}`);
    return { status: response.status, body: await response.json() };
  };

  it("GET /state carries the v4 summary and position management states", async () => {
    resetDesk(SESSION);
    __resetGovernanceRuntimeForTests();
    restore = setDeskV4ForTests(resolveDeskV4Config({} as NodeJS.ProcessEnv));
    const desk = getDesk(SESSION);
    desk.positions = [
      position({ ticket: 1, sl: 1.095 }),
      position({ ticket: 2, sl: 1.101 }),
    ];

    const off = await get("/api/desk/state");
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.v4.enabled, false);
    assert.equal(off.body.positions[0].managementState, "open");
    assert.equal(off.body.positions[1].managementState, "be");
    // Every pre-existing field is still there, untouched.
    assert.equal(off.body.positions[1].ticket, 2);
    assert.equal(off.body.source, "unlinked");
    restore();

    restore = setDeskV4ForTests(
      resolveDeskV4Config({ DESK_V4_ENABLED: "1", DESK_V4_SHADOW: "1", DESK_V4_GOVERNANCE: "1" } as NodeJS.ProcessEnv),
    );
    const on = await get("/api/desk/state");
    assert.equal(on.body.v4.enabled, true);
    assert.equal(on.body.v4.shadow, true);
    assert.equal(on.body.v4.layers.governance, true);
    restore();
  });

  it("GET /performance attributes closed trades through the fill→plan join", async () => {
    resetDesk(SESSION);
    __resetGovernanceRuntimeForTests();
    restore = setDeskV4ForTests(resolveDeskV4Config({} as NodeJS.ProcessEnv));
    const desk = getDesk(SESSION);
    rememberPlan({
      sessionId: SESSION,
      planId: "plan-21",
      symbol: "XAUUSD",
      mode: "scalp",
      direction: "sell",
      agents: ["vol-regime"],
      predictedProbability: null,
      armedAtMs: 1,
    });
    bindTicket(21, "plan-21");
    desk.closedTrades = [
      { ticket: 21, symbol: "XAUUSD", side: "sell", volume: 0.05, openPrice: 2400, profit: 12, swap: 0, commission: -0.5, rMultiple: 1.4, openedAt: 0, closedAt: 1 },
      { ticket: 22, symbol: "EURUSD", side: "buy", volume: 0.1, openPrice: 1.1, profit: -8, swap: 0, commission: -0.5, rMultiple: -1, openedAt: 0, closedAt: 2 },
    ];

    const response = await get("/api/desk/performance");
    assert.equal(response.status, 200);
    const byTicket = new Map(response.body.closedTrades.map((t: any) => [t.ticket, t]));
    assert.deepEqual(byTicket.get(21).agents, ["vol-regime"]);
    assert.equal(byTicket.get(22).agents, null, "an unbound ticket is unknown, not agent-less");
    // The rest of the trade row is byte-for-byte what it was.
    assert.equal(byTicket.get(21).rMultiple, 1.4);
    restore();
    __resetGovernanceRuntimeForTests();
  });
});
