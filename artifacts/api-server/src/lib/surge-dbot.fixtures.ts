import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSurgeDbotStrategy, type SurgeDbotInput } from "./surge-dbot";

export const SURGE_DBOT_FIXTURES: Record<string, SurgeDbotInput> = {
  "surge-r50-adaptive": {
    symbol: "R_50",
    displayName: "Volatility 50 Index",
    watchMarkets: ["R_10", "R_25", "R_75"],
    stake: 1,
    takeProfit: 1000,
    stopLoss: 1000,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    payout: 1.92,
    breakerDepth: 5,
    currency: "USD",
    window: 240,
    weights: [0.3, 0.25, 0.2, 0.25],
    tau: 1,
  },
};

export function surgeFixturesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dbot-builder/src/preview/__tests__/fixtures");
}

export function renderSurgeFixture(name: string): string {
  const input = SURGE_DBOT_FIXTURES[name];
  if (!input) throw new Error(`Unknown fixture ${name}`);
  return `${buildSurgeDbotStrategy(input).xml}\n`;
}

if (process.argv.includes("--write")) {
  fs.mkdirSync(surgeFixturesDir(), { recursive: true });
  for (const name of Object.keys(SURGE_DBOT_FIXTURES)) {
    const file = path.join(surgeFixturesDir(), `${name}.xml`);
    fs.writeFileSync(file, renderSurgeFixture(name));
    console.log(`wrote ${file}`);
  }
}
