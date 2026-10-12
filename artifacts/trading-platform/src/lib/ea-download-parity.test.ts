/**
 * The EA the Desk hands out must be the EA this repository builds.
 *
 * WHY THIS TEST EXISTS: `public/downloads/NeurotradeBridge.mq5` is what the
 * bridge dialog's download button serves, and it had silently drifted to a
 * build that predated the entire v3 rewrite (still `#property version "2.00"`).
 * Users compiled it, and the consequences were visible for weeks:
 *
 *   • it sent economic-calendar times in broker-server time, unconverted;
 *   • it only read the next TWO hours of the calendar and reported no read
 *     counts, so the desk rendered "No high-impact events in the next 24
 *     hours. The gate stays armed." while MT5's own Calendar tab showed three
 *     red-folder releases for the day;
 *   • it had no persistent link, so every server restart put the terminal into
 *     a 5-second `HTTP 401 … Unknown or expired pairing code` loop.
 *
 * `scripts/copy-mt5-ea.mjs` publishes the file during `pnpm build`, which means
 * a deployed bundle can be correct while the repository copy is stale — and the
 * stale copy is exactly what a reviewer or a self-hoster ships. This asserts
 * parity, so the drift cannot come back unnoticed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const source = path.join(repoRoot, "artifacts", "mt5-ea", "NeurotradeBridge.mq5");
const published = path.join(
  repoRoot,
  "artifacts",
  "trading-platform",
  "public",
  "downloads",
  "NeurotradeBridge.mq5",
);

/** The `#property version "x.yz"` the EA declares. */
function declaredVersion(file: string): string {
  const match = fs.readFileSync(file, "utf8").match(/#property\s+version\s+"([^"]+)"/);
  assert.ok(match, `${file} must declare #property version`);
  return match[1];
}

/**
 * The version the API says it expects, read from the API's own source.
 *
 * Pinned as a literal here, this check drifted: the EA moved to 3.05 while the
 * route still said `EXPECTED_EA_VERSION = "3.04"`, so the comparison was against
 * a number nobody maintained. Reading it means the two sides are asserted
 * against EACH OTHER, which is the property that actually matters — a terminal
 * running the EA this repository ships must never be told it is out of date.
 */
const apiBridgeRoute = path.join(repoRoot, "artifacts", "api-server", "src", "routes", "bridge.ts");

function expectedEaVersion(): string {
  const match = fs.readFileSync(apiBridgeRoute, "utf8").match(/EXPECTED_EA_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(match, `${apiBridgeRoute} must declare EXPECTED_EA_VERSION`);
  return match[1];
}

test("the downloadable EA is byte-identical to the EA source", () => {
  assert.ok(fs.existsSync(source), `EA source missing: ${source}`);
  assert.ok(fs.existsSync(published), `published EA missing: ${published}`);
  assert.equal(
    fs.readFileSync(published, "utf8"),
    fs.readFileSync(source, "utf8"),
    "public/downloads/NeurotradeBridge.mq5 is stale — run `node scripts/copy-mt5-ea.mjs`",
  );
});

/**
 * The EA writes exactly one kind of record to disk — and it is not the link.
 *
 * v3.08 moved the bearer token into memory: closing MT5 must end the
 * connection, so nothing about a session may survive the process. What the EA
 * still persists is the POSITION-MANAGER state (v3.05), which has to survive a
 * restart or an open position would be left unmanaged. These assertions keep
 * the two apart: the file writes must be the manager's, with a real handle, and
 * none of them may carry the token.
 */
test("the only file writes are the position manager's, and never the token", () => {
  const source_body = fs.readFileSync(source, "utf8");
  const writes = [...source_body.matchAll(/\bFileWriteString\s*\(([^;]*?)\)\s*;/g)];

  assert.ok(writes.length > 0, "the position manager must still persist its records (v3.05)");
  for (const [, args] of writes) {
    assert.match(args, /^\s*handle\s*,/, `FileWriteString must receive its open handle: ${args}`);
    assert.doesNotMatch(args, /g_token/, `the link token must never be written to disk: ${args}`);
  }
  // And no link FILE is touched anywhere except the routine that deletes the
  // one an older build left behind.
  assert.doesNotMatch(source_body, /SaveLink\s*\(/, "the EA must not write a link file");
  const removalStart = source_body.indexOf("void RemoveLegacyLinkFile");
  const removalEnd = source_body.indexOf("\n}", removalStart);
  for (const match of source_body.matchAll(/"\.link"/g)) {
    const at = match.index ?? 0;
    assert.ok(
      removalStart >= 0 && at > removalStart && at < removalEnd,
      "the only code that may name a link file is RemoveLegacyLinkFile()",
    );
  }
});

test("the published EA is a build that reports its own version and link", () => {
  const published_body = fs.readFileSync(published, "utf8");
  // The version reported to the Desk must be the one the API expects, or the
  // "your EA is out of date" banner would fire on a current terminal.
  assert.equal(
    declaredVersion(published),
    expectedEaVersion(),
    "the published EA's version and the API's EXPECTED_EA_VERSION must agree",
  );
  for (const marker of [
    "instanceId",
    "windowFromMs",
    "rawCount",
    // v3.08: the terminal half of the session-scoped link.
    "RemoveLegacyLinkFile",
    "DisconnectBridge",
    "LinkEndsWithThisRun",
    "pairing_code_spent",
  ]) {
    assert.match(
      published_body,
      new RegExp(marker, "i"),
      `the published EA must carry the ${marker} contract`,
    );
  }
});

/**
 * v3.05 — the position-management contract.
 *
 * The defect this version fixes was a MISSING execution path: the plan carried
 * breakeven, partials, a trail, a time stop and session guards, and the EA
 * implemented none of them after a fill. The only automated protection against
 * that returning is asserting the shipped EA contains the state machine, the
 * persistence, the pending-order path and the set_management command.
 */
test("the published EA carries the v3.05 position-management contract", () => {
  const published_body = fs.readFileSync(published, "utf8");
  for (const marker of [
    "PositionState",
    "PsRestoreAll",
    "ManageOnePosition",
    "ReconcileFilledPositions",
    "OnTradeTransaction",
    "set_management",
    "managementEvents",
    "UsePendingOrders",
    "BuyLimit",
    "SellStop",
    "ReleaseAtrHandles",
  ]) {
    assert.match(
      published_body,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the published EA must carry the v3.05 ${marker} contract`,
    );
  }
  // And the v3.04 defect must be gone: the plan is no longer the lookup path
  // for management.
  assert.doesNotMatch(
    published_body,
    /FindPlanForSymbol\(symbol, plan\)/,
    "management must not be looked up through the armed plan",
  );
});

test("the published EA carries the v3.04 heartbeat-reliability contract", () => {
  const published_body = fs.readFileSync(published, "utf8");
  // The re-seed loop fix and the clock self-correction are only real if the
  // shipped EA actually contains them — the parity test is what stops a stale
  // download from silently reintroducing the stale-desk bug.
  for (const marker of ["barsAvailable", "computerClockSkewMs", "serverTime", "\"history\""]) {
    assert.match(
      published_body,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `the published EA must carry the ${marker} contract`,
    );
  }
});

test("the EA source and the download agree on their version", () => {
  assert.equal(declaredVersion(source), declaredVersion(published));
});
