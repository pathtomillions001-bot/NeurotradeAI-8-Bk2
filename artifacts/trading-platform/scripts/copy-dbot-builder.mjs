import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const builderOutput = path.resolve(repoRoot, "artifacts/dbot-builder/out/preview");
const webOutput = path.resolve(webRoot, "dist/public/bot/preview");

if (!fs.existsSync(builderOutput)) {
  throw new Error(`Deriv bot builder output not found at ${builderOutput}. Run scripts/build-dbot-builder.mjs first.`);
}

fs.rmSync(webOutput, { recursive: true, force: true });
fs.mkdirSync(path.dirname(webOutput), { recursive: true });
fs.cpSync(builderOutput, webOutput, { recursive: true });
console.log(`[web] Copied Deriv bot builder → ${webOutput}`);
