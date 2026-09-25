import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const builderRoot = path.resolve(repoRoot, "artifacts/dbot-builder");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: builderRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    const rendered = [command, ...args].join(" ");
    throw new Error(`${rendered} failed with exit code ${result.status}`);
  }
}

if (!fs.existsSync(path.join(builderRoot, "package.json"))) {
  throw new Error(`Deriv bot builder source not found at ${builderRoot}`);
}

if (!fs.existsSync(path.join(builderRoot, "node_modules"))) {
  run("npm", ["ci", "--no-audit", "--no-fund"]);
}

const env = {
  ...process.env,
  NEXT_PUBLIC_APP_BUILD: "true",
  NEXT_PUBLIC_DERIV_APP_NAME: process.env.NEXT_PUBLIC_DERIV_APP_NAME ?? "NeuroTrade",
  NEXT_PUBLIC_DERIV_ENV: process.env.NEXT_PUBLIC_DERIV_ENV ?? "production",
  // The builder itself expects NEXT_PUBLIC_DERIV_APP_ID. NeuroTrade deployments
  // already commonly expose DERIV_APP_ID for Deriv integration, so mirror it for
  // the standalone builder build without changing the builder source.
  NEXT_PUBLIC_DERIV_APP_ID: process.env.NEXT_PUBLIC_DERIV_APP_ID ?? process.env.DERIV_APP_ID ?? "",
};

run("npm", ["run", "build"], { env });

// ── Strip remote @import rules from the built stylesheets ────────────────────
// Vendored Deriv CSS (@deriv-com/ui, quill) begins every chunk stylesheet with
// `@import "https://fonts.googleapis.com/..."`. When that request fails — slow
// network, blocked host, captive portal — the <link> injected for a LAZY CSS
// chunk fires an `error` event even though the local styles themselves parsed.
// The chunk loader then rejects, React Router's error boundary takes the app
// down ("Sorry for the interruption") and any running bot dies with it — right
// after the first trade, when the run-panel UI lazy-loads its chunks.
//
// Removing the remote imports makes every stylesheet fully local: fonts keep
// loading through the resilient <link> path (src/utils/load-web-font.ts), with
// the brand font stack as fallback, and no network request can ever fail a
// chunk load again.
function stripRemoteCssImports(dir) {
  const cssFiles = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".css")) cssFiles.push(p);
    }
  };
  walk(dir);

  let stripped = 0;
  for (const file of cssFiles) {
    const source = fs.readFileSync(file, "utf8");
    const cleaned = source
      .replace(/@import\s+url\(\s*["']?https?:[^)]*?\)\s*;?/g, "")
      .replace(/@import\s+["']https?:[^"']*["']\s*;?/g, "");
    if (cleaned !== source) {
      fs.writeFileSync(file, cleaned);
      stripped += 1;
    }
  }
  console.log(
    `[dbot-builder] Stripped remote @import rules from ${stripped}/${cssFiles.length} stylesheets`,
  );
}

stripRemoteCssImports(path.join(builderRoot, "out", "preview"));
