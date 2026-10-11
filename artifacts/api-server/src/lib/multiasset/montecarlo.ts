/**
 * Multi-Asset Desk — Monte Carlo path simulation.
 *
 * This is the module that decides whether a setup is worth taking. Indicators
 * tell you a direction; only expectancy tells you whether the direction is
 * worth paying the spread for.
 *
 * For a candidate (entry, SL, TP) we simulate many price paths from the
 * current drift and volatility estimate and count how often TP is reached
 * before SL. That gives P(win), and from it:
 *
 *   E[R] = p·(reward/risk) − (1−p)·1 − costs/risk
 *
 * The agent refuses to arm a plan whose E[R] is not positive AFTER spread,
 * commission and expected slippage. That single rule is what separates this
 * from an indicator mashup.
 *
 * Simulation is bootstrapped from real returns when enough history exists
 * (preserving fat tails and volatility clustering) and falls back to GBM
 * otherwise. The RNG is seeded, so the same market state always produces the
 * same number — a flickering edge would be unusable in a terminal and
 * unrepeatable in a backtest.
 */

import { clamp, gaussian, makeRng, mean, stdev } from "./math";

export interface MonteCarloInput {
  entry: number;
  sl: number;
  tp: number;
  side: "buy" | "sell";
  /** Per-step log return mean (drift). */
  drift: number;
  /** Per-step log return standard deviation. */
  volatility: number;
  /** Maximum steps before the trade is abandoned (time stop). */
  horizon: number;
  /** Historical log returns to bootstrap from; GBM is used when too few. */
  returns?: number[];
  /** Round-trip cost in PRICE units (spread + commission + slippage). */
  costPrice?: number;
  paths?: number;
  seed?: number;
}

export interface MonteCarloResult {
  /** P(TP reached before SL within the horizon). */
  winProbability: number;
  /** P(SL reached first). */
  lossProbability: number;
  /** P(neither level reached — closed by the time stop). */
  timeoutProbability: number;
  /** Mean outcome of timed-out paths, expressed in R. */
  timeoutMeanR: number;
  /** Expectancy in R, net of costs. */
  expectancyR: number;
  /** Expectancy in R ignoring costs — the gross edge, for diagnostics. */
  grossExpectancyR: number;
  rewardRisk: number;
  /** Mean bars to resolution. */
  meanBarsToResolve: number;
  paths: number;
}

const MIN_BOOTSTRAP_SAMPLES = 60;

/**
 * Intrabar resolution. A path is simulated as a sequence of closes, but SL and
 * TP can both be touched inside one bar. We approximate the bar's range from
 * the step volatility and resolve conservatively: when both levels fall inside
 * the same simulated bar, the **stop is assumed to be hit first**.
 *
 * That pessimism is deliberate. The optimistic assumption inflates backtest
 * win rates and is the single most common reason a strategy that looked
 * profitable on paper loses money live.
 */
const INTRABAR_RANGE_MULT = 1.25;

export function simulateTrade(input: MonteCarloInput): MonteCarloResult {
  const {
    entry,
    sl,
    tp,
    side,
    drift,
    volatility,
    horizon,
    returns,
    costPrice = 0,
    paths = 4000,
    seed = 1,
  } = input;

  const riskPrice = Math.abs(entry - sl);
  const rewardPrice = Math.abs(tp - entry);
  const rewardRisk = riskPrice === 0 ? 0 : rewardPrice / riskPrice;

  // A degenerate plan (no stop distance) has no measurable edge by definition.
  if (riskPrice <= 0 || horizon <= 0) {
    return {
      winProbability: 0,
      lossProbability: 1,
      timeoutProbability: 0,
      timeoutMeanR: 0,
      expectancyR: -1,
      grossExpectancyR: -1,
      rewardRisk,
      meanBarsToResolve: 0,
      paths: 0,
    };
  }

  const rng = makeRng(seed);
  const useBootstrap = Array.isArray(returns) && returns.length >= MIN_BOOTSTRAP_SAMPLES;
  const sample = useBootstrap ? (returns as number[]) : [];
  // Re-centre bootstrap samples on the requested drift so the historical mean
  // does not silently override the model's directional view.
  const sampleMean = useBootstrap ? mean(sample) : 0;
  const sigma = volatility > 0 ? volatility : useBootstrap ? stdev(sample) : 0;

  // With no measurable volatility nothing can reach either level.
  if (sigma <= 0) {
    return {
      winProbability: 0,
      lossProbability: 0,
      timeoutProbability: 1,
      timeoutMeanR: 0,
      expectancyR: -costPrice / riskPrice,
      grossExpectancyR: 0,
      rewardRisk,
      meanBarsToResolve: horizon,
      paths: 0,
    };
  }

  const steps = Math.max(1, Math.floor(horizon));
  const long = side === "buy";
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let timeoutRSum = 0;
  let barsSum = 0;

  for (let p = 0; p < paths; p++) {
    let price = entry;
    let resolved = false;

    for (let s = 0; s < steps; s++) {
      const step = useBootstrap
        ? sample[Math.floor(rng() * sample.length)] - sampleMean + drift
        : drift + sigma * gaussian(rng);

      const prev = price;
      price = price * Math.exp(step);

      // Approximate the bar's extremes around the close-to-close move.
      const wick = Math.abs(price - prev) * INTRABAR_RANGE_MULT + prev * sigma * 0.5;
      const barHigh = Math.max(prev, price) + wick * 0.5;
      const barLow = Math.min(prev, price) - wick * 0.5;

      const hitTp = long ? barHigh >= tp : barLow <= tp;
      const hitSl = long ? barLow <= sl : barHigh >= sl;

      if (hitSl) {
        // Conservative tie-break: ambiguous bars are losses.
        losses++;
        barsSum += s + 1;
        resolved = true;
        break;
      }
      if (hitTp) {
        wins++;
        barsSum += s + 1;
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      timeouts++;
      barsSum += steps;
      const pnlPrice = long ? price - entry : entry - price;
      timeoutRSum += pnlPrice / riskPrice;
    }
  }

  const total = paths;
  const winProbability = wins / total;
  const lossProbability = losses / total;
  const timeoutProbability = timeouts / total;
  const timeoutMeanR = timeouts > 0 ? timeoutRSum / timeouts : 0;

  const grossExpectancyR =
    winProbability * rewardRisk - lossProbability * 1 + timeoutProbability * timeoutMeanR;
  const costR = costPrice / riskPrice;

  return {
    winProbability,
    lossProbability,
    timeoutProbability,
    timeoutMeanR,
    grossExpectancyR,
    expectancyR: grossExpectancyR - costR,
    rewardRisk,
    meanBarsToResolve: barsSum / total,
    paths: total,
  };
}

/**
 * Search a set of reward:risk multiples and return the best by expectancy.
 *
 * A fixed 1:2 target is arbitrary — the right target depends on volatility,
 * drift and cost. Letting the simulator choose is how the agent decides
 * between "bank it at 1R" and "let it run to 3R".
 */
export function bestTarget(
  base: Omit<MonteCarloInput, "tp">,
  multiples: number[] = [1, 1.5, 2, 2.5, 3, 4],
): { rewardRisk: number; tp: number; result: MonteCarloResult } | null {
  const risk = Math.abs(base.entry - base.sl);
  if (risk <= 0) return null;

  let best: { rewardRisk: number; tp: number; result: MonteCarloResult } | null = null;
  for (const m of multiples) {
    const tp = base.side === "buy" ? base.entry + risk * m : base.entry - risk * m;
    const result = simulateTrade({ ...base, tp });
    if (!best || result.expectancyR > best.result.expectancyR) {
      best = { rewardRisk: m, tp, result };
    }
  }
  return best;
}

/**
 * Probability that price retraces to `level` before reaching `target`.
 *
 * Used by the breakeven policy: moving the stop to entry is only free once
 * this is low. Doing it blindly at +1R is what turns winners into scratches.
 */
export function probabilityOfRetrace(input: {
  current: number;
  level: number;
  target: number;
  side: "buy" | "sell";
  drift: number;
  volatility: number;
  horizon: number;
  paths?: number;
  seed?: number;
}): number {
  const { current, level, target, side, drift, volatility, horizon } = input;
  const result = simulateTrade({
    entry: current,
    // Reaching `level` against us is the "loss" event here.
    sl: level,
    tp: target,
    side,
    drift,
    volatility,
    horizon,
    paths: input.paths ?? 2000,
    seed: input.seed ?? 7,
  });
  return clamp(result.lossProbability, 0, 1);
}

/**
 * Risk of ruin / drawdown profile for an equity curve of `trades` trades.
 *
 * This is what justifies the sizing cap, and what makes the martingale
 * argument concrete rather than rhetorical.
 */
export function equityCurveSimulation(input: {
  winProbability: number;
  rewardRisk: number;
  riskPct: number;
  trades: number;
  runs?: number;
  ruinDrawdownPct?: number;
  seed?: number;
  /** Multiplier applied to risk after each loss. 1 = flat, >1 = martingale. */
  lossMultiplier?: number;
  maxRiskPct?: number;
}): {
  medianReturnPct: number;
  meanMaxDrawdownPct: number;
  worstDrawdownPct: number;
  ruinProbability: number;
} {
  const {
    winProbability,
    rewardRisk,
    riskPct,
    trades,
    runs = 500,
    ruinDrawdownPct = 50,
    seed = 99,
    lossMultiplier = 1,
    maxRiskPct = 100,
  } = input;

  const rng = makeRng(seed);
  const finals: number[] = [];
  const drawdowns: number[] = [];
  let ruins = 0;

  for (let r = 0; r < runs; r++) {
    let equity = 100;
    let peak = 100;
    let maxDd = 0;
    let streakRisk = riskPct;
    let ruined = false;

    for (let t = 0; t < trades; t++) {
      const risk = Math.min(streakRisk, maxRiskPct);
      const stake = equity * (risk / 100);
      if (rng() < winProbability) {
        equity += stake * rewardRisk;
        streakRisk = riskPct;
      } else {
        equity -= stake;
        streakRisk = risk * lossMultiplier;
      }
      if (equity > peak) peak = equity;
      const dd = peak === 0 ? 0 : ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
      if (equity <= 0 || dd >= ruinDrawdownPct) {
        ruined = true;
        break;
      }
    }

    if (ruined) ruins++;
    finals.push(equity - 100);
    drawdowns.push(maxDd);
  }

  finals.sort((a, b) => a - b);
  return {
    medianReturnPct: finals[Math.floor(finals.length / 2)] ?? 0,
    meanMaxDrawdownPct: mean(drawdowns),
    worstDrawdownPct: Math.max(...drawdowns),
    ruinProbability: ruins / runs,
  };
}
