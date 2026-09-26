import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDigit45DbotStrategy, type Digit45DbotInput } from "./digit45-dbot";

export const DIGIT45_DBOT_FIXTURES: Record<string, Digit45DbotInput> = {
  "digit45-r100-usd": {
    symbol: "R_100", displayName: "Volatility 100 Index", stake: 1,
    takeProfit: 10, stopLoss: 30, maxRecoverySteps: 3, markupPercent: 10,
    maxStake: 20, currency: "USD",
  },
  "digit45-1hz50v-eur": {
    symbol: "1HZ50V", displayName: "Volatility 50 (1s) Index", stake: 0.5,
    takeProfit: 12, stopLoss: 25, maxRecoverySteps: 2, markupPercent: 5,
    maxStake: 12, currency: "EUR",
  },
  "digit45-partial-limit": {
    symbol: "R_50", displayName: "Volatility 50 Index", stake: 1,
    takeProfit: 10, stopLoss: 50, maxRecoverySteps: 2, markupPercent: 10,
    maxStake: 2, currency: "USD",
  },
};
export const digit45FixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../../dbot-builder/src/preview/__tests__/fixtures");
export const renderDigit45Fixture = (name: string) =>
  `${buildDigit45DbotStrategy(DIGIT45_DBOT_FIXTURES[name]!).xml}\n`;

if (process.argv.includes("--write")) {
  fs.mkdirSync(digit45FixturesDir, { recursive: true });
  for (const name of Object.keys(DIGIT45_DBOT_FIXTURES)) {
    fs.writeFileSync(path.join(digit45FixturesDir, `${name}.xml`), renderDigit45Fixture(name));
  }
}
