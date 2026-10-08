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

test("the downloadable EA is byte-identical to the EA source", () => {
  assert.ok(fs.existsSync(source), `EA source missing: ${source}`);
  assert.ok(fs.existsSync(published), `published EA missing: ${published}`);
  assert.equal(
    fs.readFileSync(published, "utf8"),
    fs.readFileSync(source, "utf8"),
    "public/downloads/NeurotradeBridge.mq5 is stale — run `node scripts/copy-mt5-ea.mjs`",
  );
});

test("the published EA is a build that reports its own version and link", () => {
  const published_body = fs.readFileSync(published, "utf8");
  // The version reported to the Desk must be the one the API expects, or the
  // "your EA is out of date" banner would fire on a current terminal.
  assert.equal(declaredVersion(published), "3.03");
  for (const marker of ["instanceId", "windowFromMs", "rawCount", "durable"]) {
    assert.match(
      published_body,
      new RegExp(marker, "i"),
      `the published EA must carry the ${marker} contract`,
    );
  }
});

test("the EA source and the download agree on their version", () => {
  assert.equal(declaredVersion(source), declaredVersion(published));
});
