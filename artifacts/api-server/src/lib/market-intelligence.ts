import type { LiveCandle, LiveMarketSymbol } from "./cfd-market-data";

export const INTELLIGENCE_TIMEFRAMES = [
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

export interface IndicatorSnapshot {
  price: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  macd: number;
  macdSignal: number;
  atr14: number;
  atrPercent: number;
  adx14: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerWidthPercent: number;
  support: number;
  resistance: number;
  returnMeanPercent: number;
  returnVolatilityPercent: number;
  returnZScore: number;
}

export interface MarkovSnapshot {
  sampleSize: number;
  upAfterUp: number;
  upAfterDown: number;
  nextUpProbability: number;
  nextDownProbability: number;
  state: "UP" | "DOWN" | "FLAT";
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
  indicators: IndicatorSnapshot;
  higherIndicators: IndicatorSnapshot;
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

function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.length ? slice.reduce((sum, value) => sum + value, 0) / slice.length : 0;
}

function stddev(values: number[], period: number): number {
  const slice = values.slice(-period);
  if (slice.length < 2) return 0;
  const mean = slice.reduce((sum, value) => sum + value, 0) / slice.length;
  return Math.sqrt(slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / slice.length);
}

function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) result = values[i] * k + result * (1 - k);
  return result;
}

function rsi(values: number[], period = 14): number {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function atr(candles: LiveCandle[], period = 14): number {
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const previousClose = candles[i - 1].close;
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - previousClose),
      Math.abs(candles[i].low - previousClose),
    ));
  }
  return sma(tr, period);
}

function adx(candles: LiveCandle[], period = 14): number {
  if (candles.length < period * 2 + 1) return 0;
  const trs: number[] = [];
  const plus: number[] = [];
  const minus: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    trs.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    plus.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minus.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const dx: number[] = [];
  for (let i = period; i < trs.length; i++) {
    const trSum = trs.slice(i - period + 1, i + 1).reduce((sum, value) => sum + value, 0) || 1e-12;
    const plusDi = 100 * plus.slice(i - period + 1, i + 1).reduce((sum, value) => sum + value, 0) / trSum;
    const minusDi = 100 * minus.slice(i - period + 1, i + 1).reduce((sum, value) => sum + value, 0) / trSum;
    dx.push(100 * Math.abs(plusDi - minusDi) / Math.max(plusDi + minusDi, 1e-12));
  }
  return clamp(sma(dx, period), 0, 100);
}

function macd(values: number[]): { value: number; signal: number } {
  if (!values.length) return { value: 0, signal: 0 };
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const point = fast - slow;
  // Rebuild the MACD line to calculate a genuine 9-period signal line.
  const line: number[] = [];
  for (let i = 26; i <= values.length; i++) line.push(ema(values.slice(0, i), 12) - ema(values.slice(0, i), 26));
  return { value: point, signal: ema(line, 9) };
}

function trueRangePercent(candles: LiveCandle[]): number {
  const latest = candles[candles.length - 1];
  return latest?.close ? (atr(candles) / latest.close) * 100 : 0;
}

function returns(candles: LiveCandle[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0) result.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  return result;
}

function calculateIndicators(candles: LiveCandle[]): IndicatorSnapshot {
  const closes = candles.map((candle) => candle.close);
  const latest = candles[candles.length - 1]?.close ?? 0;
  const volatility = stddev(closes, 20);
  const middle = sma(closes, 20);
  const atrValue = atr(candles);
  const recentReturns = returns(candles).slice(-100);
  const returnMean = recentReturns.length ? recentReturns.reduce((sum, value) => sum + value, 0) / recentReturns.length : 0;
  const returnVol = stddev(recentReturns, recentReturns.length);
  const latestReturn = recentReturns[recentReturns.length - 1] ?? 0;
  const recentSwing = candles.slice(-50);
  const macdValue = macd(closes);
  return {
    price: round(latest),
    ema20: round(ema(closes, 20)),
    ema50: round(ema(closes, 50)),
    ema200: round(ema(closes, 200)),
    rsi14: round(rsi(closes), 2),
    macd: round(macdValue.value),
    macdSignal: round(macdValue.signal),
    atr14: round(atrValue),
    atrPercent: round(trueRangePercent(candles), 4),
    adx14: round(adx(candles), 2),
    bollingerUpper: round(middle + volatility * 2),
    bollingerLower: round(middle - volatility * 2),
    bollingerWidthPercent: round(latest ? (volatility * 4 / latest) * 100 : 0, 4),
    support: round(Math.min(...recentSwing.map((candle) => candle.low))),
    resistance: round(Math.max(...recentSwing.map((candle) => candle.high))),
    returnMeanPercent: round(returnMean * 100, 5),
    returnVolatilityPercent: round(returnVol * 100, 5),
    returnZScore: round(returnVol > 0 ? (latestReturn - returnMean) / returnVol : 0, 3),
  };
}

function directionFromIndicators(indicators: IndicatorSnapshot): IntelligenceSignal {
  const bullish = indicators.ema20 > indicators.ema50 && indicators.ema50 >= indicators.ema200 && indicators.macd >= indicators.macdSignal;
  const bearish = indicators.ema20 < indicators.ema50 && indicators.ema50 <= indicators.ema200 && indicators.macd <= indicators.macdSignal;
  if (bullish) return "BUY";
  if (bearish) return "SELL";
  return "NO_TRADE";
}

function markov(candles: LiveCandle[]): MarkovSnapshot {
  const closes = candles.map((candle) => candle.close);
  const changes = closes.slice(1).map((close, index) => {
    const previous = closes[index];
    const relative = previous ? (close - previous) / previous : 0;
    return relative > 0.00005 ? 1 : relative < -0.00005 ? -1 : 0;
  }).slice(-200);
  let upAfterUp = 1, totalAfterUp = 2, upAfterDown = 1, totalAfterDown = 2;
  for (let i = 1; i < changes.length; i++) {
    if (changes[i - 1] === 1) {
      totalAfterUp++;
      if (changes[i] === 1) upAfterUp++;
    } else if (changes[i - 1] === -1) {
      totalAfterDown++;
      if (changes[i] === 1) upAfterDown++;
    }
  }
  const last = changes[changes.length - 1] ?? 0;
  const nextUpProbability = last === 1 ? upAfterUp / totalAfterUp : last === -1 ? upAfterDown / totalAfterDown : (upAfterUp + upAfterDown) / (totalAfterUp + totalAfterDown);
  const sampleSize = changes.filter((change) => change !== 0).length;
  const signal = nextUpProbability >= 0.56 ? "BUY" : nextUpProbability <= 0.44 ? "SELL" : "NO_TRADE";
  return {
    sampleSize,
    upAfterUp: round(upAfterUp / totalAfterUp, 3),
    upAfterDown: round(upAfterDown / totalAfterDown, 3),
    nextUpProbability: round(nextUpProbability, 3),
    nextDownProbability: round(1 - nextUpProbability, 3),
    state: last === 1 ? "UP" : last === -1 ? "DOWN" : "FLAT",
    signal,
  };
}

function monteCarlo(
  candles: LiveCandle[],
  side: "BUY" | "SELL",
  entry: number,
  stopLoss: number,
  takeProfit: number,
  steps: number,
  paths = 2000,
): MonteCarloSnapshot {
  const samples = returns(candles).slice(-240).filter((value) => Number.isFinite(value) && Math.abs(value) < 0.25);
  let tpBeforeSl = 0;
  let slBeforeTp = 0;
  let neither = 0;
  if (samples.length < 30 || !entry || !stopLoss || !takeProfit) {
    return { paths: 0, steps, tpBeforeSl: 0, slBeforeTp: 0, neither: 1, method: "Unavailable: fewer than 30 live return observations" };
  }
  for (let path = 0; path < paths; path++) {
    let price = entry;
    let outcome: "TP" | "SL" | null = null;
    for (let step = 0; step < steps; step++) {
      const sample = samples[Math.floor(Math.random() * samples.length)];
      price *= Math.exp(sample);
      if (side === "BUY") {
        if (price >= takeProfit) { outcome = "TP"; break; }
        if (price <= stopLoss) { outcome = "SL"; break; }
      } else {
        if (price <= takeProfit) { outcome = "TP"; break; }
        if (price >= stopLoss) { outcome = "SL"; break; }
      }
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
    method: "Bootstrap resampling of the latest live log returns; not a price forecast",
  };
}

function higherTimeframeBias(indicators: IndicatorSnapshot): IntelligenceSignal {
  const trend = indicators.ema20 - indicators.ema50;
  const longTrend = indicators.ema50 - indicators.ema200;
  if (trend > 0 && longTrend >= 0 && indicators.macd >= indicators.macdSignal) return "BUY";
  if (trend < 0 && longTrend <= 0 && indicators.macd <= indicators.macdSignal) return "SELL";
  return "NO_TRADE";
}

function defaultUnitsPerLot(symbol: LiveMarketSymbol): number {
  if (symbol.category === "forex") return 100_000;
  if (symbol.category === "commodities") return 100;
  return 1;
}

function formatDuration(seconds: number): string {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} day${seconds >= 172800 ? "s" : ""}`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} hour${seconds >= 7200 ? "s" : ""}`;
  return `${Math.round(seconds / 60)} minute${seconds >= 120 ? "s" : ""}`;
}

export function timeframeLabel(seconds: number): string {
  return INTELLIGENCE_TIMEFRAMES.find((timeframe) => timeframe.value === seconds)?.label ?? formatDuration(seconds);
}

export function higherTimeframeFor(seconds: number): number {
  if (seconds <= 300) return 900;
  if (seconds <= 900) return 3600;
  if (seconds <= 3600) return 14400;
  return 86400;
}

function buildStrategyVotes(
  indicators: IndicatorSnapshot,
  higher: IndicatorSnapshot,
  mk: MarkovSnapshot,
  regime: MarketIntelligenceResult["regime"],
): StrategyVote[] {
  const trend = indicators.ema20 > indicators.ema50 && indicators.ema50 >= indicators.ema200 ? "BUY" : indicators.ema20 < indicators.ema50 && indicators.ema50 <= indicators.ema200 ? "SELL" : "NO_TRADE";
  const momentum = indicators.macd > indicators.macdSignal && indicators.rsi14 < 72 ? "BUY" : indicators.macd < indicators.macdSignal && indicators.rsi14 > 28 ? "SELL" : "NO_TRADE";
  const meanReversion = indicators.rsi14 <= 30 && indicators.price <= indicators.bollingerLower ? "BUY" : indicators.rsi14 >= 70 && indicators.price >= indicators.bollingerUpper ? "SELL" : "NO_TRADE";
  const breakout = indicators.price > indicators.resistance - indicators.atr14 * 0.15 ? "BUY" : indicators.price < indicators.support + indicators.atr14 * 0.15 ? "SELL" : "NO_TRADE";
  const statistical = indicators.returnZScore < -1.2 ? "BUY" : indicators.returnZScore > 1.2 ? "SELL" : "NO_TRADE";
  const votes: StrategyVote[] = [
    { name: "Multi-timeframe trend", stance: higherTimeframeBias(higher), score: 100, weight: 0.24, evidence: `Higher timeframe bias: ${higherTimeframeBias(higher)}` },
    { name: "EMA structure", stance: trend, score: clamp(Math.abs(indicators.ema20 - indicators.ema50) / Math.max(indicators.atr14, 1e-12) * 20, 0, 100), weight: 0.18, evidence: `EMA20 ${trend === "BUY" ? "above" : trend === "SELL" ? "below" : "not aligned with"} EMA50/200` },
    { name: "MACD momentum", stance: momentum, score: clamp(Math.abs(indicators.macd - indicators.macdSignal) / Math.max(indicators.atr14, 1e-12) * 100, 0, 100), weight: 0.16, evidence: `MACD ${momentum === "BUY" ? "positive" : momentum === "SELL" ? "negative" : "mixed"}; RSI ${indicators.rsi14.toFixed(1)}` },
    { name: "RSI / Bollinger mean reversion", stance: meanReversion, score: meanReversion === "NO_TRADE" ? 0 : 80, weight: 0.12, evidence: `RSI ${indicators.rsi14.toFixed(1)} and price location versus bands` },
    { name: "Market structure breakout", stance: breakout, score: breakout === "NO_TRADE" ? 0 : 75, weight: 0.12, evidence: `Range ${round(indicators.support)} — ${round(indicators.resistance)}` },
    { name: "Markov transition", stance: mk.signal, score: Math.abs(mk.nextUpProbability - 0.5) * 200, weight: 0.10, evidence: `${(mk.nextUpProbability * 100).toFixed(1)}% next-up probability from ${mk.sampleSize} live states` },
    { name: "Statistical return edge", stance: statistical, score: clamp(Math.abs(indicators.returnZScore) * 35, 0, 100), weight: 0.08, evidence: `Latest return z-score ${indicators.returnZScore.toFixed(2)}` },
  ];
  return votes.map((vote) => ({ ...vote, score: round(vote.score, 1), evidence: regime === "RANGE" && vote.name === "Market structure breakout" ? `${vote.evidence}; range regime reduces breakout weight` : vote.evidence }));
}

export function analyzeLiveMarket(input: IntelligenceInput): MarketIntelligenceResult {
  const minRequired = 220;
  const indicators = calculateIndicators(input.candles);
  const higherIndicators = calculateIndicators(input.higherCandles);
  const dataFreshnessSeconds = Math.max(0, Math.round(Date.now() / 1000 - input.candles[input.candles.length - 1].epoch));
  const regime: MarketIntelligenceResult["regime"] = input.candles.length < minRequired
    ? "INSUFFICIENT_DATA"
    : indicators.adx14 >= 25 && indicators.atrPercent >= 0.35
      ? "HIGH_VOLATILITY"
      : indicators.adx14 >= 22
        ? "TREND"
        : indicators.atrPercent <= 0.08
          ? "LOW_VOLATILITY"
          : "RANGE";
  const markovSnapshot = markov(input.candles);
  const higherBias = higherTimeframeBias(higherIndicators);
  const strategies = buildStrategyVotes(indicators, higherIndicators, markovSnapshot, regime);
  const buyScore = strategies.reduce((sum, vote) => sum + (vote.stance === "BUY" ? vote.weight * Math.max(vote.score, 35) : vote.stance === "SELL" ? -vote.weight * Math.max(vote.score, 35) : 0), 0);
  const rawScore = clamp(50 + buyScore, 0, 100);
  const trendDirection = directionFromIndicators(indicators);
  const modelDirection: IntelligenceSignal = rawScore >= 58 ? "BUY" : rawScore <= 42 ? "SELL" : trendDirection;
  const higherAgreement = modelDirection !== "NO_TRADE" && higherBias === modelDirection;
  const confidence = round(clamp(50 + Math.abs(rawScore - 50) * 1.4 + (higherAgreement ? 8 : -10), 0, 99), 1);
  const guards: string[] = [];
  if (input.candles.length < minRequired) guards.push(`Need at least ${minRequired} live candles for the long EMA and walk-forward statistics`);
  if (!higherAgreement) guards.push("Primary and higher timeframe are not aligned; no signal is promoted");
  if (regime === "INSUFFICIENT_DATA") guards.push("Insufficient live data");
  if (regime === "LOW_VOLATILITY") guards.push("Volatility is too low for a clean risk-defined setup");
  if (markovSnapshot.sampleSize < 30) guards.push("Markov state sample is below the 30-observation minimum");
  if (dataFreshnessSeconds > input.timeframeSeconds * 3 + 120) guards.push("Latest Deriv candle is stale");

  const signal: IntelligenceSignal =
    guards.length === 0 && confidence >= 60 && modelDirection !== "NO_TRADE" && (regime === "TREND" || regime === "HIGH_VOLATILITY" || regime === "RANGE")
      ? modelDirection
      : "NO_TRADE";
  const entry = indicators.price;
  const atrDistance = Math.max(indicators.atr14 * 1.25, entry * 0.0001);
  const swingDistance = signal === "BUY" ? entry - indicators.support : indicators.resistance - entry;
  const stopDistance = signal === "NO_TRADE" ? 0 : Math.max(atrDistance, Math.min(Math.max(swingDistance, atrDistance), atrDistance * 3));
  const stopLoss = signal === "BUY" ? entry - stopDistance : signal === "SELL" ? entry + stopDistance : null;
  const takeProfit = signal === "BUY" ? entry + stopDistance * 2 : signal === "SELL" ? entry - stopDistance * 2 : null;
  const expectedDurationSeconds = input.timeframeSeconds * (regime === "TREND" ? 4 : 2);
  const validitySeconds = input.timeframeSeconds * (regime === "HIGH_VOLATILITY" ? 2 : 3);
  const riskPercent = clamp(Number.isFinite(input.riskPercent) ? input.riskPercent : 0.5, 0.1, 2);
  const balance = Math.max(0, input.balance);
  const unitsPerLot = input.unitsPerLot && input.unitsPerLot > 0 ? input.unitsPerLot : defaultUnitsPerLot(input.symbol);
  const riskAmount = balance * (riskPercent / 100);
  const recommendedLotSize = signal === "NO_TRADE" || !stopDistance || !unitsPerLot ? 0 : round(riskAmount / (stopDistance * unitsPerLot), 4);
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
  const mc = signal === "NO_TRADE" ? { paths: 0, steps, tpBeforeSl: 0, slBeforeTp: 0, neither: 1, method: "Not run because the ensemble did not promote a live signal" } : monteCarlo(input.candles, signal, entry, stopLoss!, takeProfit!, steps);
  const modelProbability = signal === "BUY" ? mc.tpBeforeSl : signal === "SELL" ? mc.tpBeforeSl : 0;
  const rationale = [
    `${strategies.filter((strategy) => strategy.stance === signal).length} of ${strategies.length} live-data strategy modules point ${signal === "NO_TRADE" ? "away from a trade" : signal}`,
    `Regime: ${regime}; ADX ${indicators.adx14.toFixed(1)}; ATR ${indicators.atrPercent.toFixed(3)}%`,
    `Higher timeframe ${timeframeLabel(input.higherTimeframeSeconds)} bias: ${higherBias}`,
    signal === "NO_TRADE" ? "Capital is preserved when timeframe, regime, or freshness guards disagree" : `Risk is defined at ${round(stopDistance)} with a minimum 1:2 reward-to-risk target`,
  ];
  const generatedAt = new Date().toISOString();
  return {
    id: `${input.symbol}-${input.timeframeSeconds}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    riskReward: signal === "NO_TRADE" ? null : 2,
    positionSizing,
    regime,
    higherTimeframeBias: higherBias,
    higherTimeframeAgreement: higherAgreement,
    indicators,
    higherIndicators,
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
  const hitTp = signal.signal === "BUY"
    ? since.some((candle) => candle.high >= (signal.takeProfit ?? Number.POSITIVE_INFINITY))
    : since.some((candle) => candle.low <= (signal.takeProfit ?? Number.NEGATIVE_INFINITY));
  const hitSl = signal.signal === "BUY"
    ? since.some((candle) => candle.low <= (signal.stopLoss ?? Number.NEGATIVE_INFINITY))
    : since.some((candle) => candle.high >= (signal.stopLoss ?? Number.POSITIVE_INFINITY));
  const outcome: IntelligenceOutcome = hitTp && hitSl ? "AMBIGUOUS" : hitTp ? "TP" : hitSl ? "SL" : Date.now() > new Date(signal.validUntil).getTime() ? "EXPIRED" : "OPEN";
  return outcome === "OPEN" ? signal : { ...signal, outcome, outcomeAt: new Date().toISOString(), outcomePrice: candles[candles.length - 1]?.close ?? null };
}
