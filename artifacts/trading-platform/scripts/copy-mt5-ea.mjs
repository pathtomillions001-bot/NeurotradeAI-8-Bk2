import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webRoot, "../..");
const source = path.join(repoRoot, "artifacts", "mt5-ea", "NeurotradeBridge.mq5");
const destination = path.join(webRoot, "public", "downloads", "NeurotradeBridge.mq5");

if (!fs.existsSync(source)) {
  throw new Error(`MT5 EA source is missing: ${source}`);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
console.log("[mt5-ea] Published NeurotradeBridge.mq5 for Desk download");
