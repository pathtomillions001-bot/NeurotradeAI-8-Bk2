/**
 * Canonical content hash of everything that compiles INTO the served Deriv
 * bot-builder bundle and decides how a generated strategy EXECUTES:
 *
 *   - artifacts/dbot-builder/src/external/bot-skeleton/** — the vendored
 *     runtime: the generated-code preamble (BinaryBotPrivateTickAnalysis, the
 *     `.epoch` tick guard), every Blockly block generator, the trade engine,
 *     the ticks service and the js-interpreter wiring.
 *   - artifacts/dbot-builder/src/preview/** — NeuroTrade's own bridge code
 *     (strategy-bridge, session-bridge, preview branding).
 *
 * WHY A CONTENT HASH AND NOT JUST THE GIT SHA
 * ───────────────────────────────────────────
 * The builder bundle is a PREBUILT, gitignored artifact
 * (`artifacts/dbot-builder/out/`). Dev serves it whenever it exists and
 * nothing used to rebuild it when the sources above changed. Worse, working
 * trees get edited without commits (agent sessions), so a git SHA cannot
 * prove a bundle matches its sources — hashing the tree can.
 *
 * This is the builder-bundle twin of the web-vs-API release stamp
 * (vite.config.ts releaseManifest + /api/healthz): a stale bundle used to run
 * old epoch handling against new forge XML and die on Run with a cryptic
 * interpreter error nobody could trace to staleness.
 *
 * Used by:
 *   - scripts/build-dbot-builder.mjs   → stamps out/preview/neurotrade-builder.json
 *   - vite.config.ts (botPreviewDevServe) → boot-time parity check +
 *     /bot/preview/__parity verdict for the Bot Arena's stale-bundle panel
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..", "..");
const builderRoot = path.resolve(repoRoot, "artifacts", "dbot-builder");

export const BUILDER_STAMP_FILE = "neurotrade-builder.json";

/** Directories that never affect the served bundle's behaviour. */
const SKIP_DIRS = new Set(["__tests__", "__mocks__", "node_modules", "out", "coverage"]);

const HASHED_ROOTS = [
  path.join(builderRoot, "src", "external", "bot-skeleton"),
  path.join(builderRoot, "src", "preview"),
];

const HASHED_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|xml|json|scss|css)$/;

function listSourceFiles() {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (HASHED_EXTENSIONS.test(entry.name)) files.push(full);
    }
  };
  for (const root of HASHED_ROOTS) walk(root);
  return files.sort();
}

/**
 * Deterministic sha256 of the hashed roots, rendered as 16 hex chars.
 * Paths are relative to the repo root and normalised to `/` so the hash is
 * stable across operating systems. Returns `null` when the sources are absent
 * (e.g. a web-only checkout) so callers can degrade instead of guessing.
 */
export function hashBuilderSources() {
  const files = listSourceFiles();
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(repoRoot, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return { hash: hash.digest("hex").slice(0, 16), files: files.length };
}

/** Absolute path of the stamp inside a built builder output directory. */
export function builderStampPath(outputDir) {
  return path.join(outputDir, BUILDER_STAMP_FILE);
}

/** Read the stamp a build wrote; `null` when the bundle predates stamping. */
export function readBuilderStamp(outputDir) {
  try {
    return JSON.parse(fs.readFileSync(builderStampPath(outputDir), "utf8"));
  } catch {
    return null;
  }
}
