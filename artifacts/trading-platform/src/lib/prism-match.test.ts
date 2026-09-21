import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canDeployPrism,
  prismDeployBody,
  prismPercent,
  type PrismScanView,
  type PrismMarketView,
} from "./prism-match";
import { isPaperBot, stopPathForBot, openPathForBot } from "./live-bots";

const market = { symbol: "R_100", deployable: true } as PrismMarketView;
const scan = {
  scanId: "server-capability",
  expiresAt: 2000,
  config: { executionMode: "paper" },
} as PrismScanView;

describe("Prism console contract", () => {
  it("sends only the server capability, chosen market, post-scan mode and live confirmation", () => {
    assert.deepEqual(prismDeployBody(scan, "R_100", "locked"), {
      scanId: "server-capability",
      symbol: "R_100",
      marketMode: "locked",
      confirmLive: false,
    });
    assert.equal(
      prismDeployBody(scan, "R_100", "switching", true).marketMode,
      "switching",
    );
    assert.ok(!("card" in prismDeployBody(scan, "R_100", "locked")));
    assert.ok(!("stake" in prismDeployBody(scan, "R_100", "locked")));
  });
  it("blocks empty, expired and simulated-live scans", () => {
    assert.equal(canDeployPrism(null, market, 1000, false), false);
    assert.equal(canDeployPrism(scan, undefined, 1000, false), false);
    assert.equal(canDeployPrism(scan, market, 2000, false), false);
    assert.equal(
      canDeployPrism(scan, { ...market, deployable: false }, 1000, true),
      false,
    );
    assert.equal(canDeployPrism(scan, market, 1000, false), true);
  });
  it("requires a separate live confirmation but not a fabricated certainty score", () => {
    const live = {
      ...scan,
      config: { ...scan.config, executionMode: "live" as const },
    };
    assert.equal(canDeployPrism(live, market, 1000, false), false);
    assert.equal(canDeployPrism(live, market, 1000, true), true);
  });
  it("renders missing measurements honestly, not as a zero-percent hit rate", () => {
    assert.equal(prismPercent(null), "—");
    assert.equal(prismPercent(NaN), "—");
    assert.equal(prismPercent(0), "0.0%");
    assert.equal(prismPercent(0.112), "11.2%");
  });
  it("labels a paper engine separately from live account execution", () => {
    assert.equal(
      isPaperBot({ running: true, prism: { executionMode: "paper" } }),
      true,
    );
    assert.equal(
      isPaperBot({ running: true, prism: { executionMode: "live" } }),
      false,
    );
    assert.equal(isPaperBot({ running: true }), false);
  });
  it("is openable and stoppable from the global running-bot indicator", () => {
    assert.equal(stopPathForBot("prism-match"), "/api/bots/prism-match/stop");
    assert.equal(openPathForBot("prism-match"), "/bots?open=prism-match");
  });
});
