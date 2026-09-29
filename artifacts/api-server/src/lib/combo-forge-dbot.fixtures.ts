/**
 * Shared fixtures for the Combo Forge → DBot generator.
 *
 * The XML these produce is committed under
 * `artifacts/dbot-builder/src/preview/__tests__/fixtures/` where the builder's
 * jest suite loads it into the REAL Deriv Blockly and runs the generated bot
 * code against scripted markets. `combo-forge-dbot.test.ts` asserts the
 * committed files equal the current generator output so the two packages
 * cannot drift apart silently.
 *
 * Regenerate after changing the generator:
 *   cd artifacts/api-server && npx tsx src/lib/combo-forge-dbot.fixtures.ts --write
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildComboForgeStrategy, type ComboForgeInput } from "./combo-forge-dbot";

export const COMBO_FORGE_FIXTURES: Record<string, ComboForgeInput> = {
  /** Digits + Rise/Fall in BOTH sets, several markets, strict, default patience. */
  "combo-forge-r50-mixed": {
    symbol: "R_50",
    displayName: "Volatility 50 Index",
    normal: [
      { type: "DIGITOVER", digit: 1 },
      { type: "DIGITUNDER", digit: 8 },
      { type: "CALL", digit: -1 },
    ],
    recovery: [
      { type: "DIGITEVEN", digit: -1 },
      { type: "DIGITOVER", digit: 4 },
      { type: "PUT", digit: -1 },
    ],
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    breakerDepth: 6,
    currency: "USD",
    window: 500,
    strictness: "strict",
    watchMarkets: ["R_10", "R_25", "R_50", "R_75"],
  },
  /**
   * Pure Rise/Fall (callput trade definition). Boundaries wide so the scripted
   * market controls the run; a short window exercises the 60-tick floor.
   */
  "combo-forge-1hz100v-rise-fall": {
    symbol: "1HZ100V",
    displayName: "Volatility 100 (1s) Index",
    normal: [
      { type: "CALL", digit: -1 },
      { type: "PUT", digit: -1 },
    ],
    recovery: [{ type: "PUT", digit: -1 }],
    stake: 0.5,
    takeProfit: 1000,
    stopLoss: 1000,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    breakerDepth: 5,
    currency: "USD",
    window: 40,
    strictness: "strict",
    recoveryPatience: 0,
  },
  /**
   * Always mode + Matches/Differs auto digits + tight patience limits: proves
   * the matchesdiffers definition compiles, the auto-digit (−1) wire format
   * round-trips, and a bot that never qualifies still trades (and recovers).
   */
  "combo-forge-r10-always-forced": {
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
    window: 100,
    strictness: "always",
    normalPatience: 3,
    recoveryPatience: 2,
  },
};

export function fixturesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../dbot-builder/src/preview/__tests__/fixtures");
}

export function renderFixture(name: string): string {
  const input = COMBO_FORGE_FIXTURES[name];
  if (!input) throw new Error(`Unknown fixture ${name}`);
  return `${buildComboForgeStrategy(input).xml}\n`;
}

if (process.argv.includes("--write")) {
  const dir = fixturesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(COMBO_FORGE_FIXTURES)) {
    const file = path.join(dir, `${name}.xml`);
    fs.writeFileSync(file, renderFixture(name));
    console.log(`wrote ${file}`);
  }
}
