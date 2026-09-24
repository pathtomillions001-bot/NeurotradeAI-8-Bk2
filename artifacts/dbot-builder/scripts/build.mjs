/**
 * Full build of the vendored Deriv bot builder fork.
 *
 * Idempotent: skips the (slow) webpack build when an up-to-date bundle is
 * already present, so `pnpm build` at the repo root stays fast on repeat runs
 * and on platforms (Railway) where node_modules of the fork isn't cached the
 * install + build runs once.
 *
 * Env:
 *   DBOT_FORCE_BUILD=1   rebuild even if a bundle exists
 *   NODE_EXTRA_CA_CERTS  honoured automatically (sandboxed registries)
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fork = path.resolve(here, "../../../vendor/binary-bot");
const want = path.join(fork, "www/index.html");

const force = process.env.DBOT_FORCE_BUILD === "1";
if (!force && fs.existsSync(want)) {
  console.log("[dbot-builder] fork bundle already built — skipping (DBOT_FORCE_BUILD=1 to rebuild)");
} else {
  if (!fs.existsSync(path.join(fork, "node_modules"))) {
    console.log("[dbot-builder] installing fork dependencies (npm, isolated from pnpm workspace)…");
    execSync("npm install --legacy-peer-deps --no-audit --no-fund", {
      cwd: fork,
      stdio: "inherit",
      env: { ...process.env },
    });
  }
  console.log("[dbot-builder] webpack production build…");
  execSync("npm run build", { cwd: fork, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
}

// Always finish with a sync so /dbot is fresh.
execSync("node ./scripts/sync.mjs", { cwd: path.resolve(here, ".."), stdio: "inherit" });
