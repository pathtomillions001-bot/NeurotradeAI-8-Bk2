#!/usr/bin/env node
/**
 * Is the deployed web service actually serving THIS build?
 *
 * Written after the 2026-09-19 incident: production was running the web bundle
 * from commit 39300a9 (2026-09-14) while the API was already on 1d7b39f
 * (2026-09-19). The stale bundle had no Match Pulse console, no Compounding
 * Range Sentinel console and the superseded Twin-Hedge console, so those three
 * bots "looked different" from the sandbox with no error anywhere.
 *
 * Two independent checks, both cheap:
 *   1. `/__release` (the deployed server's own report + API parity)
 *   2. the hashed asset filename in the deployed index.html vs the local
 *      `dist/public/assets` build — Vite hashes asset CONTENT, so a different
 *      name means a different build, full stop.
 *
 * Usage:
 *   node scripts/check-deployed-release.mjs https://neuro-trade.site
 *   pnpm --filter @workspace/trading-platform run check:release https://neuro-trade.site
 *
 * Exit code 1 when the deployed build differs from the local build or when the
 * web/API console contracts disagree — safe to wire into a post-deploy check.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!target) {
  console.error("usage: node scripts/check-deployed-release.mjs <https://your-web-service>");
  process.exit(2);
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.resolve(packageRoot, "dist/public");

function localAssets() {
  try {
    return fs.readdirSync(path.join(publicDir, "assets")).sort();
  } catch {
    return null;
  }
}

async function get(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

const problems = [];

// ── 1. /__release ────────────────────────────────────────────────────────────
let release = null;
try {
  const response = await get(`${target}/__release`);
  const looksLikeJson = (response.headers.get("content-type") ?? "").includes("json");
  if (response.status === 200 && looksLikeJson) {
    release = JSON.parse(response.text);
    console.log(`GET ${target}/__release → ${release.parity}`);
    console.log(`  web : ${release.web?.shortSha} (${release.web?.environment}) built ${release.web?.builtAt}`);
    console.log(`  api : ${release.api?.shortSha ?? "unknown"}`);
    if (release.missingConsolesHere?.length) {
      problems.push(`deployed web build cannot render: ${release.missingConsolesHere.join(", ")}`);
    }
    if (release.apiError) problems.push(`API unreachable from the web service: ${release.apiError}`);
    if (release.parity !== "ok") problems.push(release.hint ?? "web/API console contracts differ");
  } else {
    // An older bundle has no /__release route; the SPA fallback answers with
    // index.html, which is itself proof that the deployed build predates the
    // handshake.
    problems.push(
      `${target}/__release did not return JSON (HTTP ${response.status}) — the deployed web build predates the release handshake`,
    );
  }
} catch (error) {
  problems.push(`could not read ${target}/__release: ${error instanceof Error ? error.message : error}`);
}

// ── 2. asset fingerprint ─────────────────────────────────────────────────────
const local = localAssets();
try {
  const home = await get(`${target}/`);
  const deployed = [...home.text.matchAll(/\/assets\/([A-Za-z0-9._-]+\.(?:js|css))/g)]
    .map(match => match[1])
    .sort();

  if (local === null) {
    console.log("(no local build found — run `pnpm --filter @workspace/trading-platform build` to compare assets)");
  } else if (deployed.length === 0) {
    problems.push("deployed index.html references no hashed assets — is the SPA built?");
  } else {
    const missingLocally = deployed.filter(name => !local.includes(name));
    const missingDeployed = local.filter(name => !deployed.includes(name));
    console.log(`deployed assets: ${deployed.join(", ")}`);
    console.log(`local assets   : ${local.join(", ")}`);
    if (missingLocally.length || missingDeployed.length) {
      problems.push(
        "deployed bundle is a DIFFERENT build than this checkout — " +
          `not local: [${missingLocally.join(", ")}] · not deployed: [${missingDeployed.join(", ")}]`,
      );
    } else {
      console.log("deployed bundle matches this checkout.");
    }
  }
} catch (error) {
  problems.push(`could not read ${target}/: ${error instanceof Error ? error.message : error}`);
}

if (problems.length) {
  console.error("\nRELEASE SKEW DETECTED");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log("\nweb and api are on the same release.");
