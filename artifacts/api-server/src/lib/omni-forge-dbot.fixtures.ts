/**
 * Shared fixtures for the Omni Forge → DBot generator.
 *
 * The XML these produce is committed under
 * `artifacts/dbot-builder/src/preview/__tests__/fixtures/` where the builder's
 * own jest suite loads it into the REAL Deriv Blockly (every vendored block
 * definition) and executes the generated bot code against a scripted market.
 * `omni-forge-dbot.test.ts` asserts the committed files equal the current
 * generator output, so the two packages cannot drift apart silently.
 *
 * Regenerate after changing the generator:
 *   cd artifacts/api-server && npx tsx src/lib/omni-forge-dbot.fixtures.ts --write
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOmniForgeStrategy, type OmniForgeInput } from "./omni-forge-dbot";

export const OMNI_FORGE_FIXTURES: Record<string, OmniForgeInput> = {
  /**
   * The user's own example: Over 1 + Under 8 in normal trades, Even + Over 4
   * in recovery. Mixed categories in BOTH sets — the shape Digit Forge cannot
   * express and the whole reason Omni Forge exists.
   */
  "omni-forge-r50-mixed": {
    symbol: "R_50",
    displayName: "Volatility 50 Index",
    normal: [
      { type: "DIGITOVER", digit: 1 },
      { type: "DIGITUNDER", digit: 8 },
    ],
    recovery: [
      { type: "DIGITEVEN", digit: -1 },
      { type: "DIGITOVER", digit: 4 },
    ],
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    breakerDepth: 6,
    currency: "USD",
    window: 120,
    forceEntryAfter: 0,
    watchMarkets: ["R_10", "R_25", "R_50", "R_75"],
  },
  /**
   * Parity recovery on a 1s market: Under 7 normal, Even-only recovery. The
   * builder suite drives the shared recovery ladder through this shape and
   * proves an Even purchase carries NO digit while Under carries its barrier.
   * Boundaries wide so the scripted market controls the run. The window: 20
   * below deliberately exercises the generator's floor — the normal gate
   * needs 30 samples, so the committed XML carries 30 and a warning.
   */
  "omni-forge-1hz100v-under7-even": {
    symbol: "1HZ100V",
    displayName: "Volatility 100 (1s) Index",
    normal: [{ type: "DIGITUNDER", digit: 7 }],
    recovery: [{ type: "DIGITEVEN", digit: -1 }],
    stake: 0.5,
    takeProfit: 1000,
    stopLoss: 1000,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    breakerDepth: 5,
    currency: "USD",
    window: 20,
    forceEntryAfter: 0,
  },
  /**
   * Matches/Differs with auto digits plus a patience limit: proves the
   * matchesdiffers trade definition compiles, the auto-digit (−1) wire format
   * round-trips, and a bot that never qualifies still eventually trades.
   */
  "omni-forge-r10-matchdiff-forced": {
    symbol: "R_10",
    displayName: "Volatility 10 Index",
    normal: [{ type: "DIGITDIFF", digit: -1 }],
    recovery: [
      { type: "DIGITMATCH", digit: -1 },
      { type: "DIGITODD", digit: -1 },
    ],
    stake: 1,
    takeProfit: 1000,
    stopLoss: 1000,
    maxRecoverySteps: 2,
    markupPercent: 10,
    maxStake: 500,
    breakerDepth: 8,
    currency: "USD",
    window: 60,
    forceEntryAfter: 3,
  },
};

export function fixturesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../dbot-builder/src/preview/__tests__/fixtures");
}

export function renderFixture(name: string): string {
  const input = OMNI_FORGE_FIXTURES[name];
  if (!input) throw new Error(`Unknown fixture ${name}`);
  return `${buildOmniForgeStrategy(input).xml}\n`;
}

if (process.argv.includes("--write")) {
  const dir = fixturesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(OMNI_FORGE_FIXTURES)) {
    const file = path.join(dir, `${name}.xml`);
    fs.writeFileSync(file, renderFixture(name));
    console.log(`wrote ${file}`);
  }
}
