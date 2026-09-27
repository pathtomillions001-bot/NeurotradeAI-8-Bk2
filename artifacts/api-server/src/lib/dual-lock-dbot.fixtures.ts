/**
 * Shared fixtures for the Dual-Lock Range Sentinel → DBot generator.
 *
 * The XML these produce is committed under
 * `artifacts/dbot-builder/src/preview/__tests__/fixtures/` where the builder's
 * own jest suite loads it into the REAL Deriv Blockly (every vendored block
 * definition), proves the run-button gate accepts it, and executes the generated
 * bot code against a scripted market. `dual-lock-dbot.test.ts` asserts the
 * committed files equal the current generator output, so the two packages cannot
 * drift apart silently.
 *
 * Regenerate after changing the generator:
 *   cd artifacts/api-server && npx tsx src/lib/dual-lock-dbot.fixtures.ts --write
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDualLockDbotStrategy, type DualLockDbotInput } from "./dual-lock-dbot";

export const DUAL_LOCK_DBOT_FIXTURES: Record<string, DualLockDbotInput> = {
  /** Session-sized boundaries: stop-loss is what ends a losing run. */
  "duallock-r100-over2-over4": {
    symbol: "R_100",
    displayName: "Volatility 100 Index",
    normal: { side: "DIGITOVER", barrier: 2 },
    recovery: { side: "DIGITOVER", barrier: 4 },
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    normalPayout: 1.4,
    recoveryPayout: 1.95,
    breakerDepth: 6,
    currency: "USD",
  },
  /** Wide boundaries so the circuit breaker is the halt that fires (Under lock). */
  "duallock-1hz100v-under7-under5-wide": {
    symbol: "1HZ100V",
    displayName: "Volatility 100 (1s) Index",
    normal: { side: "DIGITUNDER", barrier: 7 },
    recovery: { side: "DIGITUNDER", barrier: 5 },
    stake: 0.5,
    takeProfit: 1000,
    stopLoss: 1000,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    normalPayout: 1.4,
    recoveryPayout: 1.95,
    breakerDepth: 5,
    currency: "USD",
  },
};

export function fixturesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../dbot-builder/src/preview/__tests__/fixtures");
}

export function renderFixture(name: string): string {
  const input = DUAL_LOCK_DBOT_FIXTURES[name];
  if (!input) throw new Error(`Unknown fixture ${name}`);
  return `${buildDualLockDbotStrategy(input).xml}\n`;
}

if (process.argv.includes("--write")) {
  const dir = fixturesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(DUAL_LOCK_DBOT_FIXTURES)) {
    const file = path.join(dir, `${name}.xml`);
    fs.writeFileSync(file, renderFixture(name));
    console.log(`wrote ${file}`);
  }
}
