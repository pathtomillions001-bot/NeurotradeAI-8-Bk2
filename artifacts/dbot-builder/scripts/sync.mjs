/**
 * Syncs the vendored builder's production bundle (vendor/binary-bot/www) into
 * the web app's public dir so it is served at /dbot in BOTH dev (vite
 * publicDir) and production (serve-handler over dist/public).
 *
 * Skips gracefully with a loud warning when the fork has not been built yet —
 * run `pnpm --filter @workspace/dbot-builder build` once before the web build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const src = path.join(repoRoot, "vendor/binary-bot/www");
const dest = path.join(repoRoot, "artifacts/trading-platform/public/dbot");

if (!fs.existsSync(path.join(src, "index.html"))) {
  console.warn(
    "[dbot-builder] vendor/binary-bot/www not built — skipping sync.\n" +
      "  Build it once with: cd vendor/binary-bot && npm install --legacy-peer-deps && npm run build",
  );
  process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

// Sourcemaps only bloat deployments; drop them if a rebuild reintroduced them.
let dropped = 0;
for (const f of walk(dest)) {
  if (f.endsWith(".map")) {
    fs.rmSync(f, { force: true });
    dropped += 1;
  }
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const bytes = [...walk(dest)].reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(
  `[dbot-builder] synced ${(bytes / 1024 / 1024).toFixed(1)} MiB → artifacts/trading-platform/public/dbot` +
    (dropped ? ` (dropped ${dropped} sourcemaps)` : ""),
);
