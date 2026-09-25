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
