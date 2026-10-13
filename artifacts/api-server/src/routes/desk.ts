/**
 * Multi-Asset Desk — terminal-facing API.
 *
 * The Desk has no demo/replay path. A user sees an empty, explicit connection
 * state until their MT5 EA pairs; all account values, quotes, candles and
 * economic-calendar events then come from that terminal. Stale data is never
 * passed to an agent or used to arm a plan.
 */

import { Router, type IRouter, type Response } from "express";
import { randomUUID } from "node:crypto";
import { getBrowserSessionId } from "../lib/session";
import { logger } from "../lib/logger";
import { evaluate, getSlippageLedger, getSpreadHistory, getTimingLedger, horizonMinutes } from "../lib/multiasset/agent";
import { SPREAD_Z_WINDOW, recordSpread, spreadHistoryFor } from "../lib/multiasset/execution";
import { correlationFromBars, MIN_COVARIANCE_SAMPLES } from "../lib/multiasset/portfolio-risk";
import { deskV4, deskV4Summary, v4On } from "../lib/multiasset/desk-v4-config";
import { performanceStats } from "../lib/multiasset/analytics";
import {
  AUTO_SELECT_INTERVAL_MS,
  AUTO_SELECT_MAX_CANDIDATES,
  AUTO_SELECT_NOTE_INTERVAL_MS,
  maybeAutoSelect as autoSelectIfDue,
  runAutoSelect,
} from "../lib/multiasset/auto-select";
import { equityCurveSimulation } from "../lib/multiasset/montecarlo";
import { aggregateExposure } from "../lib/multiasset/sizing";
import { clockSkewWarning, feedHealth, QUOTE_STALE_MS } from "../lib/multiasset/integrity";
import {
  connectionProblem,
  resolveLiveSymbol,
  symbolReadiness,
  TERMINAL_DEGRADED_MS,
  terminalIsDegraded,
  terminalIsFresh,
  terminalSilenceMs,
  terminalStaleWindowMs,
} from "../lib/multiasset/live";
import { upcomingRedFolder } from "../lib/multiasset/news";
import {
  analysisThresholds,
  quoteSnapshot,
  deskSummary,
  scanEdgeFields,
  withManagementState,
} from "../lib/multiasset/presenter";
import { addSSEClient, broadcastSSE, removeSSEClient } from "../lib/sse";
import {
  DEFAULT_RISK_POLICY,
  confirmRegimeChange,
  remainingDailyBudget,
  type RiskPolicy,
} from "../lib/multiasset/risk";
import {
  armPlan,
  cancelPlan,
  enqueueCommand,
  expirePlans,
  getDesk,
  journal,
  outcomesFor,
  pruneDeselectedSymbols,
  seriesFor,
  startNewTradingDay,
  DEFAULT_DESK_TIMEZONE,
  type DeskState,
} from "../lib/multiasset/store";
import {
  buildWeeklyReport,
  governanceOverlay,
  governanceRegistry,
  planMemory,
  rememberPlan,
  recordShadowDecision,
  agentsForTicket,
} from "../lib/multiasset/governance-runtime";
import { E_DISABLE, E_HALVE, resumeAgent, weekWindow } from "../lib/multiasset/governance";
import { REGIME_STATE_TTL_MS, deskRegimeState } from "../lib/multiasset/regime-state";
import { listJournal } from "../lib/multiasset/governance-store";
import { deskAlertNow } from "../lib/multiasset/alerts";
import { GOVERNED_AGENTS } from "../lib/multiasset/governance-runtime";
import type { AgentDecision } from "../lib/multiasset/agent";
import type { AlphaId } from "../lib/multiasset/alpha/types";
import {
  MODE_ANALYSIS_TIMEFRAMES,
  ALL_TIMEFRAMES,
  type Bar,
  type Quote,
  type SymbolSpec,
  type Timeframe,
  type TradeMode,
} from "../lib/multiasset/types";

const router: IRouter = Router();
const VALID_MODES: TradeMode[] = ["scalp", "intraday", "swing"];

/**
 * Timezones offered in the Desk header.
 *
 * Nairobi (EAT, UTC+3) is the default because that is where the desk is
 * operated from and every other timestamp on the platform reads as a
 * conversion the user has to do in their head.
 */
export const DESK_TIMEZONES = [
  { id: "Africa/Nairobi", label: "Nairobi · EAT" },
  { id: "UTC", label: "UTC" },
  { id: "Europe/London", label: "London" },
  { id: "America/New_York", label: "New York" },
] as const;

function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isTimeframe(value: unknown): value is Timeframe {
  // ALL frames, including the server-synthesised ones: seriesFor() serves both
  // and a consumer asking for S10 should get an empty list, not a 400.
  return typeof value === "string" && (ALL_TIMEFRAMES as readonly string[]).includes(value);
}

function assertLiveConnection(desk: DeskState, res: Response): boolean {
  const problem = connectionProblem(desk);
  if (!problem) return true;
  res.status(409).json({ error: problem });
  return false;
}

function accountFor(desk: DeskState) {
  return desk.account;
}

/**
 * The WP7/WP8 inputs the desk can honestly supply to a decision.
 *
 * Both are flag-gated and both default to "the desk has not measured this":
 *
 *   • the spread history is the desk's OWN record of this symbol's quotes —
 *     there is nowhere else to get it, since MT5 bars carry no spread column.
 *     With too few observations the z-score abstains rather than firing on a
 *     window of three.
 *   • the correlation matrix is built from the desk's own closing bars at the
 *     mode's fastest analysis frame, and it is built ONLY when every position
 *     in the book and the candidate have the bars to support it. A matrix with
 *     a hole in it would make an unmeasured symbol look uncorrelated with
 *     everything else, which is the one reading this layer must never take;
 *     `null` makes it say so out loud (PF_NO_COVARIANCE) and keep the
 *     per-trade ceiling.
 */
function v4InputsFor(
  desk: DeskState,
  symbol: string,
  mode: TradeMode,
): { spreadHistory?: number[]; portfolioCorrelation?: { labels: string[]; matrix: number[][] } | null } {
  const v4 = deskV4();
  if (!v4.enabled) return {};
  const inputs: { spreadHistory?: number[]; portfolioCorrelation?: { labels: string[]; matrix: number[][] } | null } = {};
  if (v4On(v4.execution)) {
    const history = spreadHistoryFor(getSpreadHistory(), symbol);
    // A window shorter than the z-score can use is not passed at all: an empty
    // array and 30 observations both mean "no opinion", and saying so early
    // keeps the decision record honest about it.
    inputs.spreadHistory = history.length >= 60 ? history.slice(-SPREAD_Z_WINDOW) : [];
  }
  if (v4On(v4.portfolio)) {
    const frame = MODE_ANALYSIS_TIMEFRAMES[mode][0];
    const held = desk.positions.map((position) => position.symbol).filter((heldSymbol) => heldSymbol !== symbol);
    const labels = [...new Set([...held, symbol])];
    const built = correlationFromBars({
      series: labels.map((label) => ({ label, bars: desk.candles.get(`${label}|${frame}`)?.bars ?? [] })),
      count: MIN_COVARIANCE_SAMPLES * 3,
    });
    inputs.portfolioCorrelation = built ? { labels: built.labels, matrix: built.correlation } : null;
  }
  return inputs;
}

/**
 * The WP9 governance overlay for one decision.
 *
 * Nothing here is consulted while `DESK_V4_GOVERNANCE` is off: the decision then
 * carries no overlay at all, which is the same input the v3.05 path receives.
 */
function v4GovernanceInput(sessionId: string): { governance?: { disabledAgents: AlphaId[]; halvedAgents: AlphaId[] } } {
  const v4 = deskV4();
  if (!v4.enabled || !v4On(v4.governance)) return {};
  const overlay = governanceOverlay(sessionId);
  return { governance: { disabledAgents: overlay.disabled, halvedAgents: overlay.halved } };
}

/**
 * Write one decision to the shadow ledger, and remember the plan for attribution.
 *
 * Both halves are the same idea: the desk's own record has to survive the process
 * that produced it. The evaluation row is what makes "the shadow record" a file
 * rather than a claim; the plan memory is what lets a later fill be charged to
 * the agents that proposed it. Neither is awaited — a ledger write must never
 * delay an arm — and neither can throw into the request.
 */
function recordDecisionForGovernance(input: {
  desk: DeskState;
  sessionId: string;
  decision: AgentDecision;
  nowMs: number;
}): void {
  const v4 = deskV4();
  if (!v4.enabled || !v4On(v4.governance)) return;
  const { decision } = input;
  const gatekeeper = decision.gatekeeper;
  const probability = gatekeeper ? null : decision.winProbability;
  const plan = decision.plan;
  const armed = decision.armed && plan !== null;
  void recordShadowDecision({
    sessionId: input.sessionId,
    evaluatedAtMs: input.nowMs,
    symbol: decision.symbol,
    mode: decision.mode,
    armed,
    planId: plan ? plan.id : null,
    direction: plan ? plan.side : null,
    // The gatekeeper does not expose its probability on the decision today
    // (`evLcbR` is what it gates on), so the calibrated point estimate is the
    // legacy blend when there is no model and NULL when the gatekeeper refused
    // before reaching one. NULL is a value the weekly report counts.
    probability,
    probabilityLowerBound: decision.sizingProbabilityLowerBound,
    breakEvenProbability: null,
    expectancyR: decision.expectancyR,
    costR: decision.costR,
    agents: decision.alphaAgents,
    refusals: decision.rejections,
    gateCodes: gatekeeper ? gatekeeper.codes : [],
    payload: {
      qualityScore: decision.qualityScore,
      qualityThreshold: decision.qualityThreshold,
      execution: decision.execution ? { codes: decision.execution.codes } : null,
      portfolio: decision.portfolio ? { codes: decision.portfolio.codes, riskPct: decision.portfolio.riskPct } : null,
    },
  }).catch(() => {});
  if (armed && plan) {
    rememberPlan({
      sessionId: input.sessionId,
      planId: plan.id,
      symbol: plan.symbol,
      mode: plan.mode,
      direction: plan.side,
      agents: decision.alphaAgents as AlphaId[],
      predictedProbability: probability,
      armedAtMs: input.nowMs,
    });
  }
}

function scanRowFor(desk: DeskState, symbol: string, mode: TradeMode, now: number) {
  const readiness = symbolReadiness(desk, symbol, now);
  const resolved = resolveLiveSymbol(desk, symbol, now);
  const account = accountFor(desk);
  if (!resolved || !account) {
    const reason = readiness === "warming"
      ? "Waiting for the MT5 EA to seed this symbol's live quote and history."
      : "Live quote is stale; the agent will not analyse or trade it.";
    return {
      symbol,
      status: readiness,
      armed: false,
      direction: "none" as const,
      score: 0,
      grade: "no-trade",
      expectancyR: null,
      winProbability: null,
      lots: null,
      riskMoney: null,
      rrFill: null,
      edgeFloorR: null,
      edgeRequiredR: null,
      rejections: [reason],
      summary: `${symbol}: ${reason}`,
    };
  }

  const decision = evaluate({
    symbol,
    mode,
    spec: resolved.spec,
    quote: resolved.quote,
    series: resolved.series,
    account,
    positions: desk.positions,
    specs: desk.specs,
    riskState: desk.riskState,
    policy: desk.policy,
    news: desk.news,
    outcomes: outcomesFor(desk, symbol, mode),
    now,
    ...v4InputsFor(desk, symbol, mode),
    ...v4GovernanceInput(desk.sessionId),
  });
  return {
    symbol,
    status: "live" as const,
    armed: decision.armed,
    direction: decision.confluence.direction,
    score: Number(decision.confluence.score.toFixed(1)),
    grade: decision.confluence.grade,
    expectancyR: decision.monteCarlo ? Number(decision.monteCarlo.expectancyR.toFixed(3)) : null,
    winProbability: decision.monteCarlo ? Number(decision.monteCarlo.winProbability.toFixed(3)) : null,
    lots: decision.sizing?.ok ? decision.sizing.lots : null,
    riskMoney: decision.sizing?.ok ? Number(decision.sizing.riskMoney.toFixed(2)) : null,
    // v5 UI: the scanner's Edge floor / R:R columns, derived only from what the
    // decision already carries (null ⇒ the UI prints an em dash).
    ...scanEdgeFields(decision),
    rejections: decision.rejections,
    summary: decision.summary,
  };
}

// ── Desk overview and market universe ────────────────────────────────────────

router.get("/state", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const now = Date.now();
  expirePlans(desk, now);
  pruneDeselectedSymbols(desk);
  // A browser refresh must not be the only thing that drives the automatic
  // best-market pass: running the throttled pass here as well means a desk whose
  // EA heartbeats slowly still gets its sweep.
  try {
    autoSelectIfDue(desk, now);
  } catch (err) {
    logger.warn({ err }, "Auto-select pass failed on state read");
  }
  const account = accountFor(desk);
  const statuses = new Map(desk.watchlist.map((symbol) => [symbol, symbolReadiness(desk, symbol, now)]));
  const liveSymbols = [...statuses.values()].filter((status) => status === "live").length;
  const staleSymbols = [...statuses.values()].filter((status) => status === "stale").length;
  const mismatchSymbols = [...statuses.values()].filter((status) => status === "mismatch").length;

  res.json({
    source: desk.terminal ? "mt5" : "unlinked",
    terminal: desk.terminal
      ? {
          accountId: desk.terminal.accountId,
          login: desk.terminal.login,
          server: desk.terminal.server,
          company: desk.terminal.company,
          pairedAt: desk.terminal.pairedAt,
          lastSyncAt: desk.terminal.lastSyncAt,
          lastSyncAgeMs: terminalSilenceMs(desk, now),
          /**
           * `stale` is the hard state (analysis paused). `degraded` is the soft
           * one: the heartbeat is late, every symbol is still being checked on
           * its own 8-second quote, and the desk keeps working. The UI must not
           * tell the user trading has stopped for a 39-second hiccup.
           */
          stale: !terminalIsFresh(desk, now),
          degraded: terminalIsDegraded(desk, now),
          degradedAfterMs: TERMINAL_DEGRADED_MS,
          staleAfterMs: terminalStaleWindowMs(desk),
          syncIntervalMs: desk.terminal.syncIntervalMs || null,
        }
      : null,
    account,
    mode: desk.mode,
    autoTrade: desk.autoTrade,
    watchlist: desk.watchlist,
    timezone: desk.timezone,
    timezones: DESK_TIMEZONES,
    market: {
      catalogCount: desk.catalog.size,
      selectedCount: desk.watchlist.length,
      liveSymbols,
      warmingSymbols: desk.watchlist.length - liveSymbols - staleSymbols - mismatchSymbols,
      staleSymbols,
      mismatchSymbols,
      quoteFreshForMs: QUOTE_STALE_MS,
    },
    /** Feed diagnostics — what "the data is delayed" actually means today. */
    feed: {
      clockSkewMs: desk.clockSkewMs,
      clockWarning: clockSkewWarning(desk),
      lastQuoteAgeMs: desk.lastQuoteAgeMs,
      quoteFreshForMs: QUOTE_STALE_MS,
    },
    // v5 UI: each position carries the ONE management state its own geometry
    // can prove (stop at or beyond entry ⇒ "be"); optional on the wire, so
    // existing consumers are unaffected.
    positions: desk.positions.map(withManagementState),
    plans: [...desk.plans.values()],
    policy: desk.policy,
    risk: {
      state: desk.riskState,
      budget: account ? remainingDailyBudget(account, desk.policy) : null,
      exposure: account ? aggregateExposure(desk.positions, desk.specs, account.equity) : [],
    },
    news: desk.news,
    /**
     * The next 24 hours of red-folder events, already filtered, sorted and
     * distance-stamped by the server so the calendar pane, the agent's news
     * gate and the journal all describe the same window.
     */
    newsUpcoming: upcomingRedFolder(desk.news.events, now),
    /** Automatic best-market selection: what it last did and how often it runs. */
    autoSelect: {
      last: desk.lastAutoSelect,
      intervalMs: AUTO_SELECT_INTERVAL_MS[desk.mode],
      maxCandidates: AUTO_SELECT_MAX_CANDIDATES,
      noteIntervalMs: AUTO_SELECT_NOTE_INTERVAL_MS,
      // null until a pass has actually run: a bare 0 + interval is not a
      // timestamp, and a client must not render 1970 as "next scan".
      nextDueAt:
        desk.lastAutoSelectAt > 0
          ? desk.lastAutoSelectAt + AUTO_SELECT_INTERVAL_MS[desk.mode]
          : null,
    },
    journal: desk.journal.slice(0, 50),
    serverTime: now,
    /**
     * v5 UI: which v4 layers are computing right now, straight from the
     * resolved configuration. Optional block — a client that predates it sees
     * exactly the response it saw before.
     */
    v4: deskV4Summary(),
  });
});

/**
 * GET /api/desk/stream — server-sent events.
 *
 * Prices are pushed the instant the MT5 terminal's heartbeat lands rather than
 * being polled. Polling at 4 s meant the UI was always showing a price that
 * was at least one poll interval old, and on symbols the EA had not reached in
 * its rotation, several heartbeats old.
 */
router.get("/stream", (req, res) => {
  const sessionId = getBrowserSessionId();
  const desk = getDesk(sessionId);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  addSSEClient(res, sessionId);
  res.write(`event: desk\ndata: ${JSON.stringify(deskSummary(desk))}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeSSEClient(res);
  });
});

/** Full broker catalogue, grouped by the client without a server-side cap. */
router.get("/markets", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const now = Date.now();
  const selected = new Set(desk.watchlist);
  const markets = [...desk.catalog.values()]
    .map((market) => {
      const quote = desk.quotes.get(market.symbol);
      return {
        ...market,
        selected: selected.has(market.symbol),
        dataStatus: symbolReadiness(desk, market.symbol, now),
        lastQuoteAt: quote?.ts ?? null,
      };
    })
    .sort((a, b) =>
      a.assetClass.localeCompare(b.assetClass) ||
      Number(b.tradeable) - Number(a.tradeable) ||
      a.symbol.localeCompare(b.symbol),
    );
  res.json({ source: desk.terminal ? "mt5" : "unlinked", markets, catalogCount: markets.length });
});

/**
 * Quotes for the user's selected symbols.
 *
 * Every row carries its own feed status, quote age and — when the quote has
 * drifted away from the symbol's own candles — an explicit `priceWarning`.
 * A wrong price is never rendered as if it were a good one.
 */
router.get("/instruments", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const now = Date.now();
  pruneDeselectedSymbols(desk);
  res.json({
    source: desk.terminal ? "mt5" : "unlinked",
    instruments: quoteSnapshot(desk, now),
    feed: {
      clockSkewMs: desk.clockSkewMs,
      clockWarning: clockSkewWarning(desk),
      lastQuoteAgeMs: desk.lastQuoteAgeMs,
      quoteFreshForMs: QUOTE_STALE_MS,
    },
  });
});

/**
 * GET /api/desk/series?symbol= — every series available for a symbol.
 *
 * Includes the server-synthesised S10/S30 frames as well as the broker's own,
 * so a consumer never has to know which frames MetaTrader can and cannot
 * provide. A synthetic frame that is not dense enough is simply absent.
 */
router.get("/series", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.query.symbol ?? "");
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!assertLiveConnection(desk, res)) return;
  const series = seriesFor(desk, symbol);
  const out: Partial<Record<Timeframe, Bar[]>> = {};
  for (const timeframe of ALL_TIMEFRAMES) {
    const bars = series[timeframe];
    if (bars && bars.length > 0) out[timeframe] = bars;
  }
  return res.json({
    symbol,
    source: "mt5",
    series: out,
    spec: desk.specs.get(symbol) ?? null,
    quote: desk.quotes.get(symbol) ?? null,
    health: feedHealth(desk, symbol),
  });
});

/**
 * GET /api/desk/performance — what the desk has actually done.
 *
 * Built only from closed broker positions and sampled equity, so it is a
 * record, not a projection. It backs the performance block under the news
 * calendar, which previously left a hole on wide screens.
 */
/**
 * The WP7/WP8 state, read-only.
 *
 * A layer that can refuse entries must be auditable while it is switched on:
 * "why is the desk not trading this symbol?" is answered here, with the numbers
 * the layers are actually using (including how many observations stand behind
 * each one). It changes nothing and is absent — a 404 — while both flags are
 * off, so the shipped API surface is unchanged.
 */
router.get("/execution", (_req, res) => {
  const v4 = deskV4();
  if (!v4On(v4.execution) && !v4On(v4.portfolio)) {
    return res.status(404).json({ error: "The v4 execution and portfolio layers are switched off." });
  }
  const desk = getDesk(getBrowserSessionId());
  const spreadHistory = getSpreadHistory();
  const timing = getTimingLedger();
  const slippage = getSlippageLedger();
  return res.json({
    execution: v4On(v4.execution)
      ? {
          spreadSamples: Object.fromEntries(
            [...spreadHistory.samples.entries()].map(([symbol, samples]) => [
              symbol,
              { samples: samples.length, last: samples[samples.length - 1] ?? null },
            ]),
          ),
          timingBuckets: timing.buckets.size,
          timingPooled: { ...timing.pooled },
          slippage: { ewmaR: slippage.ewmaR, samples: slippage.samples, observations: slippage.observations.length },
        }
      : null,
    portfolio: v4On(v4.portfolio)
      ? {
          correlation: [...new Set([...desk.positions.map((position) => position.symbol), ...desk.watchlist])]
            .map((symbol) => {
              const built = correlationFromBars({
                series: [{ label: symbol, bars: desk.candles.get(`${symbol}|${MODE_ANALYSIS_TIMEFRAMES[desk.mode][0]}`)?.bars ?? [] }],
                count: MIN_COVARIANCE_SAMPLES * 3,
              });
              return [symbol, built ? built.returnCount : 0];
            })
            .filter(([, count]) => (count as number) > 0),
        }
      : null,
  });
});

/**
 * ── WP9: learning and governance, read-only and reduce-only ─────────────────
 *
 * Three endpoints, and the shape of each one is the point:
 *
 *   GET  /governance        the per-agent e-process, its Page–Hinkley statistic,
 *                           the status it has earned and the sentence saying why
 *   GET  /learning/weekly   the Monday-to-Monday report, built from the durable
 *                           rows, with its own flags list
 *   POST /governance/resume an OPERATOR action: put one agent back to work. The
 *                           evidence is not cleared, so an agent resumed into the
 *                           same conditions crosses its thresholds again at once
 *                           rather than after another full tally.
 *
 * All three 404 while `DESK_V4_GOVERNANCE` is off, so the shipped API surface is
 * unchanged. None of them can raise a budget.
 */
router.get("/governance", (_req, res) => {
  const v4 = deskV4();
  if (!v4On(v4.governance)) {
    return res.status(404).json({ error: "The v4 governance layer is switched off." });
  }
  const desk = getDesk(getBrowserSessionId());
  const registry = governanceRegistry(desk.sessionId);
  return res.json({
    sessionId: desk.sessionId,
    agents: registry.map((entry) => ({
      agentId: entry.agentId,
      status: entry.status,
      eValue: entry.eValue,
      halveAt: E_HALVE,
      disableAt: E_DISABLE,
      outcomes: entry.outcomes,
      wins: entry.wins,
      totalR: entry.totalR,
      phValue: entry.phValue,
      phAlarms: entry.phAlarms,
      reason: entry.reason,
      updatedAtMs: entry.updatedAtMs,
    })),
  });
});

/**
 * The desk's TIMEFRAME STATE (WP10.2), read from the same model the live permit
 * uses.
 *
 * A dashboard polls this; it is memoised for two seconds and keyed on the last
 * closed bar, so a new bar always recomputes and a second poll inside the window
 * costs nothing. It is absent — a 404 — while the regime subsystem is off.
 */
router.get("/regime", (req, res) => {
  const v4 = deskV4();
  if (!v4On(v4.regimeHmm)) {
    return res.status(404).json({ error: "The v4 regime layer is switched off." });
  }
  const desk = getDesk(getBrowserSessionId());
  const mode = (String(req.query.mode ?? desk.mode) as TradeMode) || desk.mode;
  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
  const frame = MODE_ANALYSIS_TIMEFRAMES[mode][0];
  const requested = String(req.query.symbol ?? "").trim();
  const symbols = requested ? [requested] : desk.watchlist;
  const now = Date.now();
  const states = symbols.map((symbol) => {
    const series = desk.candles.get(`${symbol}|${frame}`)?.bars ?? [];
    return {
      ...deskRegimeState({
        sessionId: desk.sessionId,
        symbol,
        frame,
        mode,
        bars: series,
        nowMs: now,
      }),
      bars: series.length,
      lastBarAtMs: series.length > 0 ? (series[series.length - 1]?.[0] as number) : null,
    };
  });
  return res.json({ source: "desk", mode, frame, ttlMs: REGIME_STATE_TTL_MS, asOfMs: now, states });
});

/**
 * The durable journal (WP10).
 *
 * The in-process journal is what `/state` streams; this is the same record after a
 * deploy, filtered and bounded. It is the endpoint the learning page reads, and it
 * 404s while the governance layer is off — because with the layer off nothing is
 * being written.
 */
router.get("/learning/journal", async (req, res) => {
  const v4 = deskV4();
  if (!v4On(v4.governance)) {
    return res.status(404).json({ error: "The v4 governance layer is switched off." });
  }
  const desk = getDesk(getBrowserSessionId());
  const kind = typeof req.query.kind === "string" && req.query.kind.length > 0 ? req.query.kind : null;
  const limit = Number(req.query.limit ?? 200);
  const rows = await listJournal({
    sessionId: desk.sessionId,
    limit: Number.isFinite(limit) ? limit : 200,
    kind,
  });
  // `DESK_V4_UI` governs the EXPLANATORY payloads a dashboard reads, never the
  // numbers: with it off the entries keep their message and lose the structured
  // detail blob, so a reader still sees what happened without the desk shipping
  // internals to a surface nobody has switched on.
  const withDetail = v4On(v4.ui);
  return res.json({
    source: "desk",
    sessionId: desk.sessionId,
    kind,
    detailIncluded: withDetail,
    entries: rows.map((row) => ({
      id: row.entryId,
      ts: row.tsMs,
      kind: row.kind,
      symbol: row.symbol,
      message: row.message,
      detail: withDetail ? (row.detail ?? null) : null,
    })),
  });
});

router.get("/learning/weekly", async (req, res) => {
  const v4 = deskV4();
  if (!v4On(v4.governance)) {
    return res.status(404).json({ error: "The v4 governance layer is switched off." });
  }
  const desk = getDesk(getBrowserSessionId());
  const requestedWeek = typeof req.query.weekStart === "string" ? Date.parse(req.query.weekStart) : Number.NaN;
  const report = await buildWeeklyReport({
    sessionId: desk.sessionId,
    nowMs: Date.now(),
    weekStartMs: Number.isFinite(requestedWeek) ? requestedWeek : undefined,
  });
  return res.json({ source: "desk", ...report, window: weekWindow(Date.now()) });
});

router.post("/governance/resume", (req, res) => {
  const v4 = deskV4();
  if (!v4On(v4.governance)) {
    return res.status(404).json({ error: "The v4 governance layer is switched off." });
  }
  const desk = getDesk(getBrowserSessionId());
  const agentId = String(req.body?.agentId ?? "");
  const note = String(req.body?.note ?? "").trim();
  if (!(GOVERNED_AGENTS as readonly string[]).includes(agentId)) {
    return res.status(400).json({ error: `agentId must be one of ${GOVERNED_AGENTS.join(", ")}` });
  }
  if (note.length < 3) {
    // A resume with no reason is a silent un-halt, and the whole point of the
    // one-way rule is that somebody has to say why.
    return res.status(400).json({ error: "a note is required when resuming an agent" });
  }
  const now = Date.now();
  const next = resumeAgent(governanceRegistry(desk.sessionId), agentId as AlphaId, now, note);
  const entry = next.find((candidate) => candidate.agentId === agentId);
  journal(desk, "risk", null, `Agent ${agentId} resumed by the operator: ${note}`);
  deskAlertNow({
    kind: "governance",
    title: `Agent ${agentId} resumed by the operator`,
    body: [note, `status ${entry?.status ?? "unknown"}, e ${(entry?.eValue ?? 0).toFixed(2)}`],
    dedupeKey: `resume:${agentId}:${note.slice(0, 40)}`,
    sessionId: desk.sessionId,
  });
  return res.json({ ok: true, agent: entry ?? null });
});

router.get("/performance", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const now = Date.now();

  const bySymbol = new Map<string, { symbol: string; trades: number; net: number; wins: number; losses: number; rMultiples: number[] }>();
  for (const trade of desk.closedTrades) {
    const entry = bySymbol.get(trade.symbol) ?? { symbol: trade.symbol, trades: 0, net: 0, wins: 0, losses: 0, rMultiples: [] };
    const net = trade.profit + trade.swap + trade.commission;
    entry.trades++;
    entry.net += net;
    if (net > 0) entry.wins++;
    else if (net < 0) entry.losses++;
    if (trade.rMultiple !== null) entry.rMultiples.push(trade.rMultiple);
    bySymbol.set(trade.symbol, entry);
  }

  const symbols = [...bySymbol.values()]
    .map((entry) => ({
      ...entry,
      net: Number(entry.net.toFixed(2)),
      winRate: entry.trades > 0 ? entry.wins / entry.trades : 0,
      stats: performanceStats(entry.rMultiples),
    }))
    .sort((a, b) => b.net - a.net);

  const allR = desk.closedTrades
    .map((t) => t.rMultiple)
    .filter((r): r is number => r !== null);

  return res.json({
    source: desk.terminal ? "mt5" : "unlinked",
    currency: desk.account?.currency ?? "USD",
    equityCurve: desk.equityHistory,
    // v5 UI: agent attribution via the fill→plan join that already exists.
    // `agents` is null when the (capped) plan memory no longer holds the
    // ticket — which renders as an em dash, never as "no agents".
    closedTrades: desk.closedTrades
      .slice(-50)
      .reverse()
      .map((trade) => ({ ...trade, agents: agentsForTicket(trade.ticket) })),
    bySymbol: symbols,
    overall: performanceStats(allR),
    outcomes: [...desk.outcomes.values()],
    realisedPnl: desk.riskState.realisedPnlToday,
    generatedAt: now,
  });
});

/** Retained as a live-data API for the agent and integrations; no Desk chart uses it. */
router.get("/candles", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.query.symbol ?? "");
  const timeframe = req.query.timeframe;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!isTimeframe(timeframe)) return res.status(400).json({ error: `timeframe must be one of ${ALL_TIMEFRAMES.join(", ")}` });
  if (!assertLiveConnection(desk, res)) return;

  const resolved = resolveLiveSymbol(desk, symbol);
  if (!resolved) return res.status(409).json({ error: `Fresh live MT5 data for ${symbol} is not available yet.` });
  return res.json({ symbol, timeframe, source: "mt5", spec: resolved.spec, quote: resolved.quote, bars: resolved.series[timeframe] ?? [] });
});

// ── Agent analysis ───────────────────────────────────────────────────────────

router.get("/analysis", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.query.symbol ?? "");
  const mode = (String(req.query.mode ?? desk.mode) as TradeMode) || desk.mode;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
  if (!assertLiveConnection(desk, res)) return;

  const resolved = resolveLiveSymbol(desk, symbol);
  const account = accountFor(desk);
  if (!resolved || !account) return res.status(409).json({ error: `Fresh live MT5 data for ${symbol} is not available yet.` });

  const decision = evaluate({
    symbol,
    mode,
    spec: resolved.spec,
    quote: resolved.quote,
    series: resolved.series,
    account,
    positions: desk.positions,
    specs: desk.specs,
    riskState: desk.riskState,
    policy: desk.policy,
    news: desk.news,
    outcomes: outcomesFor(desk, symbol, mode),
    ...v4InputsFor(desk, symbol, mode),
    ...v4GovernanceInput(desk.sessionId),
  });
  recordDecisionForGovernance({ desk, sessionId: desk.sessionId, decision, nowMs: Date.now() });

  return res.json({
    source: "mt5",
    horizonMinutes: horizonMinutes(mode),
    timezone: desk.timezone,
    /**
     * v5 UI: the gate constants the Decision panel prints when the gatekeeper
     * is not the decider. Optional block; the decision itself is unchanged.
     */
    thresholds: analysisThresholds(),
    decision: {
      ...decision,
      confluence: {
        ...decision.confluence,
        views: decision.confluence.views.map((view) => ({
          timeframe: view.timeframe,
          role: view.role,
          bias: view.bias,
          kind: view.regime.kind,
          confidence: view.regime.confidence,
          rsi: view.rsi,
          persistence: view.persistence,
          weight: view.weight,
          contribution: view.contribution,
          trendQuality: view.regime.trendQuality,
          volatilityRatio: view.regime.volatilityRatio,
        })),
      },
      evidence: decision.evidence
        ? {
            ...decision.evidence,
            // Regime objects are large and only the summary is rendered.
            factors: decision.evidence.factors,
          }
        : null,
    },
  });
});

/** Analyse every selected asset with a fresh quote; stale assets are visible as skipped. */
router.get("/scan", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const mode = (String(req.query.mode ?? desk.mode) as TradeMode) || desk.mode;
  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
  if (!assertLiveConnection(desk, res)) return;

  const now = Date.now();
  const results = desk.watchlist
    .map((symbol) => scanRowFor(desk, symbol, mode, now))
    .sort((a, b) => Number(b.armed) - Number(a.armed) || Number(a.status !== "live") - Number(b.status !== "live") || b.score - a.score);
  const coverage = {
    selected: desk.watchlist.length,
    live: results.filter((result) => result.status === "live").length,
    warming: results.filter((result) => result.status === "warming").length,
    stale: results.filter((result) => result.status === "stale").length,
  };
  return res.json({ mode, source: "mt5", results, coverage, scannedAt: now });
});

/**
 * POST /api/desk/auto-select — run the best-market pass immediately.
 *
 * The pass runs by itself while auto-trade is on; this endpoint exists so the
 * user (or the UI's refresh control) can ask "look now" without waiting for the
 * mode's interval to elapse. It is the same pass, with the same gates.
 */
router.post("/auto-select", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!assertLiveConnection(desk, res)) return;
  if (!desk.autoTrade) {
    return res.status(409).json({ error: "Turn auto-trade on: the best-market pass places plans by itself." });
  }
  desk.lastAutoSelectAt = Date.now();
  const outcome = runAutoSelect(desk);
  if (!outcome) return res.status(409).json({ error: "The best-market pass could not run against the current terminal state." });
  return res.json({
    mode: desk.mode,
    chosen: outcome.record.chosen,
    scanned: outcome.record.scanned,
    qualified: outcome.record.qualified,
    reason: outcome.record.reason,
    skipped: outcome.record.skipped,
    ranked: outcome.record.ranked,
    plans: [...desk.plans.values()],
  });
});

// ── Arming and terminal actions ──────────────────────────────────────────────

router.post("/arm", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.body?.symbol ?? "");
  const mode = (String(req.body?.mode ?? desk.mode) as TradeMode) || desk.mode;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
  if (!assertLiveConnection(desk, res)) return;

  const resolved = resolveLiveSymbol(desk, symbol);
  const account = accountFor(desk);
  if (!resolved || !account) return res.status(409).json({ error: `Fresh live MT5 data for ${symbol} is not available yet.` });

  const decision = evaluate({
    symbol,
    mode,
    spec: resolved.spec,
    quote: resolved.quote,
    series: resolved.series,
    account,
    positions: desk.positions,
    specs: desk.specs,
    riskState: desk.riskState,
    policy: desk.policy,
    news: desk.news,
    outcomes: outcomesFor(desk, symbol, mode),
    ...v4InputsFor(desk, symbol, mode),
    ...v4GovernanceInput(desk.sessionId),
  });
  recordDecisionForGovernance({ desk, sessionId: desk.sessionId, decision, nowMs: Date.now() });

  if (!decision.armed || !decision.plan) {
    journal(desk, "no_trade", symbol, decision.summary, decision.rejections);
    return res.status(409).json({ error: "Setup does not pass the A+ live-data gate", rejections: decision.rejections, decision });
  }

  armPlan(desk, decision.plan);
  journal(desk, "signal", symbol, decision.summary, decision.plan.rationale);
  logger.info({ symbol, mode, planId: decision.plan.id }, "Desk plan armed");
  return res.status(201).json({ plan: decision.plan, decision });
});

router.delete("/plans/:id", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const removed = cancelPlan(desk, req.params.id);
  if (!removed) return res.status(404).json({ error: "Plan not found" });
  journal(desk, "signal", null, `Plan ${req.params.id} cancelled by the user.`);
  return res.json({ ok: true });
});

router.post("/positions/:ticket/close", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!desk.terminal) return res.status(409).json({ error: "No MetaTrader 5 terminal is linked." });
  const ticket = Number(req.params.ticket);
  const position = desk.positions.find((candidate) => candidate.ticket === ticket);
  if (!position) return res.status(404).json({ error: "Position not found" });

  const lots = req.body?.lots === undefined ? null : Number(req.body.lots);
  if (lots !== null && (!Number.isFinite(lots) || lots <= 0 || lots > position.volume)) {
    return res.status(400).json({ error: `lots must be between 0 and ${position.volume}` });
  }
  enqueueCommand(desk, lots === null ? { id: randomUUID(), type: "close", ticket } : { id: randomUUID(), type: "close_partial", ticket, lots });
  journal(desk, "execution", position.symbol, `Close ${lots ?? "all"} requested on #${ticket}.`);
  return res.status(202).json({ ok: true });
});

router.post("/flatten", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!desk.terminal) return res.status(409).json({ error: "No MetaTrader 5 terminal is linked." });
  const reason = String(req.body?.reason ?? "Manual kill switch");
  for (const planId of [...desk.plans.keys()]) cancelPlan(desk, planId);
  enqueueCommand(desk, { id: randomUUID(), type: "flatten_all", reason });
  desk.autoTrade = false;
  journal(desk, "risk", null, `Kill switch: ${reason}. Auto-trade disabled, all plans cancelled.`);
  return res.status(202).json({ ok: true });
});

// ── Settings ─────────────────────────────────────────────────────────────────

router.post("/settings", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const body = req.body ?? {};

  if (body.mode !== undefined) {
    if (!VALID_MODES.includes(body.mode)) return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
    desk.mode = body.mode;
  }

  if (body.autoTrade !== undefined) {
    const enable = Boolean(body.autoTrade);
    const problem = enable ? connectionProblem(desk) : null;
    if (problem) return res.status(409).json({ error: problem });
    if (enable && desk.account?.isLive && !desk.policy.liveTradingEnabled) {
      return res.status(409).json({ error: "Enable live trading explicitly before auto-trading a real account." });
    }
    desk.autoTrade = enable;
    journal(desk, "risk", null, `Auto-trade ${enable ? "enabled" : "disabled"}.`);
  }

  if (body.timezone !== undefined) {
    if (!isValidTimezone(body.timezone)) return res.status(400).json({ error: "timezone must be a valid IANA timezone." });
    if (desk.timezone !== body.timezone) {
      desk.timezone = String(body.timezone);
      journal(desk, "bridge", null, `Desk times now shown in ${desk.timezone}.`);
    }
  }

  if (Array.isArray(body.watchlist)) {
    if (desk.catalog.size === 0 && body.watchlist.length > 0) {
      return res.status(409).json({ error: "Waiting for the MT5 EA to provide this broker's market catalogue." });
    }
    const next = [...new Set((body.watchlist as unknown[])
      .map((value) => String(value).trim())
      .filter((symbol) => desk.catalog.get(symbol)?.tradeable))];
    // No selection cap: the EA batches transport to keep requests bounded, and
    // the server refuses to analyse/arm any symbol whose quote is not fresh.
    desk.watchlist = next;
    // Drop quotes/specs/candles for anything just deselected so a stale price
    // cannot linger on the board looking current.
    const pruned = pruneDeselectedSymbols(desk);
    if (pruned > 0) journal(desk, "bridge", null, `${pruned} deselected market(s) removed from live coverage.`);
    journal(desk, "bridge", null, `${next.length} broker market${next.length === 1 ? "" : "s"} selected for live coverage.`);
  }

  if (body.policy && typeof body.policy === "object") {
    desk.policy = sanitisePolicy(desk.policy, body.policy as Record<string, unknown>);
    journal(desk, "risk", null, "Risk policy updated.");
  }

  return res.json({
    mode: desk.mode,
    autoTrade: desk.autoTrade,
    watchlist: desk.watchlist,
    policy: desk.policy,
    timezone: desk.timezone,
    timezones: DESK_TIMEZONES,
  });
});

export function sanitisePolicy(current: RiskPolicy, incoming: Record<string, unknown>): RiskPolicy {
  const num = (key: keyof RiskPolicy, lo: number, hi: number): number => {
    const raw = incoming[key as string];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) return current[key] as number;
    return Math.max(lo, Math.min(hi, value));
  };
  return {
    baseRiskPct: num("baseRiskPct", 0.05, 2),
    maxRiskPct: num("maxRiskPct", 0.1, 2),
    maxDailyLossPct: num("maxDailyLossPct", 0.5, 10),
    maxDrawdownPct: num("maxDrawdownPct", 1, 30),
    // Raised deliberately. There is no per-mode cap on how many setups may be
    // taken — the only limits are risk-based (exposure, daily loss, margin),
    // because a cap on trade count punishes good conditions and protects
    // nothing in bad ones.
    maxOpenPositions: Math.round(num("maxOpenPositions", 1, 50)),
    maxPositionsPerSymbol: Math.round(num("maxPositionsPerSymbol", 1, 10)),
    maxCurrencyExposurePct: num("maxCurrencyExposurePct", 0.5, 10),
    haltAfterConsecutiveLosses: Math.round(num("haltAfterConsecutiveLosses", 2, 20)),
    minMarginLevelPct: num("minMarginLevelPct", 150, 5000),
    symbolCooldownMs: Math.round(num("symbolCooldownMs", 60_000, 24 * 3600_000)),
    liveTradingEnabled: incoming.liveTradingEnabled === undefined ? current.liveTradingEnabled : Boolean(incoming.liveTradingEnabled),
  };
}

router.post("/risk/resume", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.body?.symbol ?? "");
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  desk.riskState = confirmRegimeChange(desk.riskState, symbol);
  journal(desk, "risk", symbol, `${symbol} suspension lifted — regime change confirmed.`);
  return res.json({ state: desk.riskState });
});

router.post("/risk/new-day", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  startNewTradingDay(desk);
  journal(desk, "risk", null, "New trading day — daily loss budget reset.");
  return res.json({ state: desk.riskState, account: desk.account });
});

router.get("/risk/projection", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const winProbability = clampNumber(Number(req.query.winProbability ?? 0.55), 0.05, 0.95);
  const rewardRisk = clampNumber(Number(req.query.rewardRisk ?? 1.6), 0.1, 10);
  const trades = Math.round(clampNumber(Number(req.query.trades ?? 300), 20, 5000));
  const disciplined = equityCurveSimulation({
    winProbability,
    rewardRisk,
    riskPct: desk.policy.baseRiskPct,
    trades,
    lossMultiplier: 1,
    maxRiskPct: desk.policy.maxRiskPct,
  });
  const martingale = equityCurveSimulation({
    winProbability,
    rewardRisk,
    riskPct: desk.policy.baseRiskPct,
    trades,
    lossMultiplier: 2,
    maxRiskPct: 100,
  });
  return res.json({
    assumptions: { winProbability, rewardRisk, trades, riskPct: desk.policy.baseRiskPct },
    disciplined,
    martingale,
    note: "Both runs use the same win rate and reward:risk. The martingale column alone doubles stake after losses; compare its ruin probability.",
  });
});

function clampNumber(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

export default router;
export { DEFAULT_RISK_POLICY };
