/**
 * Last-digit accuracy for the 3-decimal (1s) Volatility indices.
 *
 * User-reported regression: Volatility 15/30/90 (1s) Index quotes carry THREE
 * decimal places on Deriv (e.g. 13222.146 / 6527.120 / 18528.175) but were
 * treated as 2-dp markets. Rounding the quote to 2 dp silently corrupts the
 * last digit that feeds the whole digit-analysis pipeline:
 *
 *   13222.146 → rounded to 13222.15 → last digit 5 (correct: 6)
 *   6527.120  → rounded to 6527.12  → last digit 0 kept by luck, but the
 *                                     displayed price loses the 3rd decimal
 *   18528.175 → rounded to 18528.18 → last digit 8 (correct: 5)
 *
 * These tests pin the exact reported quotes so a pipSize regression can never
 * ship silently again.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTOMATED_DERIV_MARKETS,
  DERIV_MARKETS,
  extractLastDigit,
  getMarketInfo,
} from "./deriv.ts";

const THREE_DP_1S_MARKETS = ["1HZ15V", "1HZ30V", "1HZ90V"] as const;

/** Live-quote examples reported from the Deriv platform, per market. */
const REPORTED_QUOTES: Record<string, { quote: number; expectedDigit: number }[]> = {
  "1HZ15V": [
    { quote: 13222.146, expectedDigit: 6 },
    { quote: 13222.145, expectedDigit: 5 },
    { quote: 13222.15, expectedDigit: 0 }, // = 13222.150 — trailing zero is a real digit
    { quote: 13222.148, expectedDigit: 8 },
  ],
  "1HZ30V": [
    { quote: 6527.12, expectedDigit: 0 }, // 6527.120 — trailing zero is a real digit
    { quote: 6527.121, expectedDigit: 1 },
    { quote: 6527.129, expectedDigit: 9 },
  ],
  "1HZ90V": [
    { quote: 18528.175, expectedDigit: 5 },
    { quote: 18528.174, expectedDigit: 4 },
    { quote: 18528.179, expectedDigit: 9 },
  ],
};

describe("pipSize declarations for 1s volatility indices", () => {
  it("declares pipSize 3 and digitEnabled for Volatility 15/30/90 (1s)", () => {
    for (const symbol of THREE_DP_1S_MARKETS) {
      const market = getMarketInfo(symbol);
      assert.ok(market, `${symbol} must exist in DERIV_MARKETS`);
      assert.equal(market.pipSize, 3, `${symbol} must use 3 decimal places`);
      assert.equal(market.digitEnabled, true, `${symbol} must feed digit analysis`);
      assert.equal(isAutomatedEligible(symbol), true, `${symbol} must be automated-eligible`);
    }
  });

  it("keeps every other market's pip size unchanged", () => {
    const expected: Record<string, number> = {
      R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
      "1HZ10V": 2, "1HZ25V": 2, "1HZ50V": 2, "1HZ75V": 2, "1HZ100V": 2,
      RDBULL: 4, RDBEAR: 4,
      JD10: 2, JD25: 2, JD50: 2, JD75: 2, JD100: 2,
    };
    for (const [symbol, pipSize] of Object.entries(expected)) {
      assert.equal(getMarketInfo(symbol)?.pipSize, pipSize, `${symbol} pipSize`);
    }
  });

  it("keeps the full catalog and automated universe intact", () => {
    assert.equal(DERIV_MARKETS.length, 20);
    assert.equal(AUTOMATED_DERIV_MARKETS.length, 19);
  });
});

describe("extractLastDigit on live 3-dp quotes", () => {
  for (const [symbol, cases] of Object.entries(REPORTED_QUOTES)) {
    it(`extracts the true last digit for ${symbol} quotes`, () => {
      const market = getMarketInfo(symbol);
      assert.ok(market);
      for (const { quote, expectedDigit } of cases) {
        assert.equal(
          extractLastDigit(quote, market.pipSize),
          expectedDigit,
          `${symbol} quote ${quote} must end in digit ${expectedDigit}`,
        );
      }
    });
  }

  it("never collapses 3-dp quotes onto the 2-dp grid (old buggy behaviour)", () => {
    // With the OLD wrong pipSize=2, 13222.146 became digit 5 instead of 6.
    const market = getMarketInfo("1HZ15V")!;
    assert.notEqual(extractLastDigit(13222.146, market.pipSize), extractLastDigit(13222.146, 2));
    assert.equal(extractLastDigit(13222.146, market.pipSize), 6);
  });

  it("survives floating-point drift on 3-dp quotes", () => {
    // IEEE-754: 18528.175 * 1000 → 18528174.999999996 — must still round to …175 → 5
    assert.equal(extractLastDigit(18528.175, 3), 5);
    // 6527.12 * 1000 → 6527119.999999999 — must still round to …120 → 0
    assert.equal(extractLastDigit(6527.12, 3), 0);
  });

  it("produces all ten digits across a 3-dp tick walk (no digit collapse)", () => {
    for (const symbol of THREE_DP_1S_MARKETS) {
      const market = getMarketInfo(symbol)!;
      const seen = new Set<number>();
      for (let k = 0; k < 1000; k++) {
        seen.add(extractLastDigit(1000 + k / 1000, market.pipSize));
      }
      assert.equal(seen.size, 10, `${symbol} must be able to produce digits 0-9`);
    }
  });

  it("leaves 2-dp markets untouched", () => {
    assert.equal(extractLastDigit(830197.73, 2), 3); // 1HZ25V-style quote
    assert.equal(extractLastDigit(1800.01, 2), 1); // R_100-style quote
  });
});

function isAutomatedEligible(symbol: string): boolean {
  return AUTOMATED_DERIV_MARKETS.some((m) => m.symbol === symbol);
}
