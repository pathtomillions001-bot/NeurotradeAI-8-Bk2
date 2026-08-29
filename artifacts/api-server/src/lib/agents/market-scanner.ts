/**
 * Agent 1: Universal Market Scanner
 *
 * RESPONSIBILITY: Validate that a market is worth scanning given the user's
 * enabled contract types, the market's tick data quality, and basic suitability.
 * Enforces deterministic scanning order — never revisits a market within its
 * group cycle until all others have been evaluated. This agent is called per
 * market BEFORE any compute-intensive analysis is performed.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

export interface ScannerResult {
  isEligible: boolean;
  hasDigitData: boolean;
  hasDirectionData: boolean;
  dataQuality: number;       // 0-100
  tickCount: number;
  digitCount: number;
  marketType: "synthetic_1s" | "synthetic" | "jump" | "bull_bear" | "other";
  enabledFamilies: string[];  // which contract families are active for this market
  skipReason?: string;
}

function classifyMarketType(symbol: string): ScannerResult["marketType"] {
  if (symbol.startsWith("1HZ")) return "synthetic_1s";
  if (symbol.startsWith("R_")) return "synthetic";
  if (symbol.startsWith("JD")) return "jump";
  if (symbol === "RDBULL" || symbol === "RDBEAR") return "bull_bear";
  return "other";
}

export function runMarketScannerAgent(ctx: ScanContext): AgentOutput & { scannerResult: ScannerResult } {
  const t0 = Date.now();

  const preferred = ctx.settings.preferredContractTypes;
  const tickCount = ctx.prices.length;
  const digitCount = ctx.digits.length;
  const symbol = ctx.symbol;
  const marketType = classifyMarketType(symbol);

  const hasDirectionCapability = marketType !== "other";
  // Bull/Bear indices (RDBULL/RDBEAR) are digit-enabled just like the synthetic
  // volatility/jump indices — they support Over/Under, Even/Odd, and Match/Differ
  // in addition to Rise/Fall.
  const hasDigitCapability = (
    marketType === "synthetic_1s" ||
    marketType === "synthetic" ||
    marketType === "jump" ||
    marketType === "bull_bear"
  );

  const wantDirection = preferred.some(t => ["CALL", "PUT", "RISE", "FALL"].includes(t));
  const wantOverUnder = preferred.some(t => t === "DIGITOVER" || t === "DIGITUNDER");
  const wantEvenOdd = preferred.some(t => t === "DIGITEVEN" || t === "DIGITODD");
  const wantMatchDiff = preferred.some(t => t === "DIGITMATCH" || t === "DIGITDIFF");
  const wantDigit = wantOverUnder || wantEvenOdd || wantMatchDiff;

  const enabledFamilies: string[] = [];
  if (wantDirection && hasDirectionCapability) enabledFamilies.push("direction");
  if (wantOverUnder && hasDigitCapability) enabledFamilies.push("overunder");
  if (wantEvenOdd && hasDigitCapability) enabledFamilies.push("evenodd");
  if (wantMatchDiff && hasDigitCapability) enabledFamilies.push("matchdiff");

  // Hard-block direction when tick count is insufficient for trend/momentum analysis.
  // Markets with 10–19 ticks pass the MIN_TICKS=10 initial filter but direction agents
  // (tick intelligence, rise-fall model) need ≥20 ticks for reliable momentum and
  // autocorrelation calculations. Feeding them 15 ticks produces garbage scores.
  // Remove direction from enabled families rather than marking the whole market
  // ineligible — it may still be tradeable on digit contracts if digit data is present.
  if (tickCount < 20 && enabledFamilies.includes("direction")) {
    enabledFamilies.splice(enabledFamilies.indexOf("direction"), 1);
  }

  // Skip if no enabled families for this market
  if (enabledFamilies.length === 0) {
    const result: ScannerResult = {
      isEligible: false,
      hasDigitData: false,
      hasDirectionData: false,
      dataQuality: 0,
      tickCount,
      digitCount,
      marketType,
      enabledFamilies,
      skipReason: "No enabled contract types match this market's capabilities",
    };
    return {
      agentId: "marketScanner",
      score: 0, confidence: 100, signal: "sell",
      reasoning: result.skipReason!,
      data: { scannerResult: result },
      executionTimeMs: Date.now() - t0,
      scannerResult: result,
    };
  }

  // Minimum tick requirements
  const MIN_TICKS = 10;
  const MIN_DIGITS = wantDigit && hasDigitCapability ? 30 : 0;

  if (tickCount < MIN_TICKS) {
    const result: ScannerResult = {
      isEligible: false,
      hasDigitData: digitCount >= MIN_DIGITS,
      hasDirectionData: tickCount >= MIN_TICKS,
      dataQuality: Math.round((tickCount / MIN_TICKS) * 100),
      tickCount, digitCount, marketType, enabledFamilies,
      skipReason: `Insufficient tick data: ${tickCount}/${MIN_TICKS} required`,
    };
    return {
      agentId: "marketScanner",
      score: 10, confidence: 100, signal: "sell",
      reasoning: result.skipReason!,
      data: { scannerResult: result },
      executionTimeMs: Date.now() - t0,
      scannerResult: result,
    };
  }

  // Data quality scoring
  const priceDQ = Math.min(100, (tickCount / 100) * 100);
  const digitDQ = wantDigit && hasDigitCapability ? Math.min(100, (digitCount / 200) * 100) : 100;
  const dataQuality = Math.round(priceDQ * 0.5 + digitDQ * 0.5);

  // Market suitability scoring
  // 1s synthetic indices have highest tick frequency — best for digit analysis
  const marketBonus = marketType === "synthetic_1s" ? 10
    : marketType === "synthetic" ? 5
    : marketType === "jump" ? 5
    : 0;

  const score = Math.min(100, Math.round(dataQuality * 0.8 + marketBonus));

  const result: ScannerResult = {
    isEligible: true,
    hasDigitData: digitCount >= 30,
    hasDirectionData: tickCount >= 20,
    dataQuality,
    tickCount,
    digitCount,
    marketType,
    enabledFamilies,
  };

  const reasoning = [
    `Market: ${symbol} (${marketType}).`,
    `Ticks: ${tickCount}, Digits: ${digitCount}.`,
    `Active families: [${enabledFamilies.join(", ")}].`,
    `Data quality: ${dataQuality}%.`,
  ].join(" ");

  return {
    agentId: "marketScanner",
    score,
    confidence: 100,
    signal: scoreToSignal(score),
    reasoning,
    data: { scannerResult: result },
    executionTimeMs: Date.now() - t0,
    scannerResult: result,
  };
}
