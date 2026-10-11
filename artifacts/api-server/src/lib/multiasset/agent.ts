/**
 * Re-exported so every existing caller keeps working. The definitions live in
 * `desk-constants.ts`, which depends on nothing (§ the file's header explains the
 * import cycle that made this necessary).
 */
export { ENTRY_TIMEFRAME, MIN_COST_COVERAGE, MIN_RR_FILL, STOP_ATR_MULT };

/**
 * Multi-Asset Desk — the agent.
 *
 * Pipeline, in order, with a veto at every stage:
 *
 *   candles ──▶ regime (per timeframe)
 *           ──▶ Markov persistence
 *           ──▶ multi-timeframe confluence  ─── direction + score
 *           ──▶ structural stop placement
 *           ──▶ Monte Carlo target search   ─── P(win), expectancy after costs
 *           ──▶ risk governor               ─── allowed? how much?
 *           ──▶ sizing engine               ─── lots from the broker's spec
 *           ──▶ ArmedPlan + ManagementPlan
 *
 * The output is never "buy now" — it is a plan with a trigger the EA watches
 * locally, so the decision survives the network round trip. And a no-trade is
 * a first-class result: it carries the reasons, which the terminal displays.
 */

import { randomUUID } from "node:crypto";
import { atr, clamp, closes, hashSeed, lastSwing, logReturns } from "./math";
import { fillSpreadGuard, slippageAllowancePoints } from "./asset-costs";
import {
  scoreConfluence,
  MODE_HORIZON_BARS,
  MODE_SCORE_THRESHOLD,
  type ConfluenceResult,
} from "./confluence";
import { buildEvidence, MODE_MIN_AGREEING_FAMILIES, type EvidenceResult } from "./evidence";
import { markovFromPrices, directionalPersistence, sampleConfidence } from "./markov";
import { betaPosterior, blendProbability, garchVolatility } from "./analytics";
import { assessRegime, isRegimeTradeable, type RegimeKind } from "./regime";
import { bestTarget, MIN_TARGET_R, simulateTrade, type MonteCarloResult } from "./montecarlo";
import { evaluateRisk, type RiskDecision, type RiskPolicy, type RiskState } from "./risk";
import { kellyFraction, pointValuePerLot, priceToPoints, sizePosition, type SizingResult } from "./sizing";
import { assessNewsGate, type NewsGate } from "./news";
import {
  ENTRY_TIMEFRAME,
  MIN_COST_COVERAGE,
  MIN_RR_FILL,
  STOP_ATR_MULT,
} from "./desk-constants";
import { deskV4, v4Live, v4On } from "./desk-v4-config";
import { DEFAULT_REGIME_HMM_CONFIG, regimePermit, type RegimePermit } from "./regime-hmm";
import { loadRegimeModel, persistRegimeModel, regimeModelVersion } from "./governance-runtime";
import { executedPolicyMonteCarlo } from "./montecarlo-v2";
import { metaViewAt } from "./meta/view";
import type { AlphaId } from "./alpha/types";
import type { MetaView } from "./meta/dataset";
import { metaPredictContext, predictMetaModel, type MetaModelSnapshot, type MetaModelPrediction } from "./meta/model";
import {
  gatekeeperDecision,
  gatekeeperRejections,
  type GatekeeperDecision,
} from "./meta/gatekeeper";
import {
  SLIPPAGE_MEASUREMENT_CEILING_MULT,
  createSlippageLedger,
  createSpreadHistory,
  createTimingLedger,
  executionDecision,
  executionRejections,
  measuredSlippageR,
  spreadHistoryFor,
  type ExecutionDecision,
  type SlippageLedger,
  type SpreadHistory,
  type TimingLedger,
} from "./execution";
import {
  drawdownFromPeak,
  portfolioDecision,
  type Matrix,
  type PortfolioDecision,
} from "./portfolio-risk";
import {
  MODE_ANALYSIS_TIMEFRAMES,
  ALL_TIMEFRAMES,
  TIMEFRAME_MINUTES,
  type AccountSnapshot,
  type ArmedPlan,
  type Bar,
  type ManagementPlan,
  type NewsFeed,
  type Position,
  type Quote,
  type SymbolSpec,
  type Timeframe,
  type TradeMode,
} from "./types";

/**
 * The WP7 ledgers, process-wide and bounded.
 *
 * They are the desk's memory of how its own fills and its own minutes have
 * behaved, so they must outlive a single decision — and they must not grow
 * without bound: minute-of-week has at most 10,080 keys and the slippage ledger
 * keeps the last 500 observations. Exported so the desk (and WP9's shadow
 * journal) can record a closed trade against the minute it was DECIDED in and a
 * fill against its plan.
 */
const timingLedger: TimingLedger = createTimingLedger();
const slippageLedger: SlippageLedger = createSlippageLedger();
const spreadHistory: SpreadHistory = createSpreadHistory();

export function getTimingLedger(): TimingLedger {
  return timingLedger;
}

export function getSlippageLedger(): SlippageLedger {
  return slippageLedger;
}

/**
 * The desk's own trailing spreads, fed from every accepted quote.
 *
 * The WP7 z-score is a comparison against "the spread this symbol usually
 * shows", and MT5 bars carry no spread column, so the only honest source is the
 * quotes the desk has received. The desk records them on the sync path; the
 * agent reads them here.
 */
export function getSpreadHistory(): SpreadHistory {
  return spreadHistory;
}

/**
 * Empty the three ledgers IN PLACE.
 *
 * The ledgers are deliberately process-wide (that is what makes a timing layer
 * a record of the desk's own behaviour), which also means one test's fills
 * would otherwise be the next test's history. This is the test seam — it is not
 * called from any production path, and it clears rather than replaces so every
 * existing handle (the routes' included) keeps pointing at the same object.
 */
export function resetExecutionLedgersForTests(): void {
  timingLedger.buckets.clear();
  timingLedger.pooled.wins = 0;
  timingLedger.pooled.losses = 0;
  timingLedger.pooled.rSum = 0;
  slippageLedger.ewmaR = null;
  slippageLedger.samples = 0;
  slippageLedger.observations.length = 0;
  spreadHistory.samples.clear();
}

export interface AgentInput {
  symbol: string;
  mode: TradeMode;
  spec: SymbolSpec;
  quote: Quote;
  series: Partial<Record<Timeframe, Bar[]>>;
  account: AccountSnapshot;
  positions: Position[];
  specs: Map<string, SymbolSpec>;
  riskState: RiskState;
  policy?: Partial<RiskPolicy>;
  /** MT5 high-impact calendar status. Missing/unavailable fails new entries closed. */
  news?: NewsFeed | null;
  now?: number;
  /** Minimum expectancy (in R, after costs) required to arm. */
  minEdgeR?: number;
  /**
   * Minimum Markov persistence of the favourable state over the horizon.
   * Defaults to 0 (advisory only) — see DEFAULT_MIN_PERSISTENCE.
   */
  minPersistence?: number;
  /**
   * Realised win/loss counts for this symbol and mode, used as the Beta prior
   * when blending the simulated win probability with what actually happens on
   * this desk. Absent means "no history yet", which leans entirely on the
   * simulation.
   */
  outcomes?: { wins: number; losses: number };
  /** Force the evidence ensemble's direction instead of inferring it. */
  direction?: "up" | "down";
  /**
   * The fitted WP5 meta-model the WP6 gatekeeper spends, if one is loaded.
   *
   * Supplied by the caller rather than read from a global registry: the decision
   * must be reproducible from its own inputs, and a desk that silently picks up
   * whatever model happens to be in memory is a desk whose record cannot be
   * audited. WP9 persists these (`desk_shadow_evaluations` / the calibrator
   * artifacts) and hands them in here. Absent or null means "no model", which the
   * gatekeeper turns into a refusal, never into a pass.
   */
  metaModel?: MetaModelSnapshot | null;
  /**
   * Recent spreads for THIS symbol and frame, oldest first — the window the
   * WP7 spread z-score is computed over. Omitted means the desk has no spread
   * history in front of it, which the execution layer reads as "no opinion"
   * rather than as a zero-variance history it would then divide by.
   */
  spreadHistory?: number[];
  /**
   * What kind of setup the caller believes this is. WP7 rests a LIMIT for a
   * pullback and stops in for a breakout; the default is the legacy breakout,
   * so the entry style can only change when a caller says the setup changed.
   */
  entrySetup?: "pullback" | "breakout";
  /**
   * The book's return correlation matrix, when the caller has one (labels must
   * line up with `positions`, the candidate appended last). Omitted ⇒ the WP8
   * layer reports that it cannot see the book and applies only the per-trade
   * ceiling — it does not invent a correlation of zero.
   */
  portfolioCorrelation?: { labels: string[]; matrix: Matrix } | null;
  /**
   * The WP9 governance overlay: agents the desk's own e-process has taken out of
   * service, and agents whose budget it has halved.
   *
   * Supplied by the caller (from `governance-runtime.ts`) rather than read from a
   * global here, for the same reason `metaModel` is: a decision must be
   * reproducible from its own inputs, and a decision whose agent list changed
   * because of a background refresh is a decision that cannot be replayed.
   *
   * Both directions are REDUCE-ONLY: a disabled agent's reading is removed from
   * the view (and its removal is recorded), and a halved agent's budget
   * multiplies the trade's risk by 0.5. Neither can add an agent or raise a
   * budget.
   */
  governance?: { disabledAgents: AlphaId[]; halvedAgents: AlphaId[] } | null;
}

export interface AgentDecision {
  symbol: string;
  mode: TradeMode;
  armed: boolean;
  plan: ArmedPlan | null;
  confluence: ConfluenceResult;
  /** The statistical evidence ensemble. Present whenever bars were available. */
  evidence: EvidenceResult | null;
  /** Blended confluence/evidence quality score actually gated on. */
  qualityScore: number;
  qualityThreshold: number;
  /**
   * Blended win probability and expectancy after costs, in R.
   *
   * These are the numbers the edge gate actually enforces (simulation blended
   * with the desk's realised history on this symbol). They are surfaced on the
   * decision so ranking engines — the automatic best-market pass and the
   * scanner — rank on precisely what was gated on, instead of re-deriving an
   * approximation from the raw simulation.
   */
  expectancyR: number | null;
  winProbability: number | null;
  monteCarlo: MonteCarloResult | null;
  sizing: SizingResult | null;
  risk: RiskDecision;
  /** Red-folder calendar gate evaluated with this decision. */
  news: NewsGate;
  /**
   * The frame the stop, the volatility and the horizon were measured on, and
   * that horizon in minutes. Reported so the terminal can never print a horizon
   * the analysis did not use (it used to print 12 x M2 = 24 min while the
   * simulation ran on S10 bars).
   */
  entryTimeframe: Timeframe | null;
  horizonMinutes: number | null;
  /** Round-trip cost as a fraction of the risk unit: `cost / |entry - sl|`. */
  costR: number | null;
  /** True when the structural stop was widened to keep the risk unit real. */
  stopWidened: boolean;
  /** Every gate that failed, in evaluation order. Shown verbatim in the UI. */
  rejections: string[];
  /** The WP7 execution and timing verdict, when the subsystem is enabled. */
  execution: ExecutionDecision | null;
  /** The WP8 portfolio budget, when the subsystem is enabled. */
  portfolio: PortfolioDecision | null;
  /**
   * The alpha agents that proposed this setup, AFTER the WP9 overlay.
   *
   * Before WP9 this was only reachable through `plan.rationale`; the governance
   * layer needs to charge an outcome to the exact agents that proposed it, and
   * the UI needs to show a user which detector produced the plan — so it is
   * reported here, in the decision's own inputs-to-outputs vocabulary, where it
   * cannot drift from what the gatekeeper actually saw.
   */
  alphaAgents: string[];
  /**
   * The probability LOWER BOUND the WP8 Kelly term sized against, when a WP5
   * model supplied one. Null means "no model", never "zero probability".
   */
  sizingProbabilityLowerBound: number | null;
  /**
   * The WP6 gatekeeper's verdict, when the subsystem is enabled.
   *
   * Null means the gatekeeper did not decide this plan — either because the
   * `DESK_V4_GATEKEEPER` flag is off (the legacy gates are then the whole
   * decision, exactly as before) or because evaluation stopped before reaching
   * it. Present-and-refusing is the interesting case: `codes` is machine-readable
   * and `reason` is the sentence a human reads, so a trade the desk did not take
   * is as auditable as one it did.
   */
  gatekeeper: GatekeeperDecision | null;
  /** Non-blocking cautions that were recorded but did not stop the trade. */
  warnings: string[];
  /** Short machine-readable summary for the signal log. */
  summary: string;
  evaluatedAt: number;
}







/**
 * ...and the stop may never be smaller than this many ATRs of the entry frame,
 * because a stop inside one average bar's range is taken out by noise rather
 * than by the market disagreeing with the idea.
 */
const MIN_RISK_ATR = 0.8;

/**
 * The smallest risk the adaptive sizer may choose, in percent of equity.
 *
 * Below this a position is no longer a position — the spread and the commission
 * dominate it outright. The ceiling lives in `risk.ts`
 * (`PER_TRADE_RISK_BUDGET_PCT`), because it is a desk-level policy.
 */
const MIN_TRADE_RISK_PCT = 0.05;

/**
 * How long an armed plan stays valid, per style.
 *
 * A scalp that has not filled in 60 seconds is no longer the setup that was
 * analysed — the micro-structure it depended on has already moved on.
 */
const PLAN_TTL_MS: Record<TradeMode, number> = {
  scalp: 60_000,
  intraday: 10 * 60_000,
  swing: 60 * 60_000,
};



/**
 * How much of the final quality score comes from the evidence ensemble rather
 * than from multi-timeframe confluence. The two measure different things —
 * confluence measures agreement across horizons, the ensemble measures the
 * balance of independent statistical evidence on the entry timeframe — so
 * neither alone should decide.
 */
const MODE_EVIDENCE_BLEND: Record<TradeMode, number> = {
  scalp: 0.55,
  intraday: 0.45,
  swing: 0.4,
};

export const DEFAULT_MIN_EDGE_R = 0.15;

/**
 * Markov persistence floor.
 *
 * ZERO BY DEFAULT — and that is the point. This used to be 0.55 and acted as a
 * hard veto, which meant a five-state chain fitted to a couple of hundred bars
 * could (and constantly did) overrule every other estimator in the pipeline.
 * Persistence is now one weighted vote among seven in evidence.ts; its
 * uncertainty is handled by shrinking its influence, not by letting it block.
 *
 * A caller that explicitly raises this value still gets the hard floor — that
 * is how the offline research harness isolates price logic from regime logic.
 */
export const DEFAULT_MIN_PERSISTENCE = 0;

/**
 * Resolution of the WP6 executed-policy Monte Carlo.
 *
 * Simulation SIZE, not a gate threshold: more paths buy a tighter tail estimate
 * and cost linear runtime. 200 paths x 25 trades x the mode's horizon is between
 * 60k and 240k labelled steps per decision — seconds, not minutes — and the
 * tail it reports is the 5th percentile of 200 per-path means rather than the
 * minimum of anything.
 */
const GATEKEEPER_MC_PATHS = 200;
const GATEKEEPER_MC_TRADES_PER_PATH = 25;

/** How many regime permits to keep. A per-decision HMM fit is the expensive part. */
const REGIME_PERMIT_MEMO_LIMIT = 64;
const regimePermitMemo = new Map<string, RegimePermit>();

/**
 * The WP3 regime permit for one candidate, memoised per (symbol, mode, frame,
 * bar, side).
 *
 * The permit is a pure function of its inputs, so a cache can never change a
 * verdict — it only stops the same HMM fit from being paid for twice when the
 * desk re-evaluates the same closed bar. Empty bars return null, which the
 * gatekeeper turns into GK_REGIME: a permit that could not be computed refuses.
 */
function gatekeeperRegimePermit(input: {
  symbol: string;
  mode: TradeMode;
  frame: Timeframe;
  bars: Bar[];
  side: "buy" | "sell";
}): RegimePermit | null {
  if (input.bars.length === 0) return null;
  const last = input.bars[input.bars.length - 1] as Bar;
  const key = [input.symbol, input.mode, input.frame, input.bars.length, last[0], input.side].join("|");
  const hit = regimePermitMemo.get(key);
  if (hit) return hit;
  const permit = regimePermit({ bars: input.bars, mode: input.mode, side: input.side });
  if (regimePermitMemo.size >= REGIME_PERMIT_MEMO_LIMIT) regimePermitMemo.clear();
  regimePermitMemo.set(key, permit);
  return permit;
}

/** The fitted model, cached by WINDOW IDENTITY (WP9's durable artifact reuse). */
const regimeModelCache = new Map<string, NonNullable<RegimePermit["model"]>>();

/**
 * The same permit, but reusing — and storing — the fitted model by window.
 *
 * ── WHY A STORED MODEL CANNOT CHANGE A DECISION ─────────────────────────────
 *
 * `fitHmm` is deterministic and seeded: a pure function of (features, config),
 * and the features are a pure function of the bars. A stored model whose version
 * key matches the CURRENT window is therefore the model this call would have
 * fitted — reusing it cannot move a permit, it can only stop the desk paying for
 * the same EM run on every restart. The version key is the identity of the
 * window (symbol, frame, fitBars, states, window length, last bar open time),
 * and a mismatch re-fits, so a window that has moved on can never be served a
 * stale model.
 */
function gatekeeperRegimePermitPersisted(input: {
  symbol: string;
  mode: TradeMode;
  frame: Timeframe;
  bars: Bar[];
  side: "buy" | "sell";
  fitBars: number;
  states: number;
}): RegimePermit | null {
  if (input.bars.length === 0) return null;
  const last = input.bars[input.bars.length - 1] as Bar;
  const windowLength = Math.min(input.bars.length, Math.max(input.fitBars, 60));
  const version = regimeModelVersion({
    symbol: input.symbol,
    frame: input.frame,
    fitBars: input.fitBars,
    states: input.states,
    windowLength,
    lastBarOpenMs: last[0] as number,
  });
  const cached = regimeModelCache.get(version);
  if (cached) {
    return regimePermit({ bars: input.bars, mode: input.mode, side: input.side, model: cached });
  }
  const permit = regimePermit({ bars: input.bars, mode: input.mode, side: input.side });
  if (permit.model) {
    // Bounded like the permit memo: one model per (symbol, frame, window).
    if (regimeModelCache.size >= REGIME_PERMIT_MEMO_LIMIT) regimeModelCache.clear();
    regimeModelCache.set(version, permit.model);
    void persistRegimeModel({
      symbol: input.symbol,
      frame: input.frame,
      version,
      model: permit.model,
      samples: permit.fit.bars,
      nowMs: last[0] as number,
    }).catch(() => {
      // Storing is best-effort: a model that cannot be written down is still a
      // model this process can use, and the desk is never blocked on the store.
    });
  }
  return permit;
}

/**
 * Warm the model cache from the durable store, out of band.
 *
 * Exported for the caller that wants the next decision on a window to avoid the
 * fit. It never blocks: the promise is not awaited on the decision path, and a
 * store that cannot be read simply means the desk fits the model itself.
 */
export function primeRegimeModelFromStore(input: {
  symbol: string;
  frame: string;
  fitBars: number;
  states: number;
  windowLength: number;
  lastBarOpenMs: number;
}): void {
  const version = regimeModelVersion(input);
  if (regimeModelCache.has(version)) return;
  void loadRegimeModel({ symbol: input.symbol, frame: input.frame, version })
    .then((model) => {
      if (model && !regimeModelCache.has(version)) regimeModelCache.set(version, model);
    })
    .catch(() => {});
}

/**
 * The per-series regime reading, kept between decisions so the meta-model's
 * `regimeDuration` feature means the same thing live as it did in training.
 *
 * The WP5 corpus counts a streak across consecutive DECISION bars; the shipped
 * study runs at stride 1, so a streak measured per closed bar is the same
 * statistic. Bounded like the permit memo, and keyed by series.
 */
const gatekeeperViewStates = new Map<string, { index: number; kind: RegimeKind | null; streak: number }>();

interface GatekeeperPredictionResult {
  prediction: MetaModelPrediction | null;
  /** The measured break-even rate, available even when the model is not. */
  breakEvenProbability: number | null;
  /** Why there is no prediction, in words, for the decision record. */
  note: string | undefined;
  /**
   * The WP4/WP5 view the prediction was built from, when one existed.
   *
   * Kept so the layers AFTER the gatekeeper can read the same evidence instead
   * of recomputing it: WP7's entry style asks whether a liquidity sweep is what
   * fired (a sweep rests a limit), and asking the view that already exists
   * cannot disagree with the prediction that was priced.
   */
  view: MetaView | null;
}

/**
 * The calibrated probability for this decision, or an honest explanation of why
 * there is none.
 *
 * The model is only asked about the question it was fitted on: the view must
 * point the same way as the plan (a model asked about a long setup when the
 * agents see a short one would answer confidently about the wrong thing), the
 * horizon must match the corpus's, and the ATR must be real. Every refusal is
 * named, because "no prediction" and "the model says the other direction" are
 * different facts about a trade.
 */
function gatekeeperPrediction(input: {
  snapshot: MetaModelSnapshot | null;
  bars: Bar[];
  symbol: string;
  mode: TradeMode;
  frame: Timeframe;
  spec: SymbolSpec;
  side: "buy" | "sell";
  spreadPrice: number;
  horizonBars: number;
  targetMultipleR: number;
}): GatekeeperPredictionResult {
  const snapshot = input.snapshot;
  if (!snapshot) {
    return { prediction: null, breakEvenProbability: null, note: "no fitted meta-model is loaded for this desk", view: null };
  }
  const breakeven = snapshot.cohort.breakEvenProbability;
  const index = input.bars.length - 1;
  if (index < 0) return { prediction: null, breakEvenProbability: breakeven, note: "there are no closed bars to read", view: null };
  const stateKey = [input.symbol, input.mode, input.frame].join("|");
  const built = metaViewAt({
    symbol: input.symbol,
    mode: input.mode,
    spec: input.spec,
    frame: input.frame,
    bars: input.bars,
    index,
    frameWidthMs: TIMEFRAME_MINUTES[input.frame] * 60_000,
    targetMultipleR: input.targetMultipleR,
    horizonBars: input.horizonBars,
    previous: gatekeeperViewStates.get(stateKey) ?? null,
  });
  if (!built) {
    // A decision bar with no view still advances the regime state: the streak is
    // a property of the decision sequence (the corpus the model was fitted on),
    // and an abstention breaks it.
    gatekeeperViewStates.set(stateKey, { index, kind: null, streak: 0 });
    return {
      prediction: null,
      breakEvenProbability: breakeven,
      note: "no alpha agent had a view on the decision bar",
      view: null,
    };
  }
  gatekeeperViewStates.set(stateKey, { index, kind: built.kind, streak: built.streak });
  const wanted = input.side === "buy" ? 1 : -1;
  if (built.view.direction !== wanted) {
    return {
      prediction: null,
      breakEvenProbability: breakeven,
      note: `the agents' view is ${built.view.direction === 1 ? "long" : "short"}, against this ${input.side} plan`,
      view: built.view,
    };
  }
  const ctx = metaPredictContext({ bars: input.bars, index, spreadPrice: input.spreadPrice });
  if (!ctx) {
    return { prediction: null, breakEvenProbability: breakeven, note: "the decision bar has no usable ATR yet", view: built.view };
  }
  const prediction = predictMetaModel(snapshot, built.view, ctx);
  if (!prediction) {
    return {
      prediction: null,
      breakEvenProbability: breakeven,
      note: "the loaded snapshot does not match this decision's mode, horizon or feature set",
      view: built.view,
    };
  }
  return { prediction, breakEvenProbability: prediction.breakEvenProbability, note: undefined, view: built.view };
}

/** Below this, persistence is surfaced as a caution rather than a failure. */
const PERSISTENCE_ADVISORY = 0.45;

/**
 * Resolve the series the evidence ensemble and the structural stop are built on.
 *
 * THE ENTRY FRAME COMES FIRST, AND THAT IS THE POINT.
 *
 * This used to prefer the frames the confluence had scored — fastest first — so
 * a scalp resolved its stop and its volatility off S10/S30 and an intraday book
 * off M5. The horizon, meanwhile, was always counted in bars of the mode's own
 * entry frame (M2 / M15 / H1). Two different clocks were therefore used to
 * build one trade:
 *
 *   stop      = 0.8 × ATR(S10)          → a few points on EURUSD
 *   horizon   = 12 bars of M2           → 24 minutes of price action
 *
 * so the stop sat inside the noise of the very horizon the trade was planned
 * over, the Monte Carlo resolved it as a near-certain loss, and the target
 * search then picked the least-bad multiple of a hopeless geometry (which is
 * how "A+ setup, R:R 4.0, win 11%" got printed). Worse, on FX it made the stop
 * smaller than the spread: the expectancy could never be anything but deeply
 * negative.
 *
 * Now the entry frame is the anchor. Missing or too-short frames are replaced
 * by their nearest neighbours — slower first, so a substitution widens the
 * stop rather than tightening it — and the frame actually used is reported on
 * the decision (`entryTimeframe`) with its horizon, so the terminal can never
 * claim a horizon the analysis did not use.
 */
function resolveEntrySeries(
  series: Partial<Record<Timeframe, Bar[]>>,
  mode: TradeMode,
): { timeframe: Timeframe; bars: Bar[] } | null {
  const preferred = ENTRY_TIMEFRAME[mode];
  const anchor = ALL_TIMEFRAMES.indexOf(preferred);
  const order = [...ALL_TIMEFRAMES]
    .map((timeframe, index) => ({ timeframe, index, distance: Math.abs(index - anchor) }))
    // Nearest first; on a tie take the SLOWER frame (a wider stop is safer).
    .sort((a, b) => a.distance - b.distance || b.index - a.index)
    .map((entry) => entry.timeframe);

  for (const timeframe of order) {
    const bars = series[timeframe];
    if (bars && bars.length >= MIN_ENTRY_BARS) return { timeframe, bars };
  }
  return null;
}

/** Bars the entry frame needs before a stop may be placed on it. */
const MIN_ENTRY_BARS = 30;

/**
 * Structural stop: beyond the last swing against the trade, with an ATR
 * buffer so ordinary noise does not reach it. Falls back to a pure ATR stop
 * when no swing is visible.
 *
 * Stops are placed where the idea is *wrong*, never at a round number of pips
 * chosen to make the lot size comfortable.
 */
export function structuralStop(
  bars: Bar[],
  side: "buy" | "sell",
  entry: number,
  mode: TradeMode,
): { sl: number; atrValue: number; usedSwing: boolean } {
  const atrValue = atr(bars, 14);
  const mult = STOP_ATR_MULT[mode];
  const buffer = atrValue * 0.25;

  const swing = lastSwing(bars, side === "buy" ? "low" : "high");
  if (swing && atrValue > 0) {
    const candidate = side === "buy" ? swing.price - buffer : swing.price + buffer;
    // THE SIDE IS CHECKED, NOT JUST THE DISTANCE.
    //
    // The last confirmed swing is not always on the correct side of the live
    // price: after a breakdown the most recent swing LOW sits ABOVE the market,
    // and for a buy that produced a "stop" above the entry. Because the guard
    // below only looked at |distance|, that placement passed and the plan was
    // handed to sizing, which refused it with "Stop loss … is on the wrong side
    // of entry … for a buy" — a whole analysis window thrown away on a stop
    // that could never have protected anything.
    //
    // `signed` is the distance in the direction the stop is supposed to be:
    // positive means the candidate is genuinely beyond the entry.
    const signed = side === "buy" ? entry - candidate : candidate - entry;
    const distance = Math.abs(signed);
    // Reject a swing that is on the wrong side, implausibly close, or far;
    // fall back to the ATR stop, which is correct by construction.
    if (signed > 0 && distance >= atrValue * 0.5 && distance <= atrValue * mult * 2.5) {
      return { sl: candidate, atrValue, usedSwing: true };
    }
  }

  const fallback = side === "buy" ? entry - atrValue * mult : entry + atrValue * mult;
  return { sl: fallback, atrValue, usedSwing: false };
}

/**
 * Build the management plan.
 *
 * Thresholds are regime-dependent, not fixed: a trending market is given room
 * and a trailing stop, a range is banked earlier at the band edge. Partial
 * ladders are feasibility-checked against the broker's volume step, because a
 * 50% close of 0.01 lots is not a legal order.
 */
export function buildManagementPlan(input: {
  spec: SymbolSpec;
  mode: TradeMode;
  lots: number;
  regimeKind: string;
  atrPoints: number;
  retraceProbability: number;
}): ManagementPlan {
  const { spec, mode, lots, regimeKind, atrPoints, retraceProbability } = input;
  const trending = regimeKind === "trend_up" || regimeKind === "trend_down";

  // A partial is only real if the remaining and closed slices are both legal
  // volumes. Otherwise the ladder silently fails at the broker.
  const step = spec.volumeStep > 0 ? spec.volumeStep : 0.01;
  const canSplit = (pct: number) => {
    const slice = lots * (pct / 100);
    const quantised = Math.floor(slice / step + 1e-9) * step;
    return quantised >= spec.volumeMin && lots - quantised >= spec.volumeMin;
  };

  const desired = trending
    ? [
        { atR: 1.5, closePct: 35 },
        { atR: 3.0, closePct: 25 },
      ]
    : [
        { atR: 1.0, closePct: 50 },
        { atR: 1.8, closePct: 25 },
      ];
  const partials = desired.filter((p) => canSplit(p.closePct));

  // Breakeven is only scheduled once the simulated probability of coming back
  // to entry is low. Blind BE-at-1R scratches winners on volatile symbols.
  const breakeven =
    retraceProbability <= 0.35
      ? { triggerR: trending ? 1.2 : 1.0, offsetR: 0.2, structureBuffer: true }
      : { triggerR: trending ? 1.8 : 1.5, offsetR: 0.1, structureBuffer: true };

  return {
    breakeven,
    partials,
    // Trail in trends (let winners run); hard TP in ranges.
    trail: trending
      ? {
          mode: "atr_chandelier",
          period: 14,
          mult: mode === "scalp" ? 2.0 : 2.5,
          activateAtR: 1.2,
          stepPoints: Math.max(5, Math.round(atrPoints * 0.1)),
        }
      : null,
    // Pyramiding is allowed only in a confirmed trend, only once the base is
    // risk-free, and never above the original portfolio risk budget.
    pyramid: trending
      ? {
          maxAdds: mode === "swing" ? 2 : 1,
          addAtR: 1.5,
          sizeRatio: 0.5,
          requireBaseAtBreakeven: true,
          portfolioRiskCapR: 1.5,
        }
      : null,
    timeStop: {
      noProgressBars: mode === "scalp" ? 15 : 25,
      timeframe: ENTRY_TIMEFRAME[mode],
    },
    guards: {
      // Derived from the asset class and the stop, exactly like the plan-level
      // guard the EA enforces, so the two can never disagree.
      maxSpreadPoints: fillSpreadGuard(spec, atrPoints * (STOP_ATR_MULT[mode] ?? 1), spec.spreadPoints),
      newsBlackoutMin: mode === "scalp" ? 10 : 15,
      flatBeforeSessionClose: mode !== "swing",
    },
  };
}

export function evaluate(input: AgentInput): AgentDecision {
  const now = input.now ?? Date.now();
  const minEdgeR = input.minEdgeR ?? DEFAULT_MIN_EDGE_R;
  const minPersistence = input.minPersistence ?? DEFAULT_MIN_PERSISTENCE;
  const rejections: string[] = [];
  const warnings: string[] = [];
  /** Filled by §5c when the WP6 gatekeeper is switched on. */
  let gatekeeper: GatekeeperDecision | null = null;
  /** The WP4/WP5 view §5c priced, kept for WP7's entry style. */
  let alphaView: MetaView | null = null;
  /**
   * The lower bound the WP8 sizing is allowed to use, filled by §5c.
   *
   * It is `null` whenever there is no fitted model — and the portfolio layer
   * reads a null probability as "no Kelly opinion", which is why the cap — not
   * the Kelly term — is what sizes the trade in that case. Sizing on a
   * probability that does not exist would be the exact failure p_LCB exists to
   * prevent.
   */
  let sizingProbabilityLowerBound: number | null = null;
  /** Filled by §5d when the WP7 execution agent is switched on. */
  let execution: ExecutionDecision | null = null;
  /** Filled by §7 when the WP8 portfolio layer is switched on. */
  let portfolio: PortfolioDecision | null = null;
  /** Set once the entry frame is resolved; reported on every decision. */
  let resolvedEntryFrame: Timeframe | null = null;

  /**
   * Build a no-trade decision.
   *
   * Declared as a hoisted function so the early exits can use it before the
   * evidence ensemble exists. `ev`/`score` are only resolved when supplied,
   * which keeps the pre-ensemble paths from touching values that are not
   * initialised yet.
   */
  function fail(
    extra: string[] = [],
    ev?: EvidenceResult | null,
    score?: number,
  ): AgentDecision {
    const usedEvidence = ev ?? null;
    const blend = MODE_EVIDENCE_BLEND[input.mode];
    const usedScore =
      score ??
      (usedEvidence && usedEvidence.direction !== "none"
        ? (1 - blend) * confluence.score + blend * usedEvidence.confidence
        : confluence.score);
    const usedThreshold = MODE_SCORE_THRESHOLD[input.mode] + risk.scoreBump;
    return {
      symbol: input.symbol,
      mode: input.mode,
      armed: false,
      gatekeeper,
      execution,
      portfolio,
      alphaAgents: [...(alphaView?.agents ?? [])],
      sizingProbabilityLowerBound,
      plan: null,
      confluence,
      evidence: usedEvidence,
      qualityScore: usedScore,
      qualityThreshold: usedThreshold,
      expectancyR: null,
      winProbability: null,
      monteCarlo: null,
      sizing: null,
      risk,
      news,
      // A no-trade decision still names the frame and horizon it would have
      // measured on, so the desk can explain itself.
      entryTimeframe: resolvedEntryFrame,
      horizonMinutes: resolvedEntryFrame
        ? MODE_HORIZON_BARS[input.mode] * TIMEFRAME_MINUTES[resolvedEntryFrame]
        : null,
      costR: null,
      stopWidened: false,
      rejections: [...rejections, ...extra],
      warnings,
      summary: `${input.symbol} ${input.mode}: no trade (quality ${usedScore.toFixed(0)}/${usedThreshold.toFixed(0)}).`,
      evaluatedAt: now,
    };
  }

  // ── 1. Risk governor first ────────────────────────────────────────────────
  // Running it before the analysis avoids burning CPU on a symbol that is
  // halted, suspended or over-exposed — and makes the reason the FIRST thing
  // the user sees rather than a footnote under a signal they cannot take.
  const risk = evaluateRisk({
    symbol: input.symbol,
    spec: input.spec,
    account: input.account,
    positions: input.positions,
    specs: input.specs,
    state: input.riskState,
    policy: input.policy,
    now,
  });
  rejections.push(...risk.breaches);

  // ── 2. Red-folder calendar ────────────────────────────────────────────────
  // The terminal's MT5 economic calendar is authoritative. An unavailable or
  // stale calendar is a safety failure, not a green light, so fresh entries
  // are paused until the terminal can confirm the event schedule again.
  // Pure-agent callers (unit tests and offline research) can omit `news` to
  // evaluate price logic in isolation. The live Desk always supplies its MT5
  // feed; an explicitly unavailable feed then fails closed below.
  const news = input.news === undefined
    ? { status: "clear" as const, blocked: false, reason: null, relevantEvents: [], checkedAt: now }
    : assessNewsGate(input.spec, input.news, input.mode, now);
  if (news.blocked && news.reason) rejections.push(news.reason);

  // ── 3. Multi-timeframe confluence ─────────────────────────────────────────
  const confluence = scoreConfluence({
    symbol: input.symbol,
    mode: input.mode,
    series: input.series,
    direction: input.direction,
  });

  // ── 3b. Entry timeframe, evidence ensemble ────────────────────────────────
  // The ensemble needs the entry series, so resolve it before scoring — and it
  // resolves to the MODE'S OWN ENTRY FRAME (M2 / M15 / H1), never to the
  // fastest frame the confluence happened to score. The stop, the volatility
  // and the horizon must all be measured on the same clock; see
  // `resolveEntrySeries`.
  const entrySeries = resolveEntrySeries(input.series, input.mode);
  if (!entrySeries) {
    return fail(["No timeframe has the 30+ bars needed to place a stop on this market."]);
  }
  resolvedEntryFrame = entrySeries.timeframe;
  const horizon = MODE_HORIZON_BARS[input.mode];
  const direction = confluence.direction === "none" ? undefined : confluence.direction;
  const evidence = buildEvidence({
    symbol: input.symbol,
    mode: input.mode,
    timeframe: entrySeries.timeframe,
    bars: entrySeries.bars,
    horizon,
    direction,
  });

  // Blend the two quality views. When the ensemble could not form a direction
  // we fall back to confluence alone rather than scoring zero evidence twice.
  const blendWeight = MODE_EVIDENCE_BLEND[input.mode];
  const evidenceUsable = evidence.direction !== "none";
  const effectiveDirection = confluence.direction !== "none" ? confluence.direction : evidence.direction;
  const qualityScore = evidenceUsable
    ? (1 - blendWeight) * confluence.score + blendWeight * evidence.confidence
    : confluence.score;
  const threshold = MODE_SCORE_THRESHOLD[input.mode] + risk.scoreBump;

  if (effectiveDirection === "none") {
    return fail(["No directional bias from either the timeframe band or the evidence ensemble."]);
  }

  // ── 3c. Quality gate ──────────────────────────────────────────────────────
  // Two independent conditions, neither of them a single-model veto:
  //   1. the blended score must clear the bar;
  //   2. enough *independent* families must agree — not all of them.
  if (qualityScore < threshold) {
    rejections.push(
      `Quality ${qualityScore.toFixed(1)} is below the ${threshold.toFixed(1)} required for a ${input.mode} entry ` +
        `(confluence ${confluence.score.toFixed(1)}, evidence ${evidenceUsable ? evidence.confidence.toFixed(1) : "n/a"}).`,
    );
  }

  if (evidenceUsable && evidence.agreeingFamilies < MODE_MIN_AGREEING_FAMILIES[input.mode]) {
    rejections.push(
      `Only ${evidence.agreeingFamilies} of ${evidence.totalFamilies} evidence families agree on ${effectiveDirection}; ` +
        `${MODE_MIN_AGREEING_FAMILIES[input.mode]} independent confirmations are required.`,
    );
  }

  // Higher-timeframe context is a WARNING now, never a block.
  if (!confluence.higherTimeframeAligned) {
    warnings.push(
      `Trading against context (${confluence.contextPenalty.toFixed(0)} point penalty applied): ` +
        `${confluence.warnings.filter((w) => w.includes("opposing")).join(" ") || "a higher timeframe leans the other way"}.`,
    );
  }

  const side = effectiveDirection === "up" ? "buy" : "sell";
  // Enter at the price we would actually pay, not the mid.
  const entry = side === "buy" ? input.quote.ask : input.quote.bid;
  if (!(entry > 0)) return fail(["No live quote for this symbol."]);

  // ── Cost, in price units, BEFORE the stop is accepted ─────────────────────
  //
  // THE LIVE SPREAD IS THE TRUTH, NOT THE SPEC'S CACHED COPY.
  //
  // `spec.spreadPoints` is refreshed on every heartbeat, so in the live Desk the
  // two agree — but the spread the fill will actually pay is the one on the
  // quote being analysed, and a plan armed on a calm tick must not be costed at
  // yesterday's spread. Anywhere the two differ, the quote wins.
  const liveSpreadPoints =
    input.quote.spreadPoints > 0 ? input.quote.spreadPoints : input.spec.spreadPoints;
  const specForSizing =
    liveSpreadPoints === input.spec.spreadPoints
      ? input.spec
      : { ...input.spec, spreadPoints: liveSpreadPoints };

  const pointValue = pointValuePerLot(input.spec);
  // The MODELLED allowance. D7 replaces it with the desk's measured one below,
  // once the risk unit exists to express that measurement in points.
  const modelledSlippagePoints = slippageAllowancePoints(input.spec, input.mode);
  let slippagePoints = modelledSlippagePoints;
  const commissionPoints = pointValue > 0 ? input.spec.commissionPerLot / pointValue : 0;
  // Spread crossed once, commission converted via point value, plus an
  // allowance for slippage. Slippage is scaled by asset class — a crypto CFD
  // does not fill like a major FX pair.
  let costPrice = (liveSpreadPoints + commissionPoints + slippagePoints) * input.spec.point;

  // ── 3d. Regime and stop ───────────────────────────────────────────────────
  const regime = assessRegime(entrySeries.bars);
  if (!isRegimeTradeable(regime.kind, input.mode)) {
    rejections.push(
      `${entrySeries.timeframe} regime is ${regime.kind} — not tradeable in ${input.mode} mode.`,
    );
  }

  const stop = structuralStop(entrySeries.bars, side, entry, input.mode);
  if (!(Math.abs(entry - stop.sl) > 0)) {
    return fail(["Stop placement produced a zero-distance stop (flat market)."]);
  }

  /**
   * THE RISK UNIT IS ENFORCED HERE, NOT ASSUMED.
   *
   * A stop closer than the round-trip cost makes "one R" smaller than the price
   * of getting in: the expectancy gate can then never be satisfied, on any
   * setup, however good — which is precisely what the desk was reporting on
   * every FX symbol. The stop is therefore widened to the larger of the two
   * floors below, and the widening is reported so it is never a silent change
   * of plan.
   *
   * Note what this does NOT do: it does not remove the spread from the trade.
   * The spread is still charged in the expectancy, in the sizing explanation and
   * at fill time. It simply stops being larger than the trade's own risk unit —
   * and, because the cost is now bounded inside R, the spread-ratio vetoes that
   * used to block these setups have nothing left to do (they are gone).
   */
  const minimumRiskPrice = Math.max(
    costPrice * MIN_COST_COVERAGE,
    stop.atrValue * MIN_RISK_ATR,
  );
  const structuralRiskPrice = Math.abs(entry - stop.sl);
  let sl = stop.sl;
  const riskWidened = structuralRiskPrice < minimumRiskPrice;
  if (riskWidened) {
    sl = side === "buy" ? entry - minimumRiskPrice : entry + minimumRiskPrice;
    warnings.push(
      `Stop widened from ${priceToPoints(input.spec, structuralRiskPrice).toFixed(0)} to ` +
        `${priceToPoints(input.spec, minimumRiskPrice).toFixed(0)} pts: a stop inside the ` +
        `${priceToPoints(input.spec, costPrice).toFixed(1)}-pt round-trip cost (or inside one ${entrySeries.timeframe} bar) ` +
        `is not a risk unit — it is the spread, charged twice.`,
    );
  }
  const riskPrice = Math.abs(entry - sl);

  // ── D7: the slippage allowance stops being an assumption ───────────────────
  //
  // The desk costed every trade with `slippageAllowancePoints` — a constant per
  // asset class, i.e. a guess. Once WP7's ledger has watched enough of the
  // desk's OWN fills, the guess is replaced by the measurement, and it is
  // replaced in ONE direction: the allowance is
  //
  //     max(modelled, measured),  capped at 3× the modelled allowance
  //
  // so a desk that has been filling BETTER than its allowance does not start
  // pricing its future fills as free, and a single catastrophic fill cannot
  // rewrite the cost basis for a week — slippage that bad pauses new entries
  // (see `slippagePause`), which is the proportionate response.
  //
  // Note the ordering: this runs AFTER the stop was widened to cover the
  // modelled cost (see MIN_COST_COVERAGE above), so re-pricing the cost here can
  // only make every later gate — expectancy, the gatekeeper's cost test, the
  // R:R floor measured from the fill — STRICTER. The stop is never narrowed by a
  // measurement.
  let slippagePointsMeasured = false;
  if (v4On(deskV4().execution)) {
    const measured = measuredSlippageR(slippageLedger);
    if (measured !== null && riskPrice > 0 && input.spec.point > 0) {
      const measuredPoints = (measured * riskPrice) / input.spec.point;
      const ceiling = modelledSlippagePoints * SLIPPAGE_MEASUREMENT_CEILING_MULT;
      const effective = Math.min(ceiling, Math.max(modelledSlippagePoints, measuredPoints));
      if (effective > slippagePoints) {
        slippagePoints = effective;
        slippagePointsMeasured = true;
        costPrice = (liveSpreadPoints + commissionPoints + slippagePoints) * input.spec.point;
      }
    }
  }

  const costR = riskPrice > 0 ? costPrice / riskPrice : 0;

  // ── 4. Markov persistence — one vote, not a veto ──────────────────────────
  const price = closes(entrySeries.bars);
  const model = markovFromPrices(price);
  const persistence = directionalPersistence(model, effectiveDirection, horizon);
  const modelConfidence = sampleConfidence(model);

  if (persistence < minPersistence) {
    rejections.push(
      `Markov persistence of the favourable state is ${(persistence * 100).toFixed(0)}% over ${horizon} bars, below the ${(minPersistence * 100).toFixed(0)}% floor.`,
    );
  } else if (persistence < PERSISTENCE_ADVISORY) {
    // Surfaced, not enforced: the ensemble already priced this in.
    warnings.push(
      `Markov persistence is only ${(persistence * 100).toFixed(0)}% over ${horizon} bars — carried by ${evidence.agreeingFamilies} other agreeing families.`,
    );
  }

  // ── 5. Monte Carlo target search ──────────────────────────────────────────
  const returns = logReturns(price);
  const seed = hashSeed(`${input.symbol}|${input.mode}|${entrySeries.timeframe}|${entrySeries.bars.length}`);

  // Volatility for the simulation: the regime's own step volatility, widened
  // toward the GARCH one-step-ahead estimate. Volatility clusters, and a
  // target searched on a calm day's sigma is a target that gets run over.
  const garchSigma = garchVolatility(returns);
  const simulationVolatility = Math.max(
    regime.stepVolatility,
    garchSigma > 0 ? Math.min(garchSigma, regime.stepVolatility * 2.5) : regime.stepVolatility,
  );

  /**
   * The FILL price the plan will actually get: the trigger plus slippage.
   *
   * `trigger` is defined below as a displacement from the quote in the trade's
   * own direction, so the fill is one more slippage allowance beyond it.
   * Everything that depends on the entry — the target multiples, the reward:risk
   * gate and the position size — is measured from here, not from the quote.
   */
  // The trigger is a small displacement beyond the current price in the trade
  // direction: the EA fires when the market confirms the move rather than at
  // whatever price happened to exist when the server finished thinking. It is
  // defined HERE — before the target search — because the fill it implies is
  // the price every reward:risk number below is measured from.
  const triggerOffset = stop.atrValue * (input.mode === "scalp" ? 0.08 : 0.12);
  const trigger = side === "buy" ? entry + triggerOffset : entry - triggerOffset;
  const slippagePrice = slippagePoints * input.spec.point;
  if (slippagePointsMeasured) {
    warnings.push(
      `The slippage allowance is MEASURED, not assumed: ${modelledSlippagePoints.toFixed(1)} pt modelled vs ${slippagePoints.toFixed(1)} pt from the desk's own realised fills (${slippageLedger.samples} fills EWMA ${(measuredSlippageR(slippageLedger) ?? 0).toFixed(3)}R). The fill this plan is measured from is the worse one.`,
    );
  }
  const expectedFill = side === "buy" ? trigger + slippagePrice : trigger - slippagePrice;

  const search = bestTarget({
    entry: expectedFill,
    // The RISK UNIT the gate is measured in — the widened stop, not the raw
    // structural one. Target multiples are searched off this distance.
    sl,
    side,
    // Blend the measured drift with the Markov view, scaled by how much data
    // backs the model. With little history the simulation leans on raw drift.
    drift: regime.drift * (0.5 + 0.5 * modelConfidence),
    volatility: simulationVolatility,
    horizon,
    returns,
    costPrice,
    paths: 3000,
    seed,
  });

  if (!search) return fail(["Monte Carlo could not evaluate this setup."]);
  const monteCarlo = search.result;

  // ── 5a. HARD REWARD:RISK FLOOR, AT THE EXPECTED FILL ──────────────────────
  // `search.tp` was chosen from `expectedFill`, so `monteCarlo.rewardRisk` IS
  // the reward:risk at the price the position is expected to pay. The explicit
  // recomputation below is not redundant: it is the invariant stated in the
  // units the rule is written in, and it is what the tests assert across every
  // mode and both generators.
  const rrFill = Math.abs(search.tp - expectedFill) / Math.abs(expectedFill - sl);
  if (rrFill < MIN_RR_FILL - 1e-9) {
    rejections.push(
      `Reward:risk at the expected fill is 1:${rrFill.toFixed(2)} ` +
        `(target ${search.tp.toFixed(input.spec.digits + 1)} vs fill ${expectedFill.toFixed(input.spec.digits + 1)}, ` +
        `stop ${sl.toFixed(input.spec.digits + 1)}), below the required 1:${MIN_RR_FILL.toFixed(2)}.`,
    );
  }
  if (search.rewardRisk < MIN_TARGET_R - 1e-9) {
    // Unreachable by construction (bestTarget refuses to search below 2R), and
    // kept as a belt-and-braces assertion of the same rule.
    rejections.push(
      `Target search returned ${search.rewardRisk.toFixed(2)}R, below the ${MIN_TARGET_R.toFixed(2)}R floor.`,
    );
  }

  // ── 5b. Bayesian blend of simulated and realised win probability ──────────
  // The simulation assumes the model is right. The desk's own history is the
  // only evidence about whether it is right *on this symbol*, so the two are
  // combined with a Beta–Binomial posterior that only earns influence once
  // there are enough trades to mean something.
  const posterior = input.outcomes
    ? blendProbability(
        monteCarlo.winProbability,
        betaPosterior(input.outcomes.wins, input.outcomes.losses),
        0.35,
      )
    : { probability: monteCarlo.winProbability, source: "model" };
  const blendedWinProbability = posterior.probability;
  if (posterior.source === "model+realised") {
    warnings.push(
      `Win probability blended with realised history (${input.outcomes?.wins ?? 0}W/${input.outcomes?.losses ?? 0}L): ` +
        `model ${(monteCarlo.winProbability * 100).toFixed(0)}% → ${(blendedWinProbability * 100).toFixed(0)}%.`,
    );
  }

  /**
   * Expectancy recomputed on the blended probability — WITHOUT THROWING AWAY
   * THE TIMEOUT PATHS.
   *
   * This used to be `p·RR − (1−p) − costR`, which treats every path that is
   * neither a win nor a loss as a full −1R. It is not: a plan with a stop and a
   * target both wider than the horizon closes at the horizon, at whatever the
   * market is then worth (`timeoutMeanR`), and with a wide stop — the normal
   * case once the risk unit is real — the majority of paths end that way. The
   * old formula therefore *manufactured* a negative expectancy: a setup the
   * simulation scored at +2.20R gross was reported as −0.25R, and the desk
   * refused it. This is the second half of "the expectancy is always below the
   * 0.15R minimum".
   *
   * Only `p(win)` is re-estimated by the blend, so the fix is to re-normalise
   * the remaining probability between loss and timeout in the SAME PROPORTION
   * the simulation found, and to keep the payoff those timeout paths actually
   * have. When no realised history is blended in, this reduces exactly to the
   * simulation's own expectancy — which is the property a gate should have.
   */
  const timeoutProbability = monteCarlo.timeoutProbability;
  const blendedLossProbability = clamp(
    1 - blendedWinProbability - timeoutProbability,
    0,
    1,
  );
  const costRFromModel = Math.max(0, monteCarlo.grossExpectancyR - monteCarlo.expectancyR);
  const effectiveExpectancyR =
    blendedWinProbability * monteCarlo.rewardRisk -
    blendedLossProbability +
    timeoutProbability * monteCarlo.timeoutMeanR -
    costRFromModel;

  if (effectiveExpectancyR < minEdgeR) {
    rejections.push(
      `Expectancy after costs is ${effectiveExpectancyR.toFixed(2)}R (model ${monteCarlo.expectancyR.toFixed(2)}R, ` +
        `gross ${monteCarlo.grossExpectancyR.toFixed(2)}R, ${(monteCarlo.lossProbability * 100).toFixed(0)}% stop / ` +
        `${(monteCarlo.timeoutProbability * 100).toFixed(0)}% time-stop paths), below the ${minEdgeR}R minimum.`,
    );
  }

  // ── 5c. The WP6 gatekeeper — the composition point ────────────────────────
  //
  // Everything above is the legacy pipeline. This is where the v4 layers meet:
  // the WP3 regime permit, the WP4 agents' view, the WP5 calibrated probability
  // and the WP6 executed-policy Monte Carlo are all spent in ONE decision, and
  // the result is an ADDITIONAL veto. Nothing here can arm a trade the legacy
  // gates refused, and nothing here removes one they accepted — the two are
  // composed by intersection.
  //
  // It runs only when `DESK_V4_GATEKEEPER` is on. Its own sub-inputs are each
  // flag-gated; a missing sub-input is a REFUSAL (GK_NO_MODEL, GK_MC_UNAVAILABLE,
  // GK_REGIME), never a silent pass — "we could not measure it" is not "it is
  // fine". The flags default to off, so the shipped desk is byte-for-byte the
  // v3.05 decision path.
  if (v4On(deskV4().gatekeeper)) {
    const riskAtFill = Math.abs(expectedFill - sl);
    const v4 = deskV4();
    // The WP3 layer participates only when it is switched on. An absent permit
    // is not "no objection": the gatekeeper reads null as "the state could not be
    // measured" and refuses (GK_REGIME), which is the same rule the MC and the
    // model follow.
    const permit = v4On(v4.regimeHmm)
      ? v4On(v4.governance)
        ? gatekeeperRegimePermitPersisted({
            symbol: input.symbol,
            mode: input.mode,
            frame: entrySeries.timeframe,
            bars: entrySeries.bars,
            side,
            fitBars: DEFAULT_REGIME_HMM_CONFIG.fitBars,
            states: DEFAULT_REGIME_HMM_CONFIG.states,
          })
        : gatekeeperRegimePermit({
            symbol: input.symbol,
            mode: input.mode,
            frame: entrySeries.timeframe,
            bars: entrySeries.bars,
            side,
          })
      : null;
    const prediction = gatekeeperPrediction({
      snapshot: v4On(v4.metaModel) ? (input.metaModel ?? null) : null,
      bars: entrySeries.bars,
      symbol: input.symbol,
      mode: input.mode,
      frame: entrySeries.timeframe,
      spec: input.spec,
      side,
      spreadPrice: costPrice,
      horizonBars: horizon,
      targetMultipleR: rrFill,
    });
    // The executed-policy MC needs enough closes to fit a GARCH(1,1); when it
    // cannot, it says so and the gatekeeper refuses rather than resampling a
    // volatility that is not today's.
    const mc = v4On(v4.monteCarloV2)
      ? executedPolicyMonteCarlo({
          closes: closes(entrySeries.bars),
          entry: expectedFill,
          riskPrice: riskAtFill,
          targetMultipleR: rrFill,
          side,
          costPrice,
          horizonBars: horizon,
          tradesPerPath: GATEKEEPER_MC_TRADES_PER_PATH,
          paths: GATEKEEPER_MC_PATHS,
          seed: seed ^ 0x6b1f2c3d,
        })
      : null;
    gatekeeper = gatekeeperDecision({
      mode: input.mode,
      side,
      rrFill,
      expectedFill,
      riskPrice: riskAtFill,
      costPrice,
      stepVolatility: simulationVolatility,
      horizonBars: horizon,
      probability: prediction.prediction?.probability ?? null,
      probabilityLowerBound: prediction.prediction?.probabilityLowerBound ?? null,
      evidence: prediction.prediction?.evidence ?? 0,
      breakEvenProbability: prediction.breakEvenProbability,
      regime: permit
        ? {
            permit: permit.permit,
            codes: permit.codes,
            reason: permit.reason,
            probability: permit.probability,
            required: permit.required,
          }
        : null,
      mc,
      familySize: 1,
      modelNote: prediction.note,
    });
    alphaView = prediction.view;
    sizingProbabilityLowerBound = prediction.prediction?.probabilityLowerBound ?? null;
    if (!gatekeeper.armed) rejections.push(...gatekeeperRejections(gatekeeper));

    // ── The WP9 governance overlay ─────────────────────────────────────────
    //
    // The desk's own record can take an agent out of service. When it does, the
    // agent's reading is REMOVED from the view — the proposal is not merely
    // noted, it stops contributing — and if that empties the view the plan is
    // refused with a sentence naming every agent that was dropped, because "the
    // gatekeeper had no model" would otherwise be the only trace of a governance
    // action that mattered.
    if (v4On(v4.governance) && input.governance) {
      const disabled = new Set<string>(input.governance.disabledAgents);
      if (alphaView && disabled.size > 0) {
        const proposed = alphaView.agents;
        const kept = proposed.filter((id) => !disabled.has(id));
        if (kept.length !== proposed.length) {
          const removed = proposed.filter((id) => disabled.has(id));
          alphaView = { ...alphaView, agents: kept };
          warnings.push(
            `[GOV] removed ${removed.join(", ")} from this setup: the desk's own outcomes reached the per-agent e-process disable threshold (WP9).`,
          );
          if (kept.length === 0) {
            rejections.push(
              `[GOV] every agent that proposed this setup (${proposed.join(", ")}) is disabled by the desk's per-agent e-process — the setup has no proposer left.`,
            );
          }
        }
      }
    }
  }

  // ── 5d. The WP7 execution and timing agent ────────────────────────────────
  //
  // It runs only when `DESK_V4_EXECUTION` is on, and it can only refuse or
  // reshape the ENTRY — never the geometry: the stop, the target and the risk
  // unit are the ones the gate above priced. The four layers are the spread's
  // own z-score, the desk's realised outcomes by minute-of-week, the EWMA of
  // its realised slippage, and the entry style (a pullback rests a limit; a
  // breakout stops in with bar-close confirmation).
  //
  // The ledgers are deliberately process-wide: "the desk's own record" is the
  // whole point of a timing layer, and the decision it makes is still a pure
  // function of what that record contains at the moment of the call.
  if (v4On(deskV4().execution)) {
    const lastBar = entrySeries.bars[entrySeries.bars.length - 1] as Bar;
    execution = executionDecision({
      mode: input.mode,
      side,
      spec: input.spec,
      decisionClose: entry,
      atr: stop.atrValue,
      // The desk's own entry offset, in ATR: the same distance the plan's
      // trigger already sits at, so the resting level and the trigger cannot
      // disagree about where the setup is.
      retraceAtr: input.mode === "scalp" ? 0.08 : 0.12,
      setup: input.entrySetup ?? (alphaView && alphaView.agents.includes("sweep") ? "pullback" : "breakout"),
      riskPrice,
      slippagePrice,
      spreadPoints: liveSpreadPoints,
      spreadHistory: input.spreadHistory ?? spreadHistoryFor(spreadHistory, input.symbol),
      timestampMs: lastBar[0] as number,
      timing: timingLedger,
      slippage: slippageLedger,
    });
    if (!execution.allowed) rejections.push(...executionRejections(execution));
  }

  // ── 6. Spread: priced, and ONLY priced ────────────────────────────────────
  //
  // There is exactly one cost decision in this desk, and this is it: the spread
  // (plus commission and slippage) is charged inside the expectancy above, and
  // `minEdgeR` is the single gate that judges it. The two ratio vetoes that used
  // to sit here and in sizing — "spread is more than 35% of the stop" and
  // "(spread + commission) is more than 35% of the risk" — are gone. They were
  // blocking A+ setups on the strength of a ratio, while the number that
  // actually decides whether a trade pays was already computed one step above.
  //
  // What replaces them is arithmetic, not a threshold: the risk unit itself may
  // not be smaller than the cost of entering (see MIN_COST_COVERAGE above), so
  // a wide spread widens the stop instead of vetoing the idea. The spread is
  // still visible on the plan — `costR` states it in R, which is the only unit
  // in which it is comparable between a forex scalp and an index swing.
  //
  // Fill-time guard sent to the EA: how far the spread may widen between arming
  // and firing. Expressed against the STOP, not in absolute points, because a
  // point means something different on every asset class — and floored above
  // the spread we actually measured so a normal tick cannot block the fill.
  const stopPoints = input.spec.point > 0 ? riskPrice / input.spec.point : 0;
  const maxSpreadPoints = fillSpreadGuard(input.spec, stopPoints, liveSpreadPoints);

  // ── 7. Edge-aware sizing inside a real budget ─────────────────────────────
  //
  // THE BUDGET IS A CEILING, NOT A SIZE.
  //
  // The desk allows up to 0.5% of equity per trade (`risk.riskCeilingPct`, which
  // the user can only tighten in settings). What is actually risked is this
  // agent's call, made from three measured inputs and never from a fixed
  // number:
  //
  //   • the edge       — fractional Kelly on the BLENDED win probability: a
  //                      strategy that looks great in simulation but has been
  //                      losing on this desk sizes smaller, one that has been
  //                      delivering earns its way back toward the governor's
  //                      allowance (never above it);
  //   • the regime     — how confident the volatility/trend read is;
  //   • the loss ladder — the governor's de-escalation after consecutive losses.
  //
  // The target is capped at the governor's number, NOT at some multiple of it:
  // once the budget is a real ceiling, letting a strong edge multiply the risk
  // back up would quietly undo the de-escalation the ladder exists to apply
  // (and it would let a "0.5% budget" trade 0.75%). The edge can therefore only
  // ever vote for LESS risk, which is the safe direction for a multiplier.
  //
  // The BUDGET is still handed to sizing, so the broker's indivisible minimum
  // lot is judged against it rather than against the (possibly much smaller)
  // target. That is what stops "Minimum 0.01 lots would risk 0.17% of equity,
  // above the 0.15% budget" refusals on accounts where 0.17% was affordable.
  const kelly = kellyFraction(blendedWinProbability, monteCarlo.rewardRisk, 0.25);
  const edgeScale = clamp(kelly * 10, 0.35, 1.5);
  const riskPct = clamp(
    risk.riskPct * edgeScale * clamp(0.6 + 0.4 * regime.confidence, 0.6, 1),
    MIN_TRADE_RISK_PCT,
    // The governor's number, and never more than the desk budget — the two can
    // only differ if a policy was configured above the desk's own ceiling.
    Math.min(risk.riskPct, risk.riskCeilingPct),
  );

  // `trigger` and `triggerOffset` are defined above, before the target search,
  // because the fill price they imply is what the 1:2 gate measures against.
  const invalidate =
    side === "buy" ? entry - stop.atrValue * 0.6 : entry + stop.atrValue * 0.6;

  // Size against the EXPECTED FILL, not the current quote.
  //
  // The stop is structural and fixed, so firing at the trigger puts the fill
  // `triggerOffset` further from it than the quote was, and slippage adds a
  // little more again. Sizing off the quote therefore UNDER-states the real
  // stop distance, and because the lot size divides by that distance it
  // silently risks MORE than the budget — ~8% more on an intraday plan, up to
  // ~16% on a scalp where a 0.08 ATR offset sits against a 0.5 ATR stop. Risk
  // is measured from the price we actually expect to pay: the fill.
  //
  // No cost ceilings are passed any more: sizing's job is to convert a risk
  // budget into a legal lot size, not to re-litigate the edge. The spread is
  // already inside `expectancyR` (the gate) and inside the widened risk unit.
  // ── The WP8 portfolio budget ──────────────────────────────────────────────
  //
  // When the layer is on, the trade's risk is `min(0.35%, ¼-Kelly(p_LCB))`
  // scaled by the drawdown state, and then reduced further if the open book is
  // already carrying the correlation cluster it would join, or if the book's
  // heat or CVaR would cross their ceilings. Every step is a REDUCTION: the
  // layer can lower the edge's own budget, never raise it.
  let sizingRiskPct = riskPct;
  if (v4On(deskV4().portfolio)) {
    const equity = input.account.equity;
    const book = input.positions.map((position) => ({
      symbol: position.symbol,
      riskPct: equity > 0 && position.initialRiskMoney ? (position.initialRiskMoney / equity) * 100 : 0,
    }));
    const correlation = input.portfolioCorrelation ?? null;
    const labels = correlation ? correlation.labels : book.map((entry) => entry.symbol);
    portfolio = portfolioDecision({
      drawdownPct: drawdownFromPeak({ equity, peakEquity: input.account.peakEquity }),
      probabilityLowerBound: sizingProbabilityLowerBound,
      rewardRisk: rrFill,
      book: book.map((entry, index) => ({
        ...entry,
        cluster: null,
        symbol: labels[index] ?? entry.symbol,
      })),
      correlation: correlation ? correlation.matrix : null,
      candidateIndex: correlation ? correlation.labels.length - 1 : undefined,
      labels,
      maxTradeRiskPct: riskPct,
    });
    if (!portfolio.allowed) rejections.push(...portfolio.reasons.map((reason) => `[PF] ${reason}`));
    else sizingRiskPct = Math.min(sizingRiskPct, portfolio.riskPct);
  }

  // ── The WP9 governance HALF ───────────────────────────────────────────────
  //
  // An agent whose evidence of degradation reached the e-process halve threshold
  // keeps proposing, at half budget. The factor is the SMALLEST among the agents
  // that proposed this setup — the trade is one unit of risk, so the most
  // cautious proposer governs it — and the desk says so in the warnings rather
  // than shrinking a lot size silently.
  //
  // Reduce-only by construction: the factor is 0.5 or 1, never above 1, and it
  // is applied after every other budget rule.
  let governanceScale = 1;
  if (v4On(deskV4().governance) && input.governance && input.governance.halvedAgents.length > 0) {
    const halved = new Set<string>(input.governance.halvedAgents);
    const proposers = alphaView?.agents ?? [];
    const hit = proposers.filter((id) => halved.has(id));
    if (hit.length > 0) {
      governanceScale = 0.5;
      warnings.push(
        `[GOV] risk halved: ${hit.join(", ")} proposed this setup and the desk's per-agent e-process reached the halve threshold (WP9).`,
      );
    }
  }
  if (governanceScale < 1) sizingRiskPct *= governanceScale;

  // ── The WP7 entry, adopted only when the geometry still clears 1:2 ─────────
  //
  // A resting limit at a pullback fills BETTER than the trigger, which moves the
  // fill price, the risk unit and the reward:risk at once — so adopting it is a
  // change to the plan's arithmetic, not a cosmetic relabel. The rule here is
  // the one WP1 established: the R:R the desk arms must be ≥ 2 **at the fill it
  // expects**, and the stop may not move to make that true. When the new fill
  // cannot pay 1:2 against the existing stop and target, the entry style is NOT
  // adopted — the plan keeps the trigger the whole pipeline priced — and the
  // warning says so. Sizing follows the adopted fill, so the money at risk stays
  // inside the budget rather than growing with a better price.
  let entryForSizing = expectedFill;
  let triggerForPlan = trigger;
  let entryStyleForPlan: ArmedPlan["triggerType"] = "break";
  if (
    execution &&
    execution.allowed &&
    v4Live(deskV4().execution) &&
    (execution.entry.style === "limit" || execution.entry.style === "stop")
  ) {
    const restingFill = execution.entry.trigger + (side === "buy" ? 1 : -1) * slippagePrice;
    const restingRisk = Math.abs(restingFill - sl);
    const restingMultiple = restingRisk > 0 ? Math.abs(search.tp - restingFill) / restingRisk : 0;
    if (restingRisk > 0 && restingMultiple >= MIN_RR_FILL) {
      entryForSizing = restingFill;
      triggerForPlan = execution.entry.trigger;
      entryStyleForPlan = execution.entry.style;
    } else {
      warnings.push(
        `WP7 held the ${execution.entry.style} entry: at the resting fill of ${restingFill.toPrecision(7)} the trade pays 1:${restingMultiple.toFixed(2)} against the existing stop and target, under the 1:${MIN_RR_FILL.toFixed(1)} floor — the plan keeps its trigger.`,
      );
    }
  }

  const sizing = sizePosition({
    spec: specForSizing,
    side,
    entry: entryForSizing,
    sl,
    tp: search.tp,
    equity: input.account.equity,
    freeMargin: input.account.freeMargin,
    usedMargin: input.account.margin,
    riskPct: sizingRiskPct,
    // The minimum-lot decision is made against the budget, not the target —
    // see SizingRequest.riskCeilingPct.
    riskCeilingPct: risk.riskCeilingPct,
    leverage: input.account.leverage,
  });

  if (!sizing.ok) rejections.push(sizing.explanation);

  // When the broker's indivisible minimum lot forces more risk than the edge
  // asked for, say so out loud. The trade is inside the desk budget, but the
  // user should never have to infer that from the lot size alone.
  if (sizing.ok && sizing.minLotApplied) {
    warnings.push(
      `Broker minimum lot ${sizing.lots} taken: ${sizing.effectiveRiskPct.toFixed(2)}% of equity at risk vs the ${sizingRiskPct.toFixed(2)}% adaptive target (per-trade budget ${risk.riskCeilingPct.toFixed(2)}%).`,
    );
  }

  // ── 8. Arm, or explain ────────────────────────────────────────────────────
  if (rejections.length > 0 || !sizing.ok) {
    return {
      symbol: input.symbol,
      mode: input.mode,
      armed: false,
      gatekeeper,
      execution,
      portfolio,
      alphaAgents: [...(alphaView?.agents ?? [])],
      sizingProbabilityLowerBound,
      plan: null,
      confluence,
      evidence,
      qualityScore,
      qualityThreshold: threshold,
      expectancyR: Number(effectiveExpectancyR.toFixed(3)),
      winProbability: Number(blendedWinProbability.toFixed(3)),
      monteCarlo,
      sizing,
      risk,
      news,
      entryTimeframe: entrySeries.timeframe,
      horizonMinutes: horizon * TIMEFRAME_MINUTES[entrySeries.timeframe],
      costR: Number(costR.toFixed(3)),
      stopWidened: riskWidened,
      rejections,
      warnings,
      summary:
        `${input.symbol} ${input.mode}: no trade — ${rejections[0] ?? "gate failed"} ` +
        `(quality ${qualityScore.toFixed(0)}/${threshold.toFixed(0)}, E ${effectiveExpectancyR.toFixed(2)}R).`,
      evaluatedAt: now,
    };
  }

  // Probability of coming back to entry before the target, used to decide how
  // early breakeven may be scheduled.
  const retrace = simulateTrade({
    entry: search.tp > entry ? entry + riskPrice : entry - riskPrice,
    sl: entry,
    tp: search.tp,
    side,
    drift: regime.drift,
    volatility: simulationVolatility,
    horizon,
    returns,
    paths: 1500,
    seed: seed ^ 0x5bf03635,
  }).lossProbability;

  const atrPoints = priceToPoints(input.spec, stop.atrValue);
  const management = buildManagementPlan({
    spec: input.spec,
    mode: input.mode,
    lots: sizing.lots,
    regimeKind: regime.kind,
    atrPoints,
    retraceProbability: retrace,
  });

  const plan: ArmedPlan = {
    id: randomUUID(),
    symbol: input.symbol,
    side,
    mode: input.mode,
    trigger: triggerForPlan,
    // "break" is the v3.04 behaviour and the default. The v4 execution agent
    // (WP7) may replace it with a resting limit/stop — but only when the
    // adopted fill still clears the 1:2 floor against the existing stop and
    // target, which is checked directly above.
    triggerType: entryStyleForPlan,
    confirmTicks: input.mode === "scalp" ? 2 : 1,
    invalidate,
    sl: sizing.sl,
    tp: [search.tp],
    lots: sizing.lots,
    riskMoney: sizing.riskMoney,
    riskPoints: sizing.riskPoints,
    maxSpreadPoints,
    maxSlippagePoints: input.mode === "scalp" ? 3 : 6,
    expiresAt: now + PLAN_TTL_MS[input.mode],
    createdAt: now,
    // v3.05 execution context for the EA's position manager. Optional on the
    // wire, so an older EA (and an older server) are unaffected.
    entryTimeframe: entrySeries.timeframe,
    costPrice,
    management,
    rationale: {
      confluenceScore: Number(qualityScore.toFixed(1)),
      grade: confluence.grade,
      regime: `${entrySeries.timeframe} ${regime.kind}`,
      winProbability: Number(blendedWinProbability.toFixed(3)),
      expectancyR: Number(effectiveExpectancyR.toFixed(3)),
      // The reward:risk the trade actually has — measured at the expected
      // fill, which is the same number the 1:2 gate enforced.
      rewardRisk: Number(rrFill.toFixed(2)),
      markovPersistence: Number(persistence.toFixed(3)),
      factors: [
        // The evidence ensemble first: it is the part of the decision with the
        // most independent statistical content, and the part the user most
        // often needs to audit when a trade surprises them.
        ...evidence.factors.map((factor) => ({
          label: factor.label,
          detail: `${factor.vote === 1 ? "agrees" : factor.vote === -1 ? "opposes" : "neutral"} · ${factor.detail}`,
          weight: Number((factor.weight * (0.35 + 0.65 * factor.reliability)).toFixed(3)),
          aligned: factor.vote === 1,
        })),
        ...confluence.factors,
        {
          label: "Monte Carlo",
          // The fill the ratio is measured from is stated: a "2.4R" that was
          // computed from the quote is not the same trade as a 2.4R at fill.
          detail:
            `${(blendedWinProbability * 100).toFixed(0)}% win (${posterior.source}) over ${horizon} ${entrySeries.timeframe} bars ` +
            `at ${rrFill.toFixed(2)}R at the expected fill ${expectedFill.toFixed(input.spec.digits + 1)}, ` +
            `E=${effectiveExpectancyR.toFixed(2)}R after costs`,
          weight: 1,
          aligned: true,
        },
        {
          label: "Cost & risk unit",
          detail:
            `cost ${(costR * 100).toFixed(0)}% of the ${sizing.riskPoints.toFixed(0)}-pt risk unit ` +
            `(${liveSpreadPoints}-pt spread + ${slippagePoints} pt slippage)` +
            (riskWidened ? ` — stop widened from the structural ${structuralRiskPrice / input.spec.point} pts to keep the risk unit real` : ""),
          weight: 1,
          aligned: true,
        },
        {
          label: "Sizing",
          detail: sizing.explanation,
          weight: 1,
          aligned: true,
        },
      ],
      warnings: [
        ...confluence.warnings,
        ...risk.reasons,
        ...(news.reason ? [news.reason] : []),
        ...warnings,
      ],
    },
  };

  return {
    symbol: input.symbol,
    mode: input.mode,
    armed: true,
    gatekeeper,
    execution,
    portfolio,
    alphaAgents: [...(alphaView?.agents ?? [])],
    sizingProbabilityLowerBound,
    plan,
    confluence,
    evidence,
    qualityScore,
    qualityThreshold: threshold,
    expectancyR: Number(effectiveExpectancyR.toFixed(3)),
    winProbability: Number(blendedWinProbability.toFixed(3)),
    monteCarlo,
    sizing,
    risk,
    news,
    entryTimeframe: entrySeries.timeframe,
    horizonMinutes: horizon * TIMEFRAME_MINUTES[entrySeries.timeframe],
    costR: Number(costR.toFixed(3)),
    stopWidened: riskWidened,
    rejections: [],
    warnings,
    summary:
      `${input.symbol} ${input.mode}: ${side.toUpperCase()} ${sizing.lots} lots armed — ` +
      `quality ${qualityScore.toFixed(0)} (${confluence.grade}), ` +
      `${evidence.agreeingFamilies}/${evidence.totalFamilies} families agree, ` +
      `${(blendedWinProbability * 100).toFixed(0)}% win, E ${effectiveExpectancyR.toFixed(2)}R, ` +
      `risk ${sizing.riskMoney.toFixed(2)} (${sizing.effectiveRiskPct.toFixed(2)}% of equity).`,
    evaluatedAt: now,
  };
}

/** Horizon of a mode expressed in minutes, for display. */
export function horizonMinutes(mode: TradeMode): number {
  return MODE_HORIZON_BARS[mode] * TIMEFRAME_MINUTES[ENTRY_TIMEFRAME[mode]];
}
