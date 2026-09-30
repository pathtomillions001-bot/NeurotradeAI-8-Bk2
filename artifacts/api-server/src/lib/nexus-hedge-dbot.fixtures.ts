/**
 * Committed Nexus Hedge Forge fixtures — the SAME XML the builder's jest suite
 * loads into the real Blockly workspace.
 *
 * Mirrors the Omni Forge convention (`omni-forge-dbot.fixtures.ts`): regenerate
 * with `npx tsx src/lib/nexus-hedge-dbot.fixtures.ts --write`, and the API-side
 * test asserts the committed files still equal the generator output so the two
 * packages cannot drift apart silently.
 *
 * These files are what caught the missing `nt_purchase_hedge` purchase alias:
 * the builder's Run-button gate rejected every generated Nexus strategy with
 * "The Purchase block is mandatory and cannot be deleted/disabled." because
 * nothing on the builder side had ever loaded one.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildNexusHedgeStrategy, type NexusHedgeInput } from "./nexus-hedge-dbot";

const BASE: NexusHedgeInput = {
  symbol: "R_50",
  displayName: "Volatility 50 Index",
  normal: [
    { type: "DIGITOVER", digit: 1 },
    { type: "DIGITEVEN", digit: -1 },
  ],
  recovery: [
    { type: "DIGITUNDER", digit: 6 },
    { type: "CALL", digit: -1 },
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
  watchMarkets: ["R_10", "R_25"],
};

export const NEXUS_HEDGE_FIXTURES: Array<{ name: string; input: NexusHedgeInput }> = [
  { name: "mixed-digit-and-rise", input: BASE },
  {
    name: "overunder-only",
    input: {
      ...BASE,
      normal: [{ type: "DIGITOVER", digit: 2 }, { type: "DIGITUNDER", digit: 7 }],
      recovery: [{ type: "DIGITOVER", digit: 4 }, { type: "DIGITUNDER", digit: 5 }],
    },
  },
  {
    name: "parity-hedge",
    input: {
      ...BASE,
      normal: [{ type: "DIGITEVEN", digit: -1 }],
      recovery: [{ type: "DIGITODD", digit: -1 }],
    },
  },
  {
    name: "matches-auto-recovery",
    input: {
      ...BASE,
      normal: [{ type: "DIGITMATCH", digit: -1 }],
      recovery: [{ type: "DIGITDIFF", digit: -1 }],
    },
  },
];

/** Committed file name for a fixture ("nexus-hedge-<name>.xml"). */
export function fixtureFileName(name: string): string {
  return `nexus-hedge-${name}.xml`;
}

export function renderFixture(input: NexusHedgeInput) {
  return buildNexusHedgeStrategy(input);
}

/** Exactly what lands on disk for `name` — trailing newline included. */
export function fixtureXml(name: string): string {
  const fixture = NEXUS_HEDGE_FIXTURES.find(f => f.name === name);
  if (!fixture) throw new Error(`Unknown fixture ${name}`);
  return `${buildNexusHedgeStrategy(fixture.input).xml}\n`;
}

/** The builder's committed fixture directory (same target Omni Forge writes to). */
export function fixturesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../dbot-builder/src/preview/__tests__/fixtures");
}

if (process.argv.includes("--write")) {
  const dir = fixturesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const fixture of NEXUS_HEDGE_FIXTURES) {
    const file = path.join(dir, fixtureFileName(fixture.name));
    fs.writeFileSync(file, fixtureXml(fixture.name));
    console.log(`wrote ${file}`);
  }
}
