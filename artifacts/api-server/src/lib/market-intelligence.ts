import type { LiveCandle, LiveMarketSymbol, LiveTick } from "./cfd-market-data";

/**
 * Advanced signal desk timeframes. One minute is supported by requesting one
 * minute candles from Deriv; higher timeframes are fetched independently so a
 * lower-timeframe setup cannot override a conflicting macro structure.
 */
export const INTELLIGENCE_TIMEFRAMES = [
  { value: 60, label: "1m" },
  { value: 300, label: "5m" },
  { value: 900, label: "15m" },
  { value: 3600, label: "1h" },
  { value: 14400, label: "4h" },
  { value: 86400, label: "1D" },
] as const;

export type IntelligenceSignal = "BUY" | "SELL" | "NO_TRADE";
export type IntelligenceOutcome = "OPEN" | "TP" | "SL" | "EXPIRED" | "AMBIGUOUS" | "UNVERIFIED";

export interface StrategyVote {
  name: string;
  stance: IntelligenceSignal;
  score: number;
  weight: number;
  evidence: string;
}

export interface AdvancedAnalytics {
  price: number;
  returnMeanPercent: number;
  realizedVolatilityPercent: number;
  volatilityRegimeRatio: number;
  returnZScore: number;
  autocorrelation1: number;
  hurstExponent: number;
  permutationEntropy: number;
  quantile05: number;
  quantile95: number;
  support: number;
  resistance: number;
  macroStructure: "BULLISH" | "BEARISH" | "BALANCED";
  microStructure: "BULLISH" | "BEARISH" | "BALANCED";
  breakOfStructure: "BUY" | "SELL" | "NONE";
  changeOfCharacter: "BUY" | "SELL" | "NONE";
  liquiditySweep: "BUY_REVERSAL" | "SELL_REVERSAL" | "NONE";
  displacement: "BUY" | "SELL" | "NONE";
  reversalScore: number;
  deltaProxy: number;
  signedVolumeProxy: number;
  tickImbalance: number;
  tickRatePerMinute: number;
  orderflowQuality: "TICK_PROXY" | "INSUFFICIENT";
}

export interface MarkovSnapshot {
  sampleSize: number;
  state: "STRONG_DOWN" | "DOWN" | "FLAT" | "UP" | "STRONG_UP";
  nextUpProbability: number;
  nextDownProbability: number;
  transitionEntropy: number;
  signal: IntelligenceSignal;
}

export interface MonteCarloSnapshot {
  paths: number;
  steps: number;
  tpBeforeSl: number;
  slBeforeTp: number;
  neither: number;
  method: string;
}

export interface PositionSizing {
  balance: number;
  riskPercent: number;
  riskAmount: number;
  stopDistance: number;
  takeProfitDistance: number;
  unitsPerLot: number;
  recommendedLotSize: number;
  formula: string;
  basis: "indicative";
}

export interface MarketIntelligenceResult {
  id: string;
  generatedAt: string;
  feed: "DERIV_LIVE";
  symbol: string;
  displayName: string;
  category: string;
  timeframeSeconds: number;
  timeframeLabel: string;
  higherTimeframeSeconds: number;
  higherTimeframeLabel: string;
  signal: IntelligenceSignal;
  confidence: number;
  modelProbability: number;
  dataFreshnessSeconds: number;
  validUntil: string;
  expectedDurationSeconds: number;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  positionSizing: PositionSizing;
  regime: "TREND" | "RANGE" | "HIGH_VOLATILITY" | "LOW_VOLATILITY" | "INSUFFICIENT_DATA";
  higherTimeframeBias: IntelligenceSignal;
  higherTimeframeAgreement: boolean;
  analytics: AdvancedAnalytics;
  higherAnalytics: AdvancedAnalytics;
  markov: MarkovSnapshot;
  monteCarlo: MonteCarloSnapshot;
  strategies: StrategyVote[];
  guards: string[];
  rationale: string[];
  outcome: IntelligenceOutcome;
  outcomeAt: string | null;
  outcomePrice: number | null;
  liveDataOnly: true;
  execution: "SIGNAL_ONLY";
}

export interface IntelligenceInput {
  symbol: LiveMarketSymbol;
  candles: LiveCandle[];
  higherCandles: LiveCandle[];
  ticks: LiveTick[];
  timeframeSeconds: number;
  higherTimeframeSeconds: number;
  balance: number;
  riskPercent: number;
  unitsPerLot?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function logReturns(candles: LiveCandle[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0 && candles[i].close > 0) result.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  return result;
}

function autocorrelation(values: number[], lag = 1): number {
  if (values.length <= lag + 2) return 0;
  const average = mean(values);
  const denominator = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  if (!denominator) return 0;
  let numerator = 0;
  for (let i = lag; i < values.length; i++) numerator += (values[i] - average) * (values[i - lag] - average);
  return clamp(numerator / denominator, -1, 1);
}

/** R/S slope estimate. This is a regime descriptor, not a future guarantee. */
function hurstExponent(values: number[]): number {
  if (values.length < 48) return 0.5;
  const points: Array<{ x: number; y: number }> = [];
  for (const size of [8, 16, 32, 48]) {
    if (size > values.length) continue;
    const ranges: number[] = [];
    for (let offset = 0; offset + size <= values.length; offset += size) {
      const block = values.slice(offset, offset + size);
      const average = mean(block);
      let cumulative = 0;
      let high = -Infinity;
      let low = Infinity;
      for (const value of block) {
        cumulative += value - average;
        high = Math.max(high, cumulative);
        low = Math.min(low, cumulative);
      }
      const scale = std(block);
      if (scale > 0) ranges.push((high - low) / scale);
    }
    if (ranges.length) points.push({ x: Math.log(size), y: Math.log(mean(ranges)) });
  }
  if (points.length < 2) return 0.5;
  const xBar = mean(points.map((point) => point.x));
  const yBar = mean(points.map((point) => point.y));
  const denominator = points.reduce((sum, point) => sum + (point.x - xBar) ** 2, 0);
  const slope = denominator ? points.reduce((sum, point) => sum + (point.x - xBar) * (point.y - yBar), 0) / denominator : 0.5;
  return clamp(slope, 0, 1);
}

/** Three-state entropy: directional sequence complexity from live candles. */
function permutationEntropy(values: number[]): number {
  if (values.length < 4) return 1;
  const counts = [0, 0, 0];
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    counts[change > 0 ? 2 : change < 0 ? 0 : 1]++;
  }
  const total = values.length - 1;
  const entropy = counts.reduce((sum, count) => {
    if (!count) return sum;
    const p = count / total;
    return sum - p * Math.log2(p);
  }, 0);
  return clamp(entropy / Math.log2(3), 0, 1);
}

function tickFlow(ticks: LiveTick[], timeframeSeconds: number): Pick<AdvancedAnalytics, "deltaProxy" | "signedVolumeProxy" | "tickImbalance" | "tickRatePerMinute" | "orderflowQuality"> {
  const recent = ticks.slice(-3000);
  let up = 0;
  let down = 0;
  let unchanged = 0;
  let signedMove = 0;
  let absoluteMove = 0;
  for (let i = 1; i < recent.length; i++) {
    const move = recent[i].price - recent[i - 1].price;
    if (move > 0) up++;
    else if (move < 0) down++;
    else unchanged++;
    signedMove += move;
    absoluteMove += Math.abs(move);
  }
  const directional = up + down;
  const durationMinutes = Math.max((recent[recent.length - 1]?.epoch - recent[0]?.epoch) / 60, timeframeSeconds / 60, 1);
  return {
    // Deriv public ticks do not expose exchange-traded size or an order book.
    // These are explicitly proxies, never labelled as institutional volume.
    deltaProxy: round(directional ? (up - down) / directional : 0, 4),
    signedVolumeProxy: round(absoluteMove ? signedMove / absoluteMove : 0, 4),
    tickImbalance: round((up - down) / Math.max(up + down + unchanged, 1), 4),
    tickRatePerMinute: round(recent.length / durationMinutes, 2),
    orderflowQuality: recent.length >= 100 ? "TICK_PROXY" : "INSUFFICIENT",
  };
}

type Swing = { index: number; price: number; kind: "HIGH" | "LOW" };

function fractalSwings(candles: LiveCandle[], radius: number): Swing[] {
  const swings: Swing[] = [];
  for (let i = radius; i < candles.length - radius; i++) {
    const current = candles[i];
    const left = candles.slice(i - radius, i);
    const right = candles.slice(i + 1, i + radius + 1);
    if (current.high > Math.max(...left.map((candle) => candle.high), ...right.map((candle) => candle.high))) swings.push({ index: i, price: current.high, kind: "HIGH" });
    if (current.low < Math.min(...left.map((candle) => candle.low), ...right.map((candle) => candle.low))) swings.push({ index: i, price: current.low, kind: "LOW" });
  }
  return swings.sort((a, b) => a.index - b.index);
}

function structuralDirection(swings: Swing[]): "BULLISH" | "BEARISH" | "BALANCED" {
  const highs = swings.filter((swing) => swing.kind === "HIGH").slice(-3);
  const lows = swings.filter((swing) => swing.kind === "LOW").slice(-3);
  const higherHighs = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const higherLows = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lowerHighs = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
  const lowerLows = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
  if (higherHighs && higherLows) return "BULLISH";
  if (lowerHighs && lowerLows) return "BEARISH";
  return "BALANCED";
}

function liquidityLevels(swings: Swing[], price: number): { support: number; resistance: number } {
  const lows = swings.filter((swing) => swing.kind === "LOW").map((swing) => swing.price).filter((level) => level < price);
  const highs = swings.filter((swing) => swing.kind === "HIGH").map((swing) => swing.price).filter((level) => level > price);
  return {
    support: lows.length ? Math.max(...lows) : price,
    resistance: highs.length ? Math.min(...highs) : price,
  };
}

function structureEvents(candles: LiveCandle[], microSwings: Swing[], macroSwings: Swing[]): Pick<AdvancedAnalytics, "breakOfStructure" | "changeOfCharacter" | "liquiditySweep" | "displacement" | "reversalScore"> {
  const latest = candles[candles.length - 1];
  const prior = candles.slice(-20, -1);
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const recentRange = mean(candles.slice(-30).map((candle) => candle.high - candle.low));
  const lastRange = latest.high - latest.low;
  const breakOfStructure = latest.close > priorHigh ? "BUY" : latest.close < priorLow ? "SELL" : "NONE";
  const macroDirection = structuralDirection(macroSwings);
  const changeOfCharacter = breakOfStructure === "BUY" && macroDirection === "BEARISH" ? "BUY" : breakOfStructure === "SELL" && macroDirection === "BULLISH" ? "SELL" : "NONE";
  const lastHigh = Math.max(...microSwings.filter((swing) => swing.kind === "HIGH").slice(-4).map((swing) => swing.price), -Infinity);
  const lastLow = Math.min(...microSwings.filter((swing) => swing.kind === "LOW").slice(-4).map((swing) => swing.price), Infinity);
  const liquiditySweep = latest.low < lastLow && latest.close > lastLow ? "BUY_REVERSAL" : latest.high > lastHigh && latest.close < lastHigh ? "SELL_REVERSAL" : "NONE";
  const displacement = lastRange > recentRange * 1.8 && Math.abs(latest.close - latest.open) / Math.max(lastRange, 1e-12) > 0.6 ? (latest.close > latest.open ? "BUY" : "SELL") : "NONE";
  const reversalScore = clamp((liquiditySweep !== "NONE" ? 0.45 : 0) + (changeOfCharacter !== "NONE" ? 0.3 : 0) + (Math.abs(latest.close - latest.open) < lastRange * 0.25 ? 0.1 : 0), 0, 1);
  return { breakOfStructure, changeOfCharacter, liquiditySweep, displacement, reversalScore: round(reversalScore, 3) };
}

function advancedAnalytics(candles: LiveCandle[], ticks: LiveTick[], timeframeSeconds: number): AdvancedAnalytics {
  const closes = candles.map((candle) => candle.close);
  const latest = candles[candles.length - 1]?.close ?? 0;
  const returns = logReturns(candles).slice(-240);
  const averageReturn = mean(returns);
  const volatility = std(returns);
  const currentWindow = returns.slice(-20);
  const longVolatility = std(returns);
  const volatilityRatio = longVolatility ? std(currentWindow) / longVolatility : 1;
  const lastReturn = returns[returns.length - 1] ?? 0;
  const microSwings = fractalSwings(candles, 2);
  const macroSwings = fractalSwings(candles, 8);
  const levels = liquidityLevels(macroSwings, latest);
  const flow = tickFlow(ticks, timeframeSeconds);
  const events = structureEvents(candles, microSwings, macroSwings);
  const recentRange = candles.slice(-40);
  const rangePrices = recentRange.flatMap((candle) => [candle.high, candle.low]);
  return {
    price: round(latest),
    returnMeanPercent: round(averageReturn * 100, 5),
    realizedVolatilityPercent: round(volatility * 100, 5),
    volatilityRegimeRatio: round(volatilityRatio, 3),
    returnZScore: round(volatility ? (lastReturn - averageReturn) / volatility : 0, 3),
    autocorrelation1: round(autocorrelation(returns), 3),
    hurstExponent: round(hurstExponent(returns), 3),
    permutationEntropy: round(permutationEntropy(closes), 3),
    quantile05: round(quantile(returns, 0.05) * 100, 5),
    quantile95: round(quantile(returns, 0.95) * 100, 5),
    support: round(levels.support || Math.min(...rangePrices)),
    resistance: round(levels.resistance || Math.max(...rangePrices)),
    macroStructure: structuralDirection(macroSwings),
    microStructure: structuralDirection(microSwings),
    ...events,
    ...flow,
  };
}

function markov(candles: LiveCandle[]): MarkovSnapshot {
  const closes = candles.map((candle) => candle.close);
  const returns = logReturns(candles).slice(-300);
  const scale = Math.max(std(returns), 1e-12);
  const states = returns.map((value) => value > scale * 0.5 ? 2 : value > scale * 0.08 ? 1 : value < -scale * 0.5 ? -2 : value < -scale * 0.08 ? -1 : 0);
  const counts = new Map<number, { up: number; down: number; total: number }>();
  for (let i = 0; i < states.length - 1; i++) {
    const state = states[i];
    const next = states[i + 1];
    const current = counts.get(state) ?? { up: 1, down: 1, total: 2 };
    current.total++;
    if (next > 0) current.up++;
    if (next < 0) current.down++;
    counts.set(state, current);
  }
  const currentState = states[states.length - 1] ?? 0;
  const transition = counts.get(currentState) ?? { up: 1, down: 1, total: 2 };
  const nextUpProbability = transition.up / transition.total;
  const nextDownProbability = transition.down / transition.total;
  const transitionEntropy = -(nextUpProbability * Math.log2(nextUpProbability) + nextDownProbability * Math.log2(nextDownProbability) + Math.max(1 - nextUpProbability - nextDownProbability, 1e-12) * Math.log2(Math.max(1 - nextUpProbability - nextDownProbability, 1e-12))) / Math.log2(3);
  return {
    sampleSize: states.length,
    state: currentState === 2 ? "STRONG_UP" : currentState === 1 ? "UP" : currentState === -2 ? "STRONG_DOWN" : currentState === -1 ? "DOWN" : "FLAT",
    nextUpProbability: round(nextUpProbability, 3),
    nextDownProbability: round(nextDownProbability, 3),
    transitionEntropy: round(clamp(transitionEntropy, 0, 1), 3),
    signal: nextUpProbability >= 0.57 ? "BUY" : nextDownProbability >= 0.57 ? "SELL" : "NO_TRADE",
  };
}

function higherBias(analytics: AdvancedAnalytics): IntelligenceSignal {
  if (analytics.macroStructure === "BULLISH" && analytics.microStructure !== "BEARISH") return "BUY";
  if (analytics.macroStructure === "BEARISH" && analytics.microStructure !== "BULLISH") return "SELL";
  return "NO_TRADE";
}

function regimeOf(analytics: AdvancedAnalytics, candleCount: number): MarketIntelligenceResult["regime"] {
  if (candleCount < 220) return "INSUFFICIENT_DATA";
  if (analytics.volatilityRegimeRatio >= 1.8) return "HIGH_VOLATILITY";
  if (analytics.hurstExponent >= 0.58 && Math.abs(analytics.autocorrelation1) >= 0.08) return "TREND";
  if (analytics.hurstExponent <= 0.44 || analytics.permutationEntropy >= 0.92) return "RANGE";
  if (analytics.volatilityRegimeRatio <= 0.55) return "LOW_VOLATILITY";
  return "RANGE";
}

function strategyVotes(
  analytics: AdvancedAnalytics,
  higher: AdvancedAnalytics,
  mk: MarkovSnapshot,
  regime: MarketIntelligenceResult["regime"],
): StrategyVote[] {
  const macro = higher.macroStructure === "BULLISH" ? "BUY" : higher.macroStructure === "BEARISH" ? "SELL" : "NO_TRADE" as const;
  const micro = analytics.microStructure === "BULLISH" ? "BUY" : analytics.microStructure === "BEARISH" ? "SELL" : "NO_TRADE" as const;
  const reversal = analytics.liquiditySweep === "BUY_REVERSAL" || analytics.changeOfCharacter === "BUY" ? "BUY" : analytics.liquiditySweep === "SELL_REVERSAL" || analytics.changeOfCharacter === "SELL" ? "SELL" : "NO_TRADE" as const;
  const displacement: IntelligenceSignal = analytics.displacement === "NONE" ? "NO_TRADE" : analytics.displacement;
  const delta = analytics.deltaProxy > 0.12 && analytics.signedVolumeProxy > 0.08 ? "BUY" : analytics.deltaProxy < -0.12 && analytics.signedVolumeProxy < -0.08 ? "SELL" : "NO_TRADE" as const;
  const statistical = analytics.returnZScore <= -1.5 && analytics.hurstExponent < 0.5 ? "BUY" : analytics.returnZScore >= 1.5 && analytics.hurstExponent < 0.5 ? "SELL" : "NO_TRADE" as const;
  const structureScore = (direction: "BUY" | "SELL" | "NO_TRADE") => direction === "NO_TRADE" ? 0 : 65 + Math.abs(analytics.reversalScore * 35);
  return [
    { name: "Macro / micro fractal structure", stance: macro === micro ? macro : "NO_TRADE", score: macro === micro && macro !== "NO_TRADE" ? 100 : 45, weight: 0.22, evidence: `Macro ${higher.macroStructure}; micro ${analytics.microStructure}` },
    { name: "Liquidity sweep reversal", stance: reversal, score: reversal === "NO_TRADE" ? 0 : structureScore(reversal), weight: 0.18, evidence: `${analytics.liquiditySweep.replaceAll("_", " ")} · CHoCH ${analytics.changeOfCharacter}` },
    { name: "Displacement continuation", stance: displacement, score: displacement === "NO_TRADE" ? 0 : 78, weight: 0.14, evidence: `Break ${analytics.breakOfStructure}; displacement ${displacement}` },
    { name: "Tick delta / signed-flow proxy", stance: delta, score: delta === "NO_TRADE" ? 0 : 72, weight: 0.14, evidence: `Delta ${analytics.deltaProxy.toFixed(3)} · signed movement ${analytics.signedVolumeProxy.toFixed(3)}` },
    { name: "Statistical mean-reversion", stance: statistical, score: statistical === "NO_TRADE" ? 0 : 70, weight: 0.12, evidence: `z ${analytics.returnZScore.toFixed(2)} · H ${analytics.hurstExponent.toFixed(2)}` },
    { name: "Markov state transition", stance: mk.signal, score: Math.abs(mk.nextUpProbability - 0.5) * 200, weight: 0.10, evidence: `${(mk.nextUpProbability * 100).toFixed(1)}% up transition · entropy ${mk.transitionEntropy.toFixed(2)}` },
    { name: "Volatility / entropy regime", stance: regime === "TREND" || regime === "HIGH_VOLATILITY" ? macro : "NO_TRADE", score: regime === "INSUFFICIENT_DATA" ? 0 : 60, weight: 0.10, evidence: `${regime.replaceAll("_", " ")} · volatility ratio ${analytics.volatilityRegimeRatio.toFixed(2)}` },
  ];
}

function defaultUnitsPerLot(symbol: LiveMarketSymbol): number {
  if (symbol.category === "forex") return 100_000;
  if (symbol.category === "commodities") return 100;
  return 1;
}

export function timeframeLabel(seconds: number): string {
  return INTELLIGENCE_TIMEFRAMES.find((timeframe) => timeframe.value === seconds)?.label ?? `${Math.round(seconds / 60)}m`;
}

export function higherTimeframeFor(seconds: number): number {
  if (seconds <= 60) return 300;
  if (seconds <= 300) return 900;
  if (seconds <= 900) return 3600;
  if (seconds <= 3600) return 14400;
  return 86400;
}

function monteCarlo(candles: LiveCandle[], side: "BUY" | "SELL", entry: number, stopLoss: number, takeProfit: number, steps: number, paths = 2000): MonteCarloSnapshot {
  const samples = logReturns(candles).slice(-240).filter((value) => Number.isFinite(value) && Math.abs(value) < 0.25);
  if (samples.length < 30) return { paths: 0, steps, tpBeforeSl: 0, slBeforeTp: 0, neither: 1, method: "Unavailable: fewer than 30 live return observations" };
  let tpBeforeSl = 0;
  let slBeforeTp = 0;
  let neither = 0;
  for (let path = 0; path < paths; path++) {
    let price = entry;
    let outcome: "TP" | "SL" | null = null;
    for (let step = 0; step < steps; step++) {
      price *= Math.exp(samples[Math.floor(Math.random() * samples.length)]);
      const tp = side === "BUY" ? price >= takeProfit : price <= takeProfit;
      const sl = side === "BUY" ? price <= stopLoss : price >= stopLoss;
      if (tp) { outcome = "TP"; break; }
      if (sl) { outcome = "SL"; break; }
    }
    if (outcome === "TP") tpBeforeSl++;
    else if (outcome === "SL") slBeforeTp++;
    else neither++;
  }
  return {
    paths,
    steps,
    tpBeforeSl: round(tpBeforeSl / paths, 3),
    slBeforeTp: round(slBeforeTp / paths, 3),
    neither: round(neither / paths, 3),
    method: "Bootstrap resampling of live log returns; scenario analysis, not a price forecast",
  };
}

export function analyzeLiveMarket(input: IntelligenceInput): MarketIntelligenceResult {
  const primary = advancedAnalytics(input.candles, input.ticks, input.timeframeSeconds);
  const higher = advancedAnalytics(input.higherCandles, input.ticks, input.higherTimeframeSeconds);
  const markovSnapshot = markov(input.candles);
  const regime = regimeOf(primary, input.candles.length);
  const higherTimeframeBias = higherBias(higher);
  const strategies = strategyVotes(primary, higher, markovSnapshot, regime);
  const signedScore = strategies.reduce((sum, strategy) => {
    const direction = strategy.stance === "BUY" ? 1 : strategy.stance === "SELL" ? -1 : 0;
    return sum + direction * strategy.weight * (strategy.score / 100);
  }, 0);
  const modelDirection: IntelligenceSignal = signedScore >= 0.16 ? "BUY" : signedScore <= -0.16 ? "SELL" : "NO_TRADE";
  const higherTimeframeAgreement = modelDirection !== "NO_TRADE" && modelDirection === higherTimeframeBias;
  const dataFreshnessSeconds = Math.max(0, Math.round(Date.now() / 1000 - input.candles[input.candles.length - 1].epoch));
  const confidence = round(clamp(50 + Math.abs(signedScore) * 42 + (higherTimeframeAgreement ? 9 : -9) + (primary.orderflowQuality === "TICK_PROXY" ? 3 : -8), 0, 99), 1);
  const guards: string[] = [];
  if (input.candles.length < 220) guards.push("At least 220 live candles are required for structural and statistical evidence");
  if (input.ticks.length < 100) guards.push("At least 100 live ticks are required for the tick-flow proxy");
  if (!higherTimeframeAgreement) guards.push("Micro and higher-timeframe structure are not aligned");
  if (regime === "INSUFFICIENT_DATA") guards.push("Insufficient live data");
  if (regime === "LOW_VOLATILITY") guards.push("Current realized volatility is too compressed for a clean risk-defined setup");
  if (primary.permutationEntropy > 0.96) guards.push("Directional entropy is too high; the tape is statistically noisy");
  if (dataFreshnessSeconds > input.timeframeSeconds * 3 + 120) guards.push("Latest Deriv candle is stale");

  const signal: IntelligenceSignal = guards.length === 0 && confidence >= 62 && modelDirection !== "NO_TRADE" ? modelDirection : "NO_TRADE";
  const entry = primary.price;
  const volatilityDistance = Math.max(entry * Math.abs(primary.realizedVolatilityPercent) / 100 * 2.2, entry * 0.0001);
  const structuralDistance = signal === "BUY" ? entry - primary.support : primary.resistance - entry;
  const stopDistance = signal === "NO_TRADE" ? 0 : Math.max(volatilityDistance, Math.min(Math.max(structuralDistance, volatilityDistance), volatilityDistance * 3));
  const stopLoss = signal === "BUY" ? entry - stopDistance : signal === "SELL" ? entry + stopDistance : null;
  const takeProfit = signal === "BUY" ? entry + Math.max(stopDistance * 2, primary.resistance > entry ? primary.resistance - entry : 0) : signal === "SELL" ? entry - Math.max(stopDistance * 2, primary.support < entry ? entry - primary.support : 0) : null;
  const expectedDurationSeconds = input.timeframeSeconds * (regime === "TREND" ? 4 : 2);
  const validitySeconds = input.timeframeSeconds * (regime === "HIGH_VOLATILITY" ? 2 : 3);
  const balance = Math.max(0, input.balance);
  const riskPercent = clamp(Number.isFinite(input.riskPercent) ? input.riskPercent : 0.5, 0.1, 2);
  const unitsPerLot = input.unitsPerLot && input.unitsPerLot > 0 ? input.unitsPerLot : defaultUnitsPerLot(input.symbol);
  const riskAmount = balance * riskPercent / 100;
  const recommendedLotSize = signal === "NO_TRADE" || !stopDistance ? 0 : round(riskAmount / (stopDistance * unitsPerLot), 4);
  const positionSizing: PositionSizing = {
    balance: round(balance, 2),
    riskPercent: round(riskPercent, 2),
    riskAmount: round(riskAmount, 2),
    stopDistance: round(stopDistance),
    takeProfitDistance: round(stopDistance * 2),
    unitsPerLot,
    recommendedLotSize,
    formula: "lots = (balance × risk%) ÷ (stop distance × units per lot)",
    basis: "indicative",
  };
  const steps = Math.max(2, Math.round(expectedDurationSeconds / input.timeframeSeconds));
  const mc = signal === "NO_TRADE" ? { paths: 0, steps, tpBeforeSl: 0, slBeforeTp: 0, neither: 1, method: "Not run because advanced guardrails did not promote a live signal" } : monteCarlo(input.candles, signal, entry, stopLoss!, takeProfit!, steps);
  const modelProbability = signal === "NO_TRADE" ? 0 : mc.tpBeforeSl;
  const rationale = [
    `${strategies.filter((strategy) => strategy.stance === signal).length} of ${strategies.length} advanced modules point ${signal === "NO_TRADE" ? "away from a trade" : signal}`,
    `Structure: macro ${primary.macroStructure}, micro ${primary.microStructure}; BOS ${primary.breakOfStructure}; CHoCH ${primary.changeOfCharacter}`,
    `Realized volatility ${primary.realizedVolatilityPercent.toFixed(4)}%; Hurst ${primary.hurstExponent.toFixed(2)}; entropy ${primary.permutationEntropy.toFixed(2)}`,
    signal === "NO_TRADE" ? "Capital is preserved when structure, order-flow proxy, probability, and timeframe guards disagree" : `Entry and risk levels are derived from liquidity structure and realized volatility with minimum 1:2 R:R`,
  ];
  const generatedAt = new Date().toISOString();
  return {
    id: `${input.symbol.symbol}-${input.timeframeSeconds}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    generatedAt,
    feed: "DERIV_LIVE",
    symbol: input.symbol.symbol,
    displayName: input.symbol.displayName,
    category: input.symbol.category,
    timeframeSeconds: input.timeframeSeconds,
    timeframeLabel: timeframeLabel(input.timeframeSeconds),
    higherTimeframeSeconds: input.higherTimeframeSeconds,
    higherTimeframeLabel: timeframeLabel(input.higherTimeframeSeconds),
    signal,
    confidence,
    modelProbability: round(modelProbability, 3),
    dataFreshnessSeconds,
    validUntil: new Date(Date.now() + validitySeconds * 1000).toISOString(),
    expectedDurationSeconds,
    entry: round(entry),
    stopLoss: stopLoss == null ? null : round(stopLoss),
    takeProfit: takeProfit == null ? null : round(takeProfit),
    riskReward: signal === "NO_TRADE" ? null : round(
      (signal === "BUY" ? takeProfit! - entry : entry - takeProfit!) /
      Math.max(signal === "BUY" ? entry - stopLoss! : stopLoss! - entry, 1e-12),
      2,
    ),
    positionSizing,
    regime,
    higherTimeframeBias,
    higherTimeframeAgreement,
    analytics: primary,
    higherAnalytics: higher,
    markov: markovSnapshot,
    monteCarlo: mc,
    strategies,
    guards,
    rationale,
    outcome: signal === "NO_TRADE" ? "UNVERIFIED" : "OPEN",
    outcomeAt: null,
    outcomePrice: null,
    liveDataOnly: true,
    execution: "SIGNAL_ONLY",
  };
}

export function evaluateSignalOutcome(signal: MarketIntelligenceResult, candles: LiveCandle[]): MarketIntelligenceResult {
  if (signal.signal === "NO_TRADE" || signal.outcome !== "OPEN") return signal;
  const since = candles.filter((candle) => candle.epoch > Math.floor(new Date(signal.generatedAt).getTime() / 1000));
  if (!since.length) {
    if (Date.now() > new Date(signal.validUntil).getTime()) return { ...signal, outcome: "EXPIRED", outcomeAt: new Date().toISOString(), outcomePrice: candles[candles.length - 1]?.close ?? null };
    return signal;
  }
  const hitTp = signal.signal === "BUY" ? since.some((candle) => candle.high >= (signal.takeProfit ?? Number.POSITIVE_INFINITY)) : since.some((candle) => candle.low <= (signal.takeProfit ?? Number.NEGATIVE_INFINITY));
  const hitSl = signal.signal === "BUY" ? since.some((candle) => candle.low <= (signal.stopLoss ?? Number.NEGATIVE_INFINITY)) : since.some((candle) => candle.high >= (signal.stopLoss ?? Number.POSITIVE_INFINITY));
  const outcome: IntelligenceOutcome = hitTp && hitSl ? "AMBIGUOUS" : hitTp ? "TP" : hitSl ? "SL" : Date.now() > new Date(signal.validUntil).getTime() ? "EXPIRED" : "OPEN";
  return outcome === "OPEN" ? signal : { ...signal, outcome, outcomeAt: new Date().toISOString(), outcomePrice: candles[candles.length - 1]?.close ?? null };
}
