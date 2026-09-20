import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canDeployNexus,
  nexusDeployBody,
  nexusPercent,
  type NexusScanView,
  type NexusMarketView,
} from "./match-nexus";
import { isPaperBot, stopPathForBot, openPathForBot } from "./live-bots";

const market = { symbol: "R_100", deployable: true } as NexusMarketView;
const scan = {
  scanId: "server-capability",
  expiresAt: 2000,
  config: { executionMode: "paper" },
} as NexusScanView;

describe("Nexus console contract", () => {
  it("sends only the server capability, chosen market, post-scan mode and live confirmation", () => {
    assert.deepEqual(nexusDeployBody(scan, "R_100", "locked"), {
      scanId: "server-capability",
      symbol: "R_100",
      marketMode: "locked",
      confirmLive: false,
    });
    assert.equal(
      nexusDeployBody(scan, "R_100", "switching", true).marketMode,
      "switching",
    );
    assert.ok(!("card" in nexusDeployBody(scan, "R_100", "locked")));
    assert.ok(!("stake" in nexusDeployBody(scan, "R_100", "locked")));
  });
  it("blocks empty, expired and simulated-live scans", () => {
    assert.equal(canDeployNexus(null, market, 1000, false), false);
    assert.equal(canDeployNexus(scan, undefined, 1000, false), false);
    assert.equal(canDeployNexus(scan, market, 2000, false), false);
    assert.equal(
      canDeployNexus(scan, { ...market, deployable: false }, 1000, true),
      false,
    );
    assert.equal(canDeployNexus(scan, market, 1000, false), true);
  });
  it("requires a separate live confirmation but not a fabricated certainty score", () => {
    const live = {
      ...scan,
      config: { ...scan.config, executionMode: "live" as const },
    };
    assert.equal(canDeployNexus(live, market, 1000, false), false);
    assert.equal(canDeployNexus(live, market, 1000, true), true);
  });
  it("renders missing measurements honestly, not as a zero-percent hit rate", () => {
    assert.equal(nexusPercent(null), "—");
    assert.equal(nexusPercent(NaN), "—");
    assert.equal(nexusPercent(0), "0.0%");
    assert.equal(nexusPercent(0.112), "11.2%");
  });
  it("labels a paper engine separately from live account execution", () => {
    assert.equal(
      isPaperBot({ running: true, nexus: { executionMode: "paper" } }),
      true,
    );
    assert.equal(
      isPaperBot({ running: true, nexus: { executionMode: "live" } }),
      false,
    );
    assert.equal(isPaperBot({ running: true }), false);
  });
  it("is openable and stoppable from the global running-bot indicator", () => {
    assert.equal(stopPathForBot("match-nexus"), "/api/bots/match-nexus/stop");
    assert.equal(openPathForBot("match-nexus"), "/bots?open=match-nexus");
  });
});
