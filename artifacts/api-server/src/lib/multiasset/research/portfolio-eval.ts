/**
 * WP8 — the study that measures what the portfolio layer actually does to a book
 * whose structure is KNOWN, on the same synthetic corpora the rest of the
 * programme uses.
 *
 * ── WHAT IS MEASURED, AND WHY THE BOOK HAS TO BE CONSTRUCTED ────────────────
 *
 * An estimator of correlation cannot be judged against a market's coincidental
 * correlation, because there is no ground truth in it. So the companion
 * instruments are built from the primary's own returns as
 * `r_c = ρ·r_p + √(1 − ρ²)·ε` with a sum-of-four-uniforms draw for ε (finite
 * fourth moment, so no single draw can dominate a covariance), and the
 * instrument that is supposed to stay uncorrelated gets its OWN noise stream —
 * drawing both from one array, even with an offset, would have made the fixture
 * correlate them and the study would have measured its own bug.
 *
 * Two compositions are measured, because the layer does two different jobs:
 *   • the neighbour — a one-position book taking the correlated instrument;
 *   • the accumulation — six instruments offered one at a time, each sized by the
 *     layer against the book the layer itself accumulated. A book opened all at
 *     once is already over its ceilings before the first decision, so the only
 *     thing such a fixture can measure is the book's own heat and an eternal
 *     refusal.
 *
 * The equity path is walked over the realised R sequence the WP7 study's
 * simulator produced (`research/execution-eval.ts`) at the desk's own 0.35% cap,
 * with and without the drawdown scalar, and then over the same sequence mirrored
 * to all-losses — the scalar's worst case, and the only version a safety gate can
 * hold.
 *
 * ── WHAT IS NOT MEASURED (AND IS SAID SO IN THE REPORT) ─────────────────────
 *
 *   • the Kelly term: it consumes the WP5 model's p_LCB, which this study does
 *     not fit, so the composition runs with `probabilityLowerBound: null` and the
 *     per-trade cap is the binding constraint. `wp8-portfolio.test.ts` covers the
 *     Kelly branch.
 */
import { CLOSE, makeRng } from "../math";
import {
  DAILY_CVAR_MAX_PCT,
  DD_SCALAR_FLOOR,
  PORTFOLIO_HEAT_MAX_PCT,
  PORTFOLIO_MAX_TRADE_RISK_PCT,
  correlationFromBars,
  correlationClusters,
  dailyCvarPct,
  drawdownScalar,
  portfolioDecision,
  portfolioHeatPct,
  type Matrix,
} from "../portfolio-risk";
import { barsFromReturns } from "./generators";
import { EXECUTION_STRIDE, EXECUTION_WARMUP, type GateRow } from "./execution-eval";
import type { Bar, SymbolSpec, TradeMode } from "../types";

/** Correlation the portfolio study builds its companion instrument at. */
export const PORTFOLIO_CORRELATION_TARGET = 0.85;

/** Bars of history the covariance is estimated from. */
export const PORTFOLIO_COVARIANCE_BARS = 120;

/** The drawdown floor the study reports (a number the reader should see). */
export const PORTFOLIO_DD_FLOOR = DD_SCALAR_FLOOR;

export interface PortfolioSeriesAssessment {
  fixture: string;
  mode: TradeMode;
  bars: number;
  measurements: {
    /** ρ̂ between the primary and the first companion (constructed at the target). */
    estimatedRho: number | null;
    /** ρ̂ between the primary and the instrument built to be independent. */
    independentRho: number | null;
    targetRho: number;
    /** Every cluster the estimator found over the whole book. */
    clusters: string[][];
    /** Scenario A: the candidate's own cluster contains the open position. */
    clusterCapturesNeighbour: number;
    /** Scenario B: the uncorrelated candidate's cluster contains nothing correlated. */
    clusterExcludesIndependent: number;
    /** Scenario A's cluster, as the layer itself labelled it. */
    neighbourCluster: string[];
    /** Scenario B's cluster, as the layer itself labelled it. */
    independentCluster: string[];
  };
  book: {
    decisions: number;
    /** Open positions the NAIVE desk would have accumulated (uncapped risk). */
    naivePositions: number;
    /** Open positions the LAYER accumulated, at the risk it allowed. */
    composedPositions: number;
    /** Candidates the layer refused outright. */
    refusedCandidates: number;
    /** Candidates offered to the layer over the whole accumulation. */
    candidateOffers: number;
    /** Candidates the layer allowed but shrank. */
    cappedCandidates: number;
    /** Worst book heat under each policy, on the same instrument set. */
    maxComposedBookHeatPct: number;
    maxNaiveBookHeatPct: number;
    maxComposedBookCvarPct: number;
    maxNaiveBookCvarPct: number;
    /** The risk the layer actually carried, per accepted candidate. */
    cappedRiskPctMean: number;
    /** How often each `PF_*` code fired — the journal's vocabulary. */
    codes: Record<string, number>;
  };
  drawdown: {
    /** The realised (signed) R sequence, as produced by the execution study. */
    maxDrawdownScaledPct: number;
    maxDrawdownFlatPct: number;
    floorScalar: number;
    /** The same sequence mirrored to all-losses: the scalar's worst case. */
    maxDrawdownMirrorScaledPct: number;
    maxDrawdownMirrorFlatPct: number;
    /** Worst ratio of the layer's risk to the flat cap over the path (must be ≤ 1). */
    maxRiskRatio: number;
    /** Realised trades the equity path was walked over. */
    trades: number;
  };
  gates: GateRow[];
}

/** How many correlated positions the modelled book holds before the candidate. */
const PORTFOLIO_OPEN_POSITIONS = 5;

/**
 * The portfolio layer's arithmetic against a book with a KNOWN structure.
 *
 * The companions are built from the primary's own returns with a linear mix —
 * `r_companion = ρ·r_primary + √(1−ρ²)·ε` — which is the textbook way to
 * construct a series with an exact target correlation, and the reason a
 * synthetic book can make a claim about an estimator at all. `ε` is a
 * sum-of-four-uniforms draw so its fourth moment is finite and no single draw
 * can dominate a covariance estimate. The last instrument gets its OWN noise
 * stream, so the study also measures that the estimator does NOT merge what is
 * not correlated — and that the heat ceiling still counts it, because heat is
 * correlation-weighted while the cluster ceiling is not.
 *
 * Two compositions are measured, because the layer does two different jobs:
 *
 *  - Scenario A — the candidate is the correlated neighbour, and the open book
 *    is one position. This is the doubling-the-same-bet case: the candidate has
 *    to land in the same cluster as the book.
 *  - Scenario B — the open book is `PORTFOLIO_OPEN_POSITIONS` correlated
 *    positions and the candidate is the independent instrument. This is the
 *    case where the ceilings bind: the same instruments at the desk's own
 *    per-trade cap already breach the heat and CVaR ceilings, and the layer has
 *    to shrink the candidate to fit. A book of two or three cannot show this —
 *    at 0.35% per trade and a 1.5% heat ceiling the ceilings only start to bind
 *    around five correlated positions, which is exactly the size this layer
 *    exists to bound.
 *
 * `probabilityLowerBound: null` is stated in the report: the Kelly term needs
 * the WP5 model and this study does not fit one, so the per-trade cap is the
 * binding constraint here. The Kelly branch is covered by wp8-portfolio.test.ts.
 */
export function assessPortfolioSeries(input: {
  bars: Bar[];
  spec: SymbolSpec;
  mode: TradeMode;
  symbol: string;
  fixture: string;
  trades: { r: number }[];
  seed?: number;
  stride?: number;
}): PortfolioSeriesAssessment {
  const { bars, mode, symbol } = input;
  const rng = makeRng(input.seed ?? 4242);
  const targetRho = PORTFOLIO_CORRELATION_TARGET;
  const stride = Math.max(1, input.stride ?? EXECUTION_STRIDE);

  // The book: the primary, PORTFOLIO_OPEN_POSITIONS correlated companions, and
  // one instrument built to be uncorrelated with the primary.
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const previous = (bars[i - 1] as Bar)[CLOSE] as number;
    const current = (bars[i] as Bar)[CLOSE] as number;
    returns.push(Math.log(current / previous));
  }
  const sd = Math.sqrt(returns.reduce((a, r) => a + r * r, 0) / Math.max(1, returns.length));
  const draw = (): number => ((rng() + rng() + rng() + rng() - 2) / 0.5773502691896257) * sd;
  const startMs = bars[0]?.[0] ?? 0;
  const timeframeMs = bars.length > 1 ? ((bars[1] as Bar)[0] as number) - startMs : 60_000;
  const startPrice = bars[0]?.[CLOSE] as number;
  const companionLabels = Array.from({ length: PORTFOLIO_OPEN_POSITIONS }, (_, i) => `${symbol}-C${i + 1}`);
  const independentLabel = `${symbol}-I`;
  const buildSeries = (label: string, returnSeries: number[]): { label: string; bars: Bar[] } => ({
    label,
    bars: barsFromReturns({ returns: returnSeries, startPrice: startPrice ?? 1, startMs, timeframeMs, volatility: 0.001 }),
  });
  const mixWith = (noise: number[]): number[] =>
    returns.map((r, i) => targetRho * r + Math.sqrt(1 - targetRho * targetRho) * (noise[i] as number));
  const built = correlationFromBars({
    series: [
      { label: symbol, bars },
      ...companionLabels.map((label) => buildSeries(label, mixWith(returns.map(() => draw())))),
      buildSeries(independentLabel, returns.map(() => draw())),
    ],
    count: PORTFOLIO_COVARIANCE_BARS,
  });
  const labels = built ? built.labels : [symbol];
  const estimatedRho = built ? ((built.correlation[0] as number[])[1] as number) : null;
  const independentRho = built
    ? ((built.correlation[0] as number[])[1 + PORTFOLIO_OPEN_POSITIONS] as number)
    : null;
  const clusters = built ? correlationClusters(built.correlation, built.labels) : [];
  const candidateCluster = (index: number): string[] => (built ? (clusters.find((group) => group.includes(labels[index] as string)) ?? []) : []);

  // The naive desk: every candidate is taken at the desk's own per-trade cap, no
  // ceilings at all. The layer: the same candidates, offered one at a time in
  // matrix order, each one sized by `portfolioDecision` against the book the
  // layer itself has accumulated. This is the only way to measure the ceilings
  // honestly: a book that is ALREADY over its ceilings (all positions opened at
  // once) can only be refused forever, and the number that comes out of it is the
  // book's own heat, not the layer's arithmetic.
  const naiveRiskPct = PORTFOLIO_MAX_TRADE_RISK_PCT;
  const naiveTotal = 1 + PORTFOLIO_OPEN_POSITIONS + 1;
  const maxPositions = naiveTotal - 1;

  const riskPctMeanFrom = (values: number[]): number => (values.length > 0 ? values.reduce((a, v) => a + v, 0) / values.length : 0);
  const subMatrix = (k: number): Matrix | null =>
    built ? Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (built.correlation[i] as number[])[j] as number)) : null;

  let decisions = 0;
  let refusedCandidates = 0;
  let cappedCandidates = 0;
  let candidateOffers = 0;
  let composedPositions = 0;
  let naivePositions = 0;
  let maxComposedBookHeat = 0;
  let maxNaiveBookHeat = 0;
  let maxComposedBookCvar = 0;
  let maxNaiveBookCvar = 0;
  let neighbourCluster: string[] = [];
  let independentCluster: string[] = [];
  let clusterCapturesNeighbour = 0;
  let clusterExcludesIndependent = 0;
  const cappedRisks: number[] = [];
  const codes: Record<string, number> = {};
  const tally = (list: string[]): void => {
    for (const code of list) codes[code] = (codes[code] ?? 0) + 1;
  };

  for (let i = EXECUTION_WARMUP; i < bars.length - 8; i += stride) {
    const correlation = built ? built.correlation : null;
    decisions++;
    // Scenario A — the candidate is the correlated neighbour of a one-position
    // book: the doubling-the-same-bet case.
    const neighbour = portfolioDecision({
      drawdownPct: 0,
      probabilityLowerBound: null,
      rewardRisk: 2,
      book: [{ symbol, riskPct: naiveRiskPct }],
      correlation,
      candidateIndex: built ? 1 : undefined,
      labels: built ? built.labels : undefined,
    });
    tally(neighbour.codes);
    if (i === EXECUTION_WARMUP) {
      neighbourCluster = neighbour.cluster ?? [];
      independentCluster = candidateCluster(1 + PORTFOLIO_OPEN_POSITIONS);
      clusterCapturesNeighbour = neighbourCluster.includes(symbol) ? 1 : 0;
      clusterExcludesIndependent = independentCluster.some((label) => label === symbol || companionLabels.includes(label))
        ? 0
        : 1;
    }
    // Scenario B — the accumulation: every instrument is offered in matrix order.
    const composedBook: { symbol: string; riskPct: number }[] = [];
    for (let k = 0; k < maxPositions; k++) {
      if (naivePositions < maxPositions) naivePositions++;
      if (!built) continue;
      const candidate = labels[k] as string;
      candidateOffers++;
      const decision = portfolioDecision({
        drawdownPct: 0,
        probabilityLowerBound: null,
        rewardRisk: 2,
        book: composedBook,
        correlation,
        candidateIndex: k,
        labels: built.labels,
      });
      tally(decision.codes);
      cappedRisks.push(decision.riskPct);
      if (decision.riskPct > 0) {
        if (decision.codes.includes("PF_HEAT") || decision.codes.includes("PF_CVAR") || decision.codes.includes("PF_CLUSTER")) {
          cappedCandidates++;
        }
        composedBook.push({ symbol: candidate, riskPct: decision.riskPct });
      } else {
        refusedCandidates++;
      }
      const composedSub = subMatrix(composedBook.length);
      if (composedSub) {
        const heat = portfolioHeatPct(composedBook.map((entry) => entry.riskPct), composedSub);
        const cvar = dailyCvarPct(composedBook.map((entry) => entry.riskPct), composedSub);
        if (heat !== null) maxComposedBookHeat = Math.max(maxComposedBookHeat, heat);
        if (cvar !== null) maxComposedBookCvar = Math.max(maxComposedBookCvar, cvar);
      }
    }
    composedPositions = Math.max(composedPositions, composedBook.length);
    if (built) {
      const naiveSub = subMatrix(maxPositions);
      if (naiveSub) {
        const naiveRisks = Array.from({ length: maxPositions }, () => naiveRiskPct);
        const heat = portfolioHeatPct(naiveRisks, naiveSub);
        const cvar = dailyCvarPct(naiveRisks, naiveSub);
        if (heat !== null) maxNaiveBookHeat = Math.max(maxNaiveBookHeat, heat);
        if (cvar !== null) maxNaiveBookCvar = Math.max(maxNaiveBookCvar, cvar);
      }
    }
  }

  // The drawdown scalar on the realised R sequence the execution study produced,
  // and on the same sequence mirrored to all-losses. The mirror is the scalar's
  // worst case and the one a safety gate can hold: on a PROFITABLE path a risk
  // scalar can leave a *larger percentage* drawdown behind, because the same
  // percentage is measured against an equity curve that grew more slowly — that
  // is arithmetic, not protection, and it is reported rather than gated.
  const walk = (rs: number[], scalarOn: boolean): { maxDd: number; floorScalar: number; maxRiskRatio: number } => {
    let equity = 10_000;
    let peak = equity;
    let maxDd = 0;
    let floor = 1;
    let maxRatio = 1;
    for (const r of rs) {
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      const scalar = scalarOn ? drawdownScalar(dd).scalar : 1;
      floor = Math.min(floor, scalar);
      maxRatio = Math.max(maxRatio, scalar);
      const risk = 10_000 * ((PORTFOLIO_MAX_TRADE_RISK_PCT * scalar) / 100);
      equity += r * risk;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
    }
    return { maxDd, floorScalar: floor, maxRiskRatio: maxRatio };
  };
  const realised = input.trades.map((trade) => trade.r);
  const mirrored = realised.map((r) => -Math.abs(r));
  const realisedFlat = walk(realised, false);
  const realisedScaled = walk(realised, true);
  const mirrorFlat = walk(mirrored, false);
  const mirrorScaled = walk(mirrored, true);
  const maxHeatNaive = maxNaiveBookHeat;
  const maxCvarNaive = maxNaiveBookCvar;
  const maxHeatCapped = maxComposedBookHeat;
  const maxCvarCapped = maxComposedBookCvar;
  const heatBinds = maxHeatNaive > PORTFOLIO_HEAT_MAX_PCT;
  const cvarBinds = maxCvarNaive > DAILY_CVAR_MAX_PCT;
  const cappedRiskPctMean = riskPctMeanFrom(cappedRisks);

  const gates: GateRow[] = portfolioGateRows({
    estimatedRho,
    independentRho,
    targetRho,
    clusters,
    neighbourCluster,
    independentCluster,
    clusterCapturesNeighbour,
    clusterExcludesIndependent,
    naiveTotal,
    naiveRiskPct,
    maxHeatNaive,
    maxHeatCapped,
    maxCvarNaive,
    maxCvarCapped,
    decisions,
    refusals: refusedCandidates,
    candidateOffers,
    tradeCount: input.trades.length,
    maxDdMirrorScaled: mirrorScaled.maxDd,
    maxDdMirrorFlat: mirrorFlat.maxDd,
    maxRiskRatio: realisedScaled.maxRiskRatio,
  });

  return {
    fixture: input.fixture,
    mode,
    bars: bars.length,
    measurements: {
      estimatedRho,
      independentRho,
      targetRho,
      clusters,
      clusterCapturesNeighbour,
      clusterExcludesIndependent,
      neighbourCluster,
      independentCluster,
    },
    book: {
      decisions,
      naivePositions: naiveTotal - 1,
      composedPositions,
      refusedCandidates,
      candidateOffers,
      cappedCandidates,
      maxComposedBookHeatPct: maxComposedBookHeat,
      maxNaiveBookHeatPct: maxNaiveBookHeat,
      maxComposedBookCvarPct: maxComposedBookCvar,
      maxNaiveBookCvarPct: maxNaiveBookCvar,
      cappedRiskPctMean,
      codes,
    },
    drawdown: {
      maxDrawdownScaledPct: realisedScaled.maxDd,
      maxDrawdownFlatPct: realisedFlat.maxDd,
      floorScalar: realisedScaled.floorScalar,
      maxDrawdownMirrorScaledPct: mirrorScaled.maxDd,
      maxDrawdownMirrorFlatPct: mirrorFlat.maxDd,
      maxRiskRatio: realisedScaled.maxRiskRatio,
      trades: input.trades.length,
    },
    gates,
  };
}

/** The gates the portfolio layer's two compositions are judged by. */
function portfolioGateRows(input: {
  estimatedRho: number | null;
  independentRho: number | null;
  targetRho: number;
  clusters: string[][];
  neighbourCluster: string[];
  independentCluster: string[];
  clusterCapturesNeighbour: number;
  clusterExcludesIndependent: number;
  naiveTotal: number;
  naiveRiskPct: number;
  maxHeatNaive: number;
  maxHeatCapped: number;
  maxCvarNaive: number;
  maxCvarCapped: number;
  decisions: number;
  refusals: number;
  candidateOffers: number;
  tradeCount: number;
  maxDdMirrorScaled: number;
  maxDdMirrorFlat: number;
  maxRiskRatio: number;
}): GateRow[] {
  const heatBinds = input.maxHeatNaive > PORTFOLIO_HEAT_MAX_PCT;
  const cvarBinds = input.maxCvarNaive > DAILY_CVAR_MAX_PCT;
  return [
    {
      code: "W8_COVARIANCE",
      label: "the estimator recovers a known correlation",
      pass: input.estimatedRho !== null && Math.abs(input.estimatedRho - input.targetRho) <= 0.15,
      value: input.estimatedRho,
      threshold: input.targetRho,
      detail: `constructed ρ = ${input.targetRho}, estimated ρ̂ = ${input.estimatedRho === null ? "unmeasurable" : input.estimatedRho.toFixed(4)} (tolerance ±0.15); the instrument built to be independent measures ${input.independentRho === null ? "n/a" : input.independentRho.toFixed(4)}`,
    },
    {
      code: "W8_CLUSTER",
      label: "a correlated neighbour is one bet, an uncorrelated one is not",
      pass: input.clusterCapturesNeighbour === 1 && input.clusterExcludesIndependent === 1,
      value: input.clusterCapturesNeighbour,
      threshold: 1,
      detail: `clusters ${input.clusters.map((group) => `[${group.join(" ")}]`).join(" ") || "none"}: the correlated candidate's cluster ${input.neighbourCluster.length > 0 ? `[${input.neighbourCluster.join(" ")}]` : "is empty"}${input.clusterCapturesNeighbour === 1 ? "" : " — MISSED"}, the independent candidate's cluster ${input.independentCluster.length > 0 ? `[${input.independentCluster.join(" ")}]` : "is empty"}${input.clusterExcludesIndependent === 1 ? "" : " — MERGED"}`,
    },
    {
      code: "W8_HEAT_CEILING",
      label: "the ceilings bind exactly when the uncapped book would breach them",
      pass: !heatBinds || input.maxHeatCapped <= PORTFOLIO_HEAT_MAX_PCT + 1e-9,
      value: input.maxHeatCapped,
      threshold: PORTFOLIO_HEAT_MAX_PCT,
      detail: `the modelled ${input.naiveTotal}-instrument book at a flat ${input.naiveRiskPct}% reaches heat ${input.maxHeatNaive.toFixed(4)}% (ceiling ${PORTFOLIO_HEAT_MAX_PCT}%, ${heatBinds ? "BINDS" : "does not bind"}); the composed book peaks at ${input.maxHeatCapped.toFixed(4)}%`,
    },
    {
      code: "W8_CVAR_REPORTED",
      label: "the CVaR ceiling is never breached silently",
      pass: input.maxCvarCapped <= DAILY_CVAR_MAX_PCT + 1e-9,
      value: input.maxCvarCapped,
      threshold: DAILY_CVAR_MAX_PCT,
      detail: `the same ${input.naiveTotal}-instrument book reaches parametric 95% CVaR ${input.maxCvarNaive.toFixed(4)}% (ceiling ${DAILY_CVAR_MAX_PCT}%, ${cvarBinds ? "BINDS" : "does not bind"}); the composed book peaks at ${input.maxCvarCapped.toFixed(4)}% (the trade is CUT to the largest size that fits, so the ceiling is reached rather than exceeded), refused ${input.refusals} of ${input.candidateOffers} candidate offers`,
    },
    {
      code: "W8_DRAWDOWN",
      label: "the scalar never raises the risk, and cuts the worst-case loss",
      pass: input.maxRiskRatio <= 1 + 1e-9 && input.maxDdMirrorScaled <= input.maxDdMirrorFlat + 1e-9,
      value: input.maxDdMirrorScaled,
      threshold: input.maxDdMirrorFlat,
      detail: `risk ratio peaked at ${input.maxRiskRatio.toFixed(4)}× the ${PORTFOLIO_MAX_TRADE_RISK_PCT}% cap (never above 1); on the mirrored all-losses sequence of ${input.tradeCount} trades the worst drawdown is ${input.maxDdMirrorScaled.toFixed(2)}% with the scalar vs ${input.maxDdMirrorFlat.toFixed(2)}% flat`,
    },
  ];
}

/** One fixture's pooled numbers across its independent series. */
export function summarisePortfolio(assessments: PortfolioSeriesAssessment[]): {
  decisions: number;
  estimatedRho: number | null;
  independentRho: number | null;
  clusterCapturesNeighbour: number;
  clusterExcludesIndependent: number;
  refusedCandidates: number;
  candidateOffers: number;
  composedPositions: number;
  cappedRiskPctMean: number;
  maxHeatCappedPct: number;
  maxHeatNaivePct: number;
  maxCvarCappedPct: number;
  maxCvarNaivePct: number;
  maxDrawdownScaledPct: number;
  maxDrawdownFlatPct: number;
  maxDrawdownMirrorScaledPct: number;
  maxDrawdownMirrorFlatPct: number;
  maxRiskRatio: number;
  codes: Record<string, number>;
  gates: GateRow[];
} {
  const n = Math.max(1, assessments.length);
  const mean = (values: number[]): number => values.reduce((a, v) => a + v, 0) / Math.max(1, values.length);
  const rhos = assessments.map((a) => a.measurements.estimatedRho).filter((v): v is number => v !== null);
  const independentRhos = assessments.map((a) => a.measurements.independentRho).filter((v): v is number => v !== null);
  const decisions = assessments.reduce((a, s) => a + s.book.decisions, 0);
  const refusals = assessments.reduce((a, s) => a + s.book.refusedCandidates, 0);
  const riskWeighted = assessments.reduce((a, s) => a + s.book.cappedRiskPctMean * s.book.decisions, 0);
  const codes: Record<string, number> = {};
  for (const assessment of assessments) {
    for (const [code, count] of Object.entries(assessment.book.codes)) codes[code] = (codes[code] ?? 0) + count;
  }
  const first = assessments[0];
  const pooled = {
    decisions,
    estimatedRho: rhos.length > 0 ? mean(rhos) : null,
    independentRho: independentRhos.length > 0 ? mean(independentRhos) : null,
    clusterCapturesNeighbour: Math.min(...assessments.map((a) => a.measurements.clusterCapturesNeighbour)),
    clusterExcludesIndependent: Math.min(...assessments.map((a) => a.measurements.clusterExcludesIndependent)),
    refusedCandidates: refusals,
    candidateOffers: assessments.reduce((a, s) => a + s.book.candidateOffers, 0),
    composedPositions: Math.max(...assessments.map((a) => a.book.composedPositions)),
    cappedRiskPctMean: decisions > 0 ? riskWeighted / decisions : 0,
    maxHeatCappedPct: Math.max(...assessments.map((a) => a.book.maxComposedBookHeatPct)),
    maxHeatNaivePct: Math.max(...assessments.map((a) => a.book.maxNaiveBookHeatPct)),
    maxCvarCappedPct: Math.max(...assessments.map((a) => a.book.maxComposedBookCvarPct)),
    maxCvarNaivePct: Math.max(...assessments.map((a) => a.book.maxNaiveBookCvarPct)),
    maxDrawdownScaledPct: Math.max(...assessments.map((a) => a.drawdown.maxDrawdownScaledPct)),
    maxDrawdownFlatPct: Math.max(...assessments.map((a) => a.drawdown.maxDrawdownFlatPct)),
    maxDrawdownMirrorScaledPct: Math.max(...assessments.map((a) => a.drawdown.maxDrawdownMirrorScaledPct)),
    maxDrawdownMirrorFlatPct: Math.max(...assessments.map((a) => a.drawdown.maxDrawdownMirrorFlatPct)),
    maxRiskRatio: Math.max(...assessments.map((a) => a.drawdown.maxRiskRatio)),
  };
  return {
    ...pooled,
    codes,
    gates: portfolioGateRows({
      estimatedRho: pooled.estimatedRho,
      independentRho: pooled.independentRho,
      targetRho: first?.measurements.targetRho ?? PORTFOLIO_CORRELATION_TARGET,
      clusters: first?.measurements.clusters ?? [],
      // The clusters printed are the first series' — the construction is identical
      // per series, and the pooled gate is on the WORST case of the detection flags.
      neighbourCluster: first?.measurements.neighbourCluster ?? [],
      independentCluster: first?.measurements.independentCluster ?? [],
      clusterCapturesNeighbour: pooled.clusterCapturesNeighbour,
      clusterExcludesIndependent: pooled.clusterExcludesIndependent,
      naiveTotal: (first?.book.naivePositions ?? 0) + 1,
      naiveRiskPct: PORTFOLIO_MAX_TRADE_RISK_PCT,
      maxHeatNaive: pooled.maxHeatNaivePct,
      maxHeatCapped: pooled.maxHeatCappedPct,
      maxCvarNaive: pooled.maxCvarNaivePct,
      maxCvarCapped: pooled.maxCvarCappedPct,
      decisions,
      refusals,
      candidateOffers: pooled.candidateOffers,
      tradeCount: first?.drawdown.trades ?? 0,
      maxDdMirrorScaled: pooled.maxDrawdownMirrorScaledPct,
      maxDdMirrorFlat: pooled.maxDrawdownMirrorFlatPct,
      maxRiskRatio: pooled.maxRiskRatio,
    }),
  };
}

/** Helpers the report renderer and the CLI share. */
export function portfolioGatesPass(gates: GateRow[]): boolean {
  return gates.every((gate) => gate.pass);
}
