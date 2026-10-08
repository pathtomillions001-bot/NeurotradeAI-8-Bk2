/**
 * GET /api/desk/performance — the quant metrics block.
 *
 * The block is additive: every key the Desk already reads must still be there,
 * and the new `metrics` block must be computed from the same closed-trade record.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { schemaReady } from "@workspace/db";
import { runWithSession } from "../lib/session";
import { getDesk, recordDealClose, resetDesk } from "../lib/multiasset/store";
import type { ClosedDealReport } from "../lib/multiasset/types";
import deskRouter from "./desk";

const SESSION = "desk-performance-session";

function deal(positionId: number, profit: number, reason: ClosedDealReport["reason"], minutesAgo: number): ClosedDealReport {
  const closeTime = Date.now() - minutesAgo * 60_000;
  return {
    dealTicket: positionId * 10 + 1,
    positionId,
    symbol: "EURUSD",
    side: "buy",
    volume: 0.1,
    openPrice: 1.085,
    closePrice: 1.09,
    openTime: closeTime - 10 * 60_000,
    closeTime,
    profit,
    commission: 0,
    swap: 0,
    reason,
    planId: `plan-${positionId}`,
    initialRiskMoney: 25,
    initialRiskPoints: 120,
    mfeR: null,
    maeR: null,
  };
}

describe("GET /api/desk/performance — quant metrics", () => {
  const app = express();
  app.use((_req, _res, next) => runWithSession(SESSION, next));
  app.use("/api/desk", deskRouter);
  const server = createServer(app);
  let baseUrl = "";

  before(async () => {
    await schemaReady;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}/api/desk`;
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    resetDesk(SESSION);
  });

  async function performance(): Promise<Record<string, any>> {
    const response = await runWithSession(SESSION, () => fetch(`${baseUrl}/performance`));
    assert.equal(response.status, 200);
    return (await response.json()) as Record<string, any>;
  }

  it("keeps every existing key and adds the metrics block", async () => {
    const body = await performance();
    for (const key of ["source", "currency", "equityCurve", "closedTrades", "bySymbol", "overall", "outcomes", "realisedPnl", "generatedAt"]) {
      assert.ok(key in body, `${key} is still returned`);
    }
    assert.ok("metrics" in body);
  });

  it("computes the metrics from the realised record, by mode and by exit reason", async () => {
    const desk = getDesk(SESSION);
    desk.positionModes.set(1, "scalp");
    desk.positionModes.set(2, "intraday");
    desk.positionModes.set(3, "intraday");
    recordDealClose(desk, deal(1, 50, "tp", 30)); // +2.0R, scalp
    recordDealClose(desk, deal(2, -25, "sl", 20)); // −1.0R, intraday
    recordDealClose(desk, deal(3, 10, "time_stop", 10)); // +0.4R, intraday

    const { metrics } = await performance();
    assert.equal(metrics.basis.trades, 3);
    assert.equal(metrics.basis.dealSourced, 3, "every trade here came from the terminal's own deal");
    assert.equal(metrics.basis.riskPct, desk.policy.baseRiskPct, "drawdown is stated at the base risk");

    // Mean of 2.0, −1.0 and 0.4.
    assert.ok(Math.abs(metrics.expectancyR - (2 - 1 + 0.4) / 3) < 1e-9);

    const byMode = Object.fromEntries(metrics.byMode.map((m: any) => [m.mode, m.trades]));
    assert.deepEqual(byMode, { scalp: 1, intraday: 2, swing: 0 });

    const reasons = Object.fromEntries(metrics.exitReasons.map((r: any) => [r.reason, r.trades]));
    assert.deepEqual(reasons, { tp: 1, sl: 1, time_stop: 1 });
    const tp = metrics.exitReasons.find((r: any) => r.reason === "tp");
    assert.equal(tp.meanR, 2);
  });

  it("an empty record returns zeroed metrics, not an error", async () => {
    const { metrics } = await performance();
    assert.equal(metrics.basis.trades, 0);
    assert.equal(metrics.expectancyR, 0);
    assert.equal(metrics.exitReasons.length, 0);
  });
});
