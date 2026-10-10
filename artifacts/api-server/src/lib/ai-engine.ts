/**
 * AI Trading Engine — 8-Agent ML Ensemble (Synthetics Only)
 *
 * Uses Random Forest, Gradient Boosting, Logistic Regression for direction;
 * Markov + Multinomial models for digit OVER/UNDER with adaptive tick windows.
 * No EMA/RSI — crowd indicators deliberately avoided.
 */

import { analyzeDigits, DigitStats } from "./deriv";
import { getCachedDirection, getCachedDigitPrediction } from "./ml-cache";
import { getWinRate, getWinRateCount, updateWinRate } from "./win-rate-store";
import { detectVolatilityRegime, extractPriceFeatures } from "./ml-engine";

export interface AgentScore {
  score: number;
  weight: number;
  signal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  reasoning: string;
}

export interface AgentScores {
  marketScanner: AgentScore;
  trendAnalysis: AgentScore;
  volatilityAnalysis: AgentScore;
  patternRecognition: AgentScore;
  riskManagement: AgentScore;
  capitalPreservation: AgentScore;
  tradeExecution: AgentScore;
  selfLearning: AgentScore;
}

export interface ContractTypeOption {
  contractType: string;
  label: string;
  description: string;
  suitable: boolean;
  confidence: number;
  recommendedStake: number;
  riskLevel: "low" | "medium" | "high";
}

export interface MarketAnalysis {
  symbol: string;
  qualityScore: number;
  confidenceScore: number;
  riskScore: number;
  trend: "strong_up" | "up" | "sideways" | "down" | "strong_down";
  volatility: "low" | "medium" | "high" | "extreme";
  recommendedContractType: string;
  direction: "up" | "down";
  recommendedStake: number;
  profitability: number;
  agentScores: AgentScores;
  shouldTrade: boolean;
  reasoning: string;
  warnings: string[];
  suggestedContractTypes: ContractTypeOption[];
  digitStats?: DigitStats;
  digitBarrier?: number;
  digitConfidence?: number;
  recommendedDuration?: number;
  tickWindow?: number;
  winProbability?: number;
  mlModels?: { randomForest: number; gradientBoosting: number; logistic: number };
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stddev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / arr.length);
}
function scoreToSignal(score: number): AgentScore["signal"] {
  if (score >= 80) return "strong_buy";
  if (score >= 60) return "buy";
  if (score >= 40) return "neutral";
  if (score >= 20) return "sell";
  return "strong_sell";
}

export async function updateSelfLearning(
  symbol: string,
  contractType: string,
  barrier: number | null | undefined,
  won: boolean,
): Promise<void> {
  await updateWinRate(symbol, contractType, barrier, won);
}

export function getMarketWinRate(symbol: string, contractType?: string): number {
  return getWinRate(symbol, contractType);
}

function trendFromDirection(probUp: number): {
  trend: MarketAnalysis["trend"];
  strength: number;
  score: number;
} {
  if (probUp > 0.72) return { trend: "strong_up", strength: probUp, score: Math.round(probUp * 100) };
  if (probUp > 0.58) return { trend: "up", strength: probUp, score: Math.round(probUp * 90) };
  if (probUp < 0.28) return { trend: "strong_down", strength: 1 - probUp, score: Math.round((1 - probUp) * 100) };
  if (probUp < 0.42) return { trend: "down", strength: 1 - probUp, score: Math.round((1 - probUp) * 90) };
  return { trend: "sideways", strength: 0.3, score: 45 };
}

export function analyzeMarket(
  symbol: string,
  category: string,
  prices: number[],
  balance: number,
  settings: {
    maxRiskPerTrade: number;
    minConfidenceThreshold: number;
    riskProfile: string;
    preferredContractTypes?: string[];
    tradeDurationSec?: number;
    maxTradeStake?: number;
  },
  digits?: number[]
): MarketAnalysis {
  if (prices.length < 5) {
    prices = [...prices, ...Array(5 - prices.length).fill(prices[0] ?? 1000)];
  }

  const avgPrice = mean(prices);
  const priceRange = Math.max(...prices) - Math.min(...prices);
  const rangeRatio = priceRange / avgPrice;

  const mlDirection = getCachedDirection(symbol, prices);
  const mlTrend = trendFromDirection(mlDirection.probUp);
  const volRegime = detectVolatilityRegime(prices);
  const priceFeats = extractPriceFeatures(prices);

  // === 1. Market Scanner ===
  let scannerScore = 50;
  if (rangeRatio > 0.001 && rangeRatio < 0.05) scannerScore = 78;
  else if (rangeRatio > 0.0005) scannerScore = 64;
  else if (rangeRatio > 0.1) scannerScore = 32;
  scannerScore = Math.min(scannerScore + 8, 100);
  const marketScanner: AgentScore = {
    score: scannerScore,
    weight: 0.10,
    signal: scoreToSignal(scannerScore),
    reasoning: `Range ${(rangeRatio * 100).toFixed(3)}%. Synthetic 24/7. Scanner: ${scannerScore > 70 ? "excellent" : scannerScore > 55 ? "good" : "marginal"}.`,
  };

  // === 2. Trend Analysis (Random Forest + GBM + LogReg ensemble) ===
  const trendAnalysis: AgentScore = {
    score: mlTrend.score,
    weight: 0.18,
    signal: scoreToSignal(mlTrend.score),
    reasoning: `ML ensemble trend: ${mlTrend.trend.replace("_", " ")} (${(mlTrend.strength * 100).toFixed(0)}%). ${mlDirection.reasoning}.`,
  };

  // === 3. Volatility Analysis (entropy/Hurst-based, no RSI) ===
  const volatilityAnalysis: AgentScore = {
    score: volRegime.score,
    weight: 0.13,
    signal: scoreToSignal(volRegime.score),
    reasoning: volRegime.reasoning,
  };

  // === 4. Pattern Recognition (spectral + autocorrelation features) ===
  const patternScore = Math.round(
    Math.min(95, 50 +
      Math.abs(priceFeats.autocorr3) * 30 +
      priceFeats.spectralEnergy * 200 +
      Math.abs(priceFeats.zScoreLast) * 8)
  );
  const patternName = Math.abs(priceFeats.autocorr3) > 0.3
    ? "autocorrelation regime"
    : priceFeats.spectralEnergy > 0.02
      ? "spectral cycle"
      : Math.abs(priceFeats.zScoreLast) > 1.5
        ? "statistical deviation"
        : "neutral microstructure";
  const patternRecognition: AgentScore = {
    score: patternScore,
    weight: 0.15,
    signal: scoreToSignal(patternScore),
    reasoning: `${patternName} detected via ML features. Hurst=${priceFeats.hurst.toFixed(2)}, entropy=${priceFeats.returnEntropy.toFixed(2)}.`,
  };

  // === 5. Risk Management (volatility regime + ML confidence, no RSI) ===
  const riskFromVol = volRegime.regime === "extreme" ? 30 : volRegime.regime === "high" ? 52 : volRegime.regime === "medium" ? 76 : 58;
  const riskFromConf = mlDirection.confidence > 60 ? 78 : mlDirection.confidence > 40 ? 65 : 48;
  const riskScore = Math.round(riskFromVol * 0.6 + riskFromConf * 0.4);
  const riskManagement: AgentScore = {
    score: riskScore,
    weight: 0.13,
    signal: scoreToSignal(riskScore),
    reasoning: `Vol regime: ${volRegime.regime}. ML confidence: ${mlDirection.confidence}%. Risk-adjusted score: ${riskScore}/100.`,
  };

  // === 6. Capital Preservation ===
  const profMult = settings.riskProfile === "conservative" ? 0.5 : settings.riskProfile === "aggressive" ? 1.0 : 0.7;
  let safeStake: number;
  let stakingDesc: string;
  if ((settings as any).riskAmountType === "fixed") {
    const fixedAmount = Number((settings as any).riskAmountValue ?? 1);
    safeStake = (!isFinite(fixedAmount) || fixedAmount <= 0) ? 1 : fixedAmount * profMult;
    stakingDesc = `$${fixedAmount.toFixed(2)} fixed × ${settings.riskProfile}`;
  } else {
    // Percentage mode — riskAmountValue holds the % figure set by the user.
    // Do NOT use maxRiskPerTrade: that column is not updated by the settings form.
    const riskPct = Number((settings as any).riskAmountValue ?? settings.maxRiskPerTrade);
    const maxStake = balance * (riskPct / 100);
    safeStake = Math.min(maxStake * profMult, balance * 0.05);
    stakingDesc = `${riskPct}% × ${settings.riskProfile}`;
  }
  if (settings.maxTradeStake) safeStake = Math.min(safeStake, settings.maxTradeStake);
  safeStake = Math.max(0.35, safeStake);
  const capScore = safeStake > 0 ? 72 : 28;
  const capitalPreservation: AgentScore = {
    score: capScore,
    weight: 0.08,
    signal: scoreToSignal(capScore),
    reasoning: `Safe stake: $${safeStake.toFixed(2)} (${stakingDesc}).`,
  };

  // === 7. Trade Execution (tick velocity from ML features) ===
  const avgMove = priceFeats.tickVelocity;
  const execScore = avgMove > 0.0002 && avgMove < 0.008 ? 76 : avgMove < 0.0001 ? 44 : 55;
  const tradeExecution: AgentScore = {
    score: execScore,
    weight: 0.08,
    signal: scoreToSignal(execScore),
    reasoning: `Tick velocity: ${(avgMove * 100).toFixed(4)}%. Entry timing: ${execScore > 65 ? "favorable" : "suboptimal"}.`,
  };

  // === 8. Self-Learning (persisted DB win rates) ===
  const persistedWinRate = getWinRate(symbol);
  const persistedCount = getWinRateCount(symbol, "CALL") + getWinRateCount(symbol, "DIGITOVER");
  const selfScore = Math.min(Math.round(persistedWinRate * 90 + (persistedCount > 10 ? 9 : persistedCount)), 95);
  const selfLearning: AgentScore = {
    score: selfScore,
    weight: 0.15,
    signal: scoreToSignal(selfScore),
    reasoning: `Persisted win rate: ${(persistedWinRate * 100).toFixed(1)}% over ${persistedCount} tracked trades.`,
  };

  const agentScores: AgentScores = {
    marketScanner, trendAnalysis, volatilityAnalysis, patternRecognition,
    riskManagement, capitalPreservation, tradeExecution, selfLearning,
  };

  const qualityScore = Math.round(
    marketScanner.score * marketScanner.weight +
    trendAnalysis.score * trendAnalysis.weight +
    volatilityAnalysis.score * volatilityAnalysis.weight +
    patternRecognition.score * patternRecognition.weight +
    riskManagement.score * riskManagement.weight +
    capitalPreservation.score * capitalPreservation.weight +
    tradeExecution.score * tradeExecution.weight +
    selfLearning.score * selfLearning.weight
  );

  const confidenceScore = Math.round(
    mlDirection.confidence * 0.45 +
    trendAnalysis.score * 0.30 +
    patternRecognition.score * 0.15 +
    selfLearning.score * 0.10
  );

  const overallRisk = Math.round(100 - (riskManagement.score * 0.5 + capitalPreservation.score * 0.3 + volatilityAnalysis.score * 0.2));
  const direction = mlDirection.direction;
  const volCat = volRegime.regime;
  const { trend, strength } = mlTrend;

  // === Digit ML analysis (Markov + Multinomial, adaptive window) ============
  let digitStats: DigitStats | undefined;
  let digitBarrier: number | undefined;
  let digitContractType: "DIGITOVER" | "DIGITUNDER" | null = null;
  let digitConfidence = 0;
  let tickWindow: number | undefined;
  let recommendedDuration = settings.tradeDurationSec ?? 5;

  if (digits && digits.length >= 30) {
    digitStats = analyzeDigits(digits);
    const digitML = getCachedDigitPrediction(symbol, digits);
    if (digitML) {
      digitContractType = digitML.contractType;
      digitBarrier = digitML.barrier;
      digitConfidence = digitML.confidence;
      tickWindow = digitML.optimalWindow;
      recommendedDuration = Math.max(3, Math.min(10, Math.round(digitML.optimalWindow / 15)));
      digitStats.streakInfo = `${digitML.reasoning}. Window: ${digitML.optimalWindow} ticks. Edge: ${(digitML.expectedEdge * 100).toFixed(1)}%`;
    }
  }

  const isVolatility = symbol.startsWith("R_") || symbol.startsWith("1HZ");
  const isJump = symbol.startsWith("JD");
  const hasDigit = isVolatility || isJump;

  const riseCallStake = Math.round(safeStake * 100) / 100;
  const digitStake = Math.round(safeStake * 0.7 * 100) / 100;

  const contractOptions: ContractTypeOption[] = [];

  contractOptions.push({
    contractType: direction === "up" ? "CALL" : "PUT",
    label: direction === "up" ? "Rise" : "Fall",
    description: `ML ensemble: ${(mlDirection.probUp * 100).toFixed(0)}% up probability`,
    suitable: mlDirection.confidence >= 30,
    confidence: confidenceScore,
    recommendedStake: riseCallStake,
    riskLevel: volCat === "extreme" ? "high" : volCat === "medium" ? "low" : "medium",
  });

  contractOptions.push({
    contractType: direction === "up" ? "CALL" : "PUT",
    label: direction === "up" ? "CALL" : "PUT",
    description: `Directional expiry — ML ${direction} signal`,
    suitable: mlDirection.confidence >= 35,
    confidence: Math.round(confidenceScore * 0.92),
    recommendedStake: riseCallStake,
    riskLevel: "medium",
  });

  if (hasDigit && digitContractType && digitStats && digitConfidence >= 55) {
    const isOver = digitContractType === "DIGITOVER";
    contractOptions.push({
      contractType: digitContractType,
      label: `${isOver ? "OVER" : "UNDER"} ${digitBarrier}`,
      description: `ML digit model: ${digitStats.streakInfo}`,
      suitable: volCat !== "extreme",
      confidence: digitConfidence,
      recommendedStake: digitStake,
      riskLevel: "low",
    });
  }

  const preferred = settings.preferredContractTypes ?? ["CALL", "PUT", "DIGITOVER", "DIGITUNDER"];

  // Contract-specific routing: prefer digit model for digit contracts, direction model for rise/fall
  const digitPreferred = preferred.some((p) => p.startsWith("DIGIT"));
  const directionPreferred = preferred.some((p) => ["RISE", "FALL", "CALL", "PUT"].includes(p));

  let filteredOptions = contractOptions.filter((opt) => preferred.some((p) => opt.contractType.startsWith(p)) && opt.suitable);

  if (digitPreferred && digitContractType && digitConfidence >= 55 && !directionPreferred) {
    filteredOptions = filteredOptions.filter((o) => o.contractType.includes("DIGIT"));
  } else if (directionPreferred && !digitPreferred) {
    filteredOptions = filteredOptions.filter((o) => !o.contractType.includes("DIGIT"));
  }

  const chosen = filteredOptions.sort((a, b) => b.confidence - a.confidence)[0] ?? contractOptions[0];

  const contractWinRate = getWinRate(symbol, chosen.contractType, digitBarrier);
  const winProbability = chosen.contractType.includes("DIGIT")
    ? digitConfidence
    : Math.round(mlDirection.probUp >= 0.5 ? mlDirection.probUp * 100 : mlDirection.probDown * 100);

  const profitability = Math.round((confidenceScore * 0.6 + qualityScore * 0.4) * 0.95);

  const warnings: string[] = [];
  if (volCat === "extreme") warnings.push("Extreme volatility — reduce stake significantly");
  if (mlDirection.confidence < 25) warnings.push("Low ML confidence — weak directional edge");
  if (overallRisk > 60) warnings.push("Elevated risk — caution");
  if (patternScore < 55) warnings.push("No clear microstructure pattern — lower conviction");
  if (digitStats?.streakInfo.includes("Edge")) warnings.push(digitStats.streakInfo);

  const shouldTrade = confidenceScore >= settings.minConfidenceThreshold
    && overallRisk < 70
    && volCat !== "extreme"
    && (chosen.contractType.includes("DIGIT")
      ? digitConfidence >= 55
      : mlDirection.confidence >= 25)
    && contractWinRate >= 0.42;

  const digitNote = digitStats
    ? ` Digit ML: ${digitContractType ?? "no edge"}${digitBarrier !== undefined ? ` @ ${digitBarrier}` : ""} (${digitConfidence}% conf, ${tickWindow ?? "?"} ticks).`
    : "";

  const reasoning = `Quality: ${qualityScore}/100. ML trend: ${trend.replace("_", " ")} (${(strength * 100).toFixed(0)}%). RF=${(mlDirection.models.randomForest * 100).toFixed(0)}% GBM=${(mlDirection.models.gradientBoosting * 100).toFixed(0)}%. Win prob: ${winProbability}%.${digitNote} Recommending ${chosen.label ?? chosen.contractType} at $${chosen.recommendedStake} for ${recommendedDuration} ticks. Contract WR: ${(contractWinRate * 100).toFixed(1)}%. ${shouldTrade ? "Risk checks passed." : "Below threshold."}`;

  return {
    symbol,
    qualityScore,
    confidenceScore,
    riskScore: overallRisk,
    trend: trend as MarketAnalysis["trend"],
    volatility: volCat,
    recommendedContractType: chosen.contractType,
    direction,
    recommendedStake: chosen.recommendedStake,
    profitability,
    agentScores,
    shouldTrade,
    reasoning,
    warnings,
    suggestedContractTypes: contractOptions,
    digitStats,
    digitBarrier,
    digitConfidence: digitConfidence || undefined,
    recommendedDuration,
    tickWindow,
    winProbability,
    mlModels: mlDirection.models,
  };
}
