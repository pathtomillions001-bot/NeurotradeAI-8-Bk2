import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildNexusHedgeStrategy, type NexusHedgeInput } from "./nexus-hedge-dbot";

export const fixturesDir = join(import.meta.dirname, "..", "..", "..", "..", "tmp", "nexus-hedge-fixtures");

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

export function renderFixture(input: NexusHedgeInput) {
  return buildNexusHedgeStrategy(input);
}
