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
  // Deep tape by default: a one-minute pair over a 500-tick window yields eight
  // non-overlapping samples and can never clear the 20-sample hard floor.
  analysisWindow: 4999,
  minSamples: 80,
  // 0 = break-even. The runtime enforces this hurdle now, so a fixture carrying
  // the old 0.01 would pin a gate no generated bot actually ships with.
  requiredEdge: 0,
  recoveryMultiplier: 2.43,
  maxRecoverySteps: 3,
  markupPercent: 40,
  maxStake: 500,
  takeProfit: 10,
  stopLoss: 5,
  maxConsecutiveDoubleLosses: 6,
  watchMarkets: "",
  forceEntryAfter: 0,
  currency: "USD",
};

/**
 * The console's real defaults for a pipSize-4 index: one pip = 10^-4 = 0.0001.
 * The Builder's offset field used to declare `precision 0.01`, and Blockly rounds
 * every value — including one restored from XML — to that precision, so 0.0001
 * became 0, `normalizePairConfig` threw, and all five price-barrier families held
 * forever. This fixture is the regression guard: it is loaded into the real
 * vendored Blockly by `hedge-pair-strategy.spec.js`, which asserts the field
 * still reads 0.0001 after the round trip.
 */
const ONE_PIP_R50 = { upperOffset: 0.0001, lowerOffset: 0.0001 };

export const HEDGE_PAIR_FIXTURES: Record<string, HedgePairInput> = {
  "hedge-pair-overunder-r50": { ...BASE, family: "DIGIT_OVERUNDER" },
  "hedge-pair-only-ups-downs-r50": { ...BASE, family: "ONLY_UPS_DOWNS" },
  "hedge-pair-higher-lower-r50": { ...BASE, family: "HIGHER_LOWER" },
  "hedge-pair-touch-upper-lower-r50": { ...BASE, family: "TOUCH_UPPER_LOWER" },
  "hedge-pair-no-touch-upper-lower-r50": { ...BASE, family: "NO_TOUCH_UPPER_LOWER" },
  "hedge-pair-ends-between-outside-r50": { ...BASE, family: "ENDS_BETWEEN_OUTSIDE" },
  "hedge-pair-stays-between-outside-r50": { ...BASE, family: "STAYS_BETWEEN_OUTSIDE" },
  "hedge-pair-higher-lower-r50-one-pip": { ...BASE, ...ONE_PIP_R50, family: "HIGHER_LOWER" },
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
