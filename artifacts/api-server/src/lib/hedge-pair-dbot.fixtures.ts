/**
 * Committed end-to-end fixtures for the Hedge Pair Forge generator.
 *
 * The Builder Jest suite loads these XML workspaces into the vendored Blockly,
 * checks the mandatory purchase/run gate, and executes their custom block code.
 * Keep these inputs in sync through `hedge-pair-dbot.test.ts`.
 *
 * Regenerate with:
 *   cd artifacts/api-server && npx tsx src/lib/hedge-pair-dbot.fixtures.ts --write
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHedgePairStrategy, type HedgePairInput } from "./hedge-pair-dbot";

const BASE: Omit<HedgePairInput, "family"> = {
  symbol: "R_50",
  displayName: "Volatility 50 Index",
  stake: 1,
  requestedDuration: 1,
  upperOffset: 1,
  lowerOffset: 1,
  analysisWindow: 500,
  minSamples: 80,
  requiredEdge: 0.01,
  recoveryMultiplier: 1.62,
  maxRecoverySteps: 3,
  markupPercent: 10,
  maxStake: 500,
  takeProfit: 10,
  stopLoss: 5,
  maxConsecutiveDoubleLosses: 6,
  currency: "USD",
};

export const HEDGE_PAIR_FIXTURES: Record<string, HedgePairInput> = {
  "hedge-pair-overunder-r50": { ...BASE, family: "DIGIT_OVERUNDER" },
  "hedge-pair-only-ups-downs-r50": { ...BASE, family: "ONLY_UPS_DOWNS" },
  "hedge-pair-higher-lower-r50": { ...BASE, family: "HIGHER_LOWER" },
  "hedge-pair-touch-upper-lower-r50": { ...BASE, family: "TOUCH_UPPER_LOWER" },
  "hedge-pair-no-touch-upper-lower-r50": { ...BASE, family: "NO_TOUCH_UPPER_LOWER" },
  "hedge-pair-ends-between-outside-r50": { ...BASE, family: "ENDS_BETWEEN_OUTSIDE" },
  "hedge-pair-stays-between-outside-r50": { ...BASE, family: "STAYS_BETWEEN_OUTSIDE" },
};

export function fixturesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../dbot-builder/src/preview/__tests__/fixtures");
}

export function renderFixture(name: string): string {
  const input = HEDGE_PAIR_FIXTURES[name];
  if (!input) throw new Error(`Unknown fixture ${name}`);
  return `${buildHedgePairStrategy(input).xml}\n`;
}

if (process.argv.includes("--write")) {
  const dir = fixturesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(HEDGE_PAIR_FIXTURES)) {
    const file = path.join(dir, `${name}.xml`);
    fs.writeFileSync(file, renderFixture(name));
    console.log(`wrote ${file}`);
  }
}
