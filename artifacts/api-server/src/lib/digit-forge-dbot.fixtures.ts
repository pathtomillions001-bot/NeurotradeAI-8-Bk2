/**
 * Shared fixtures for the Digit Forge → DBot generator.
 *
 * The XML these produce is committed under
 * `artifacts/dbot-builder/src/preview/__tests__/fixtures/` where the builder's
 * own jest suite loads it into the REAL Deriv Blockly (every vendored block
 * definition) and executes the generated bot code against a scripted market.
 * `digit-forge-dbot.test.ts` asserts the committed files equal the current
 * generator output, so the two packages cannot drift apart silently.
 *
 * Regenerate after changing the generator:
 *   cd artifacts/api-server && npx tsx src/lib/digit-forge-dbot.fixtures.ts --write
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDigitForgeStrategy,
  type DigitForgeInput,
} from "./digit-forge-dbot";

export const DIGIT_FORGE_FIXTURES: Record<string, DigitForgeInput> = {
  /**
   * The default forge: full gate (Agresti–Coull + Markov + streak cooldown),
   * session-sized boundaries so the stop-loss is what ends a losing run.
   */
  "forge-r50-over2-over5": {
    symbol: "R_50",
    displayName: "Volatility 50 Index",
    normal: { side: "DIGITOVER", barrier: 2 },
    recovery: { side: "DIGITOVER", barrier: 5 },
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    normalPayout: 1.4,
    recoveryPayout: 2.43,
    breakerDepth: 6,
    currency: "USD",
    window: 120,
    minSamples: 30,
    confidenceZ: 1.645,
    forceEntryAfter: 0,
    useMarkov: true,
    useStreakCooldown: true,
    watchMarkets: ["R_10", "R_25", "R_50", "R_75"],
  },
  /**
   * Gate wide open (z = 0, no Markov, no cooldown, minimum samples reached at
   * once) and boundaries wide, so the builder suite can drive the trade ladder
   * deterministically and see the circuit breaker fire. This is also the shape
   * that proves the conditional gate clauses are genuinely optional.
   */
  "forge-1hz100v-under7-under4-open": {
    symbol: "1HZ100V",
    displayName: "Volatility 100 (1s) Index",
    normal: { side: "DIGITUNDER", barrier: 7 },
    recovery: { side: "DIGITUNDER", barrier: 4 },
    stake: 0.5,
    takeProfit: 1000,
    stopLoss: 1000,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    normalPayout: 1.4,
    recoveryPayout: 2.43,
    breakerDepth: 5,
    currency: "USD",
    window: 20,
    minSamples: 10,
    confidenceZ: 0,
    forceEntryAfter: 0,
    useMarkov: false,
    useStreakCooldown: false,
  },
  /**
   * Patience limit set: proves the forced-entry escape hatch compiles and that
   * a bot which never qualifies still eventually trades instead of idling.
   */
  "forge-r10-over1-over5-forced": {
    symbol: "R_10",
    displayName: "Volatility 10 Index",
    normal: { side: "DIGITOVER", barrier: 1 },
    recovery: { side: "DIGITOVER", barrier: 5 },
    stake: 1,
    takeProfit: 1000,
    stopLoss: 1000,
    maxRecoverySteps: 2,
    markupPercent: 10,
    maxStake: 500,
    normalPayout: 1.23,
    recoveryPayout: 2.43,
    breakerDepth: 8,
    currency: "USD",
    window: 60,
    minSamples: 10,
    confidenceZ: 1.645,
    forceEntryAfter: 3,
    useMarkov: true,
    useStreakCooldown: true,
  },
};

export function fixturesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    here,
    "../../../dbot-builder/src/preview/__tests__/fixtures",
  );
}

export function renderFixture(name: string): string {
  const input = DIGIT_FORGE_FIXTURES[name];
  if (!input) throw new Error(`Unknown fixture ${name}`);
  return `${buildDigitForgeStrategy(input).xml}\n`;
}

if (process.argv.includes("--write")) {
  const dir = fixturesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(DIGIT_FORGE_FIXTURES)) {
    const file = path.join(dir, `${name}.xml`);
    fs.writeFileSync(file, renderFixture(name));
    console.log(`wrote ${file}`);
  }
}
