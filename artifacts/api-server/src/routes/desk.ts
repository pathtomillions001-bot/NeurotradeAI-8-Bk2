/**
 * Multi-Asset Desk — terminal-facing API.
 *
 * Everything the Bloomberg-style terminal needs: instruments, quotes, candles,
 * agent analysis, armed plans, positions and the live risk budget.
 *
 * This API is live-only. Until a MetaTrader 5 terminal is paired, it returns
 * an empty broker catalog and no account/market values. Stale or missing ticks
 * are never replaced with a replay price.
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { getBrowserSessionId } from "../lib/session";
import { logger } from "../lib/logger";
import { evaluate, horizonMinutes } from "../lib/multiasset/agent";
import { aggregateExposure } from "../lib/multiasset/sizing";
import {
  NEWS_BLACKOUT_AFTER_MS,
  NEWS_BLACKOUT_BEFORE_MS,
  NEWS_CALENDAR_MAX_AGE_MS,
  getNewsCalendarStatus,
  isNewsCalendarReady,
  newsGuardFromSnapshot,
  relevantNewsEvents,
} from "../lib/multiasset/news";
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
  seriesFor,
  startNewTradingDay,
  type DeskState,
} from "../lib/multiasset/store";
import {
  TIMEFRAMES,
  type Bar,
  type Quote,
  type SymbolSpec,
  type Timeframe,
  type TradeMode,
} from "../lib/multiasset/types";

const router: IRouter = Router();

const VALID_MODES: TradeMode[] = ["scalp", "intraday", "swing"];

function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (TIMEFRAMES as readonly string[]).includes(value);
}

/** Quotes and terminal heartbeats older than this are not actionable. */
export const LIVE_DATA_MAX_AGE_MS = 30_000;
const MIN_ANALYSIS_BARS = 60;

function isFreshTimestamp(timestamp: number, now = Date.now()): boolean {
  return Number.isFinite(timestamp) && timestamp <= now + 5_000 && now - timestamp <= LIVE_DATA_MAX_AGE_MS;
}

function liveFeedError(desk: DeskState, now = Date.now()): string | null {
  if (!desk.terminal) return "Link a MetaTrader 5 terminal to load broker data.";
  if (now - desk.terminal.lastSyncAt > LIVE_DATA_MAX_AGE_MS) {
    return "MT5 connection is stale. Reconnect the terminal before using market data or execution.";
  }
  if (!desk.account) return "Waiting for the first real account snapshot from MT5.";
  return null;
}

/** Only resolves broker-reported data with a current account heartbeat and quote. */
function resolveSymbol(
  desk: DeskState,
  symbol: string,
  now = Date.now(),
): { spec: SymbolSpec; quote: Quote; series: Partial<Record<Timeframe, Bar[]>> } | null {
  if (liveFeedError(desk, now)) return null;
  const spec = desk.specs.get(symbol);
  const quote = desk.quotes.get(symbol);
  if (!spec || !quote || !isFreshTimestamp(quote.ts, now)) return null;
  return { spec, quote, series: seriesFor(desk, symbol) };
}

function specMap(desk: DeskState): Map<string, SymbolSpec> {
  return desk.specs;
}

function dataErrorForSymbol(desk: DeskState, symbol: string, now = Date.now()): string | null {
  const feedError = liveFeedError(desk, now);
  if (feedError) return feedError;
  if (!desk.universe.has(symbol)) return `${symbol} is not listed by the linked MT5 broker.`;
  if (!desk.watchlist.includes(symbol)) return `Add ${symbol} to the live watchlist before analysing it.`;
  const spec = desk.specs.get(symbol);
  const quote = desk.quotes.get(symbol);
  if (!spec || !quote) return `Waiting for MT5 to subscribe to ${symbol} and send its live quote.`;
  if (!isFreshTimestamp(quote.ts, now)) return `The latest MT5 quote for ${symbol} is stale; no trade will be evaluated.`;
  const series = seriesFor(desk, symbol);
  const missing = TIMEFRAMES.find((timeframe) => (series[timeframe]?.length ?? 0) < MIN_ANALYSIS_BARS);
  if (missing) {
    const bars = series[missing]?.length ?? 0;
    return `Loading live ${missing} history for ${symbol} (${bars}/${MIN_ANALYSIS_BARS} bars).`;
  }
  return null;
}

function analysisReady(desk: DeskState, symbol: string, now = Date.now()): boolean {
  return dataErrorForSymbol(desk, symbol, now) === null;
}

function newsStateForDesk(desk: DeskState, now: number) {
  const status = getNewsCalendarStatus(desk.newsCalendar, now);
  const ready = status === "ready";
  const selectedSymbols = desk.watchlist;
  const events = ready
    ? desk.newsCalendar.events
        .filter((event) => event.ts >= now - NEWS_BLACKOUT_AFTER_MS && event.ts <= now + 48 * 60 * 60_000)
        .map((event) => {
          const affectedSymbols = selectedSymbols.filter((symbol) =>
            relevantNewsEvents([event], desk.specs.get(symbol)).length > 0,
          );
          if (selectedSymbols.length > 0 && affectedSymbols.length === 0) return null;
          const blackoutStart = event.ts - NEWS_BLACKOUT_BEFORE_MS;
          const blackoutEnd = event.ts + NEWS_BLACKOUT_AFTER_MS;
          return {
            ...event,
            affectedSymbols,
            blackoutStart,
            blackoutEnd,
            minutesUntil: Math.round((event.ts - now) / 60_000),
            inBlackout: now >= blackoutStart && now <= blackoutEnd,
          };
        })
        .filter((event): event is NonNullable<typeof event> => event !== null)
        .slice(0, 100)
    : [];
  return {
    status,
    ready,
    fetchedAt: desk.newsCalendar.fetchedAt,
    ageMs: desk.newsCalendar.fetchedAt === null ? null : Math.max(0, now - desk.newsCalendar.fetchedAt),
    error: ready
      ? null
      : desk.newsCalendar.error ?? (status === "stale"
        ? "The last MT5 calendar snapshot is stale or does not cover the required window."
        : status === "unknown"
          ? "Waiting for a verified MT5 economic-calendar snapshot."
          : "MT5 economic calendar is unavailable."),
    blackoutBeforeMs: NEWS_BLACKOUT_BEFORE_MS,
    blackoutAfterMs: NEWS_BLACKOUT_AFTER_MS,
    staleAfterMs: NEWS_CALENDAR_MAX_AGE_MS,
    events,
  };
}

// ── Desk overview ────────────────────────────────────────────────────────────

/** GET /api/desk/state — one call that boots the whole terminal. */
router.get("/state", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  expirePlans(desk);

  const account = desk.account;
  const specs = specMap(desk);
  const now = Date.now();
  const feedError = liveFeedError(desk, now);

  res.json({
    source: desk.terminal ? "mt5" : "unlinked",
    feedReady: feedError === null,
    feedError,
    news: newsStateForDesk(desk, now),
    catalogCount: desk.universe.size,
    terminal: desk.terminal
      ? {
          accountId: desk.terminal.accountId,
          login: desk.terminal.login,
          server: desk.terminal.server,
          company: desk.terminal.company,
          pairedAt: desk.terminal.pairedAt,
          lastSyncAt: desk.terminal.lastSyncAt,
          // A terminal that stopped syncing must be visibly stale, not
          // silently shown as connected.
          stale: !isFreshTimestamp(desk.terminal.lastSyncAt, now),
        }
      : null,
    account,
    mode: desk.mode,
    autoTrade: desk.autoTrade,
    watchlist: desk.watchlist,
    positions: desk.positions,
    plans: [...desk.plans.values()],
    policy: desk.policy,
    risk: {
      state: desk.riskState,
      budget: account ? remainingDailyBudget(account, desk.policy) : null,
      exposure: account ? aggregateExposure(desk.positions, specs, account.equity) : [],
    },
    journal: desk.journal.slice(0, 50),
    serverTime: Date.now(),
  });
});

/** GET /api/desk/instruments — the linked broker catalog, with live quotes when subscribed. */
router.get("/instruments", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const now = Date.now();
  const feedReady = liveFeedError(desk, now) === null;
  const instruments = [...desk.universe.values()]
    .map((entry) => {
      const spec = desk.specs.get(entry.symbol);
      const quote = desk.quotes.get(entry.symbol);
      const m5 = seriesFor(desk, entry.symbol).M5 ?? [];
      const first = m5.length > 0 ? m5[0][4] : null;
      const last = m5.length > 0 ? m5[m5.length - 1][4] : null;
      const dataFresh = !!quote && feedReady && isFreshTimestamp(quote.ts, now);
      return {
        ...entry,
        digits: spec?.digits ?? 5,
        bid: quote?.bid ?? null,
        ask: quote?.ask ?? null,
        spreadPoints: quote?.spreadPoints ?? null,
        changePct: first && last ? ((last - first) / first) * 100 : null,
        watched: desk.watchlist.includes(entry.symbol),
        subscribed: !!spec,
        dataFresh,
        quoteTs: quote?.ts ?? null,
        quoteAgeMs: quote ? Math.max(0, now - quote.ts) : null,
      };
    })
    .sort((a, b) => a.assetClass.localeCompare(b.assetClass) || a.symbol.localeCompare(b.symbol));

  res.json({ source: desk.terminal ? "mt5" : "unlinked", feedReady, instruments });
});

/** GET /api/desk/candles?symbol=&timeframe= */
router.get("/candles", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.query.symbol ?? "");
  const timeframe = req.query.timeframe;

  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!isTimeframe(timeframe)) {
    return res.status(400).json({ error: `timeframe must be one of ${TIMEFRAMES.join(", ")}` });
  }

  const feedError = liveFeedError(desk);
  if (feedError) return res.status(409).json({ error: feedError });
  const resolved = resolveSymbol(desk, symbol);
  if (!resolved) return res.status(409).json({ error: dataErrorForSymbol(desk, symbol) ?? `Waiting for live data for ${symbol}.` });

  const bars = resolved.series[timeframe] ?? [];
  return res.json({
    symbol,
    timeframe,
    source: "mt5",
    spec: resolved.spec,
    quote: resolved.quote,
    bars,
  });
});

// ── Agent analysis ───────────────────────────────────────────────────────────

/**
 * GET /api/desk/analysis?symbol=&mode=
 *
 * The full decision, armed or not. A no-trade answer is as detailed as a
 * signal: it lists every gate that failed.
 */
router.get("/analysis", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.query.symbol ?? "");
  const mode = (String(req.query.mode ?? desk.mode) as TradeMode) || desk.mode;

  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
  }

  const dataError = dataErrorForSymbol(desk, symbol);
  if (dataError) return res.status(409).json({ error: dataError, source: desk.terminal ? "mt5" : "unlinked" });
  const resolved = resolveSymbol(desk, symbol);
  if (!resolved || !desk.account) return res.status(409).json({ error: `Waiting for live MT5 data for ${symbol}.` });

  const decision = evaluate({
    symbol,
    mode,
    spec: resolved.spec,
    quote: resolved.quote,
    series: resolved.series,
    account: desk.account,
    positions: desk.positions,
    specs: specMap(desk),
    riskState: desk.riskState,
    policy: desk.policy,
    news: newsGuardFromSnapshot(desk.newsCalendar),
  });

  return res.json({
    source: "mt5",
    horizonMinutes: horizonMinutes(mode),
    decision: {
      ...decision,
      // The per-timeframe regime detail is large; send a display-shaped subset.
      confluence: {
        ...decision.confluence,
        views: decision.confluence.views.map((view) => ({
          timeframe: view.timeframe,
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
    },
  });
});

/** GET /api/desk/scan?mode= — analysis across the whole watchlist, ranked. */
router.get("/scan", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const mode = (String(req.query.mode ?? desk.mode) as TradeMode) || desk.mode;
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
  }

  const feedError = liveFeedError(desk);
  if (feedError || !desk.account) {
    return res.json({
      mode,
      source: desk.terminal ? "mt5" : "unlinked",
      results: [],
      waitingSymbols: desk.watchlist,
      unavailableReason: feedError ?? "Waiting for the real MT5 account snapshot.",
      scannedAt: Date.now(),
    });
  }

  const account = desk.account;
  const specs = specMap(desk);
  const waitingSymbols = desk.watchlist.filter((symbol) => !analysisReady(desk, symbol));

  const results = desk.watchlist
    .map((symbol) => {
      if (!analysisReady(desk, symbol)) return null;
      const resolved = resolveSymbol(desk, symbol);
      if (!resolved) return null;
      const decision = evaluate({
        symbol,
        mode,
        spec: resolved.spec,
        quote: resolved.quote,
        series: resolved.series,
        account,
        positions: desk.positions,
        specs,
        riskState: desk.riskState,
        policy: desk.policy,
        news: newsGuardFromSnapshot(desk.newsCalendar),
      });
      return {
        symbol,
        armed: decision.armed,
        direction: decision.confluence.direction,
        score: Number(decision.confluence.score.toFixed(1)),
        grade: decision.confluence.grade,
        expectancyR: decision.monteCarlo ? Number(decision.monteCarlo.expectancyR.toFixed(3)) : null,
        winProbability: decision.monteCarlo
          ? Number(decision.monteCarlo.winProbability.toFixed(3))
          : null,
        lots: decision.sizing?.ok ? decision.sizing.lots : null,
        riskMoney: decision.sizing?.ok ? Number(decision.sizing.riskMoney.toFixed(2)) : null,
        rejections: decision.rejections,
        summary: decision.summary,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    // Armed setups first, then by score — the ranking a desk actually wants.
    .sort((a, b) => Number(b.armed) - Number(a.armed) || b.score - a.score);

  return res.json({ mode, source: "mt5", results, waitingSymbols, scannedAt: Date.now() });
});

// ── Arming ───────────────────────────────────────────────────────────────────

/**
 * POST /api/desk/arm { symbol, mode }
 *
 * Re-runs the agent and, if every gate passes, queues the plan for the EA.
 * The decision is never taken from a cached analysis: between the user
 * looking at a signal and clicking it, price, spread and exposure all move.
 */
router.post("/arm", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.body?.symbol ?? "");
  const mode = (String(req.body?.mode ?? desk.mode) as TradeMode) || desk.mode;

  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
  }

  const dataError = dataErrorForSymbol(desk, symbol);
  if (dataError) return res.status(409).json({ error: dataError });
  if (!desk.autoTrade) {
    return res.status(409).json({ error: "Enable execution after reviewing the live account and risk settings before arming a plan." });
  }
  const resolved = resolveSymbol(desk, symbol);
  if (!resolved || !desk.account) return res.status(409).json({ error: `Waiting for live MT5 data for ${symbol}.` });

  const decision = evaluate({
    symbol,
    mode,
    spec: resolved.spec,
    quote: resolved.quote,
    series: resolved.series,
    account: desk.account,
    positions: desk.positions,
    specs: specMap(desk),
    riskState: desk.riskState,
    policy: desk.policy,
    news: newsGuardFromSnapshot(desk.newsCalendar),
  });

  if (!decision.armed || !decision.plan) {
    journal(desk, "no_trade", symbol, decision.summary, decision.rejections);
    return res.status(409).json({
      error: "Setup does not pass the A+ gate",
      rejections: decision.rejections,
      decision,
    });
  }

  if (!desk.terminal) {
    // Arming without a terminal would be theatre: the plan has nowhere to go.
    journal(desk, "no_trade", symbol, "Plan not armed — no MetaTrader 5 terminal is linked.");
    return res.status(409).json({
      error: "No MetaTrader 5 terminal is linked to this session.",
      hint: "Install NeurotradeBridge.mq5 and pair it from the terminal page.",
      decision,
    });
  }

  armPlan(desk, decision.plan);
  journal(desk, "signal", symbol, decision.summary, decision.plan.rationale);
  logger.info({ symbol, mode, planId: decision.plan.id }, "Desk plan armed");

  return res.status(201).json({ plan: decision.plan, decision });
});

/** DELETE /api/desk/plans/:id */
router.delete("/plans/:id", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const removed = cancelPlan(desk, req.params.id);
  if (!removed) return res.status(404).json({ error: "Plan not found" });
  journal(desk, "signal", null, `Plan ${req.params.id} cancelled by the user.`);
  return res.json({ ok: true });
});

// ── Position actions ─────────────────────────────────────────────────────────

router.post("/positions/:ticket/close", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const ticket = Number(req.params.ticket);
  const position = desk.positions.find((p) => p.ticket === ticket);
  if (!position) return res.status(404).json({ error: "Position not found" });

  const lots = req.body?.lots === undefined ? null : Number(req.body.lots);
  if (lots !== null && (!Number.isFinite(lots) || lots <= 0 || lots > position.volume)) {
    return res.status(400).json({ error: `lots must be between 0 and ${position.volume}` });
  }

  enqueueCommand(
    desk,
    lots === null
      ? { id: randomUUID(), type: "close", ticket }
      : { id: randomUUID(), type: "close_partial", ticket, lots },
  );
  journal(desk, "execution", position.symbol, `Close ${lots ?? "all"} requested on #${ticket}.`);
  return res.status(202).json({ ok: true });
});

/** POST /api/desk/flatten — the kill switch. */
router.post("/flatten", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const reason = String(req.body?.reason ?? "Manual kill switch");

  // Cancel armed plans too: flattening while a plan is still armed would let
  // the EA immediately re-enter the position the user just killed.
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
    if (!VALID_MODES.includes(body.mode)) {
      return res.status(400).json({ error: `mode must be one of ${VALID_MODES.join(", ")}` });
    }
    desk.mode = body.mode;
  }

  if (Array.isArray(body.watchlist)) {
    const available = new Set(desk.universe.keys());
    const next = [...new Set((body.watchlist as unknown[])
      .map((value: unknown) => String(value).trim())
      .filter((symbol: string) => available.has(symbol)))];
    // Empty selection is valid: it immediately unsubscribes every unneeded feed.
    desk.watchlist = next;
  }

  if (body.autoTrade !== undefined) {
    const enable = Boolean(body.autoTrade);
    if (enable) {
      const feedError = liveFeedError(desk);
      if (feedError) return res.status(409).json({ error: feedError });
      if (!isNewsCalendarReady(desk.newsCalendar)) {
        return res.status(409).json({ error: "Confirm a fresh, complete MT5 high-impact economic calendar before enabling execution. New entries remain blocked while news data is stale or unavailable." });
      }
      if (!desk.watchlist.length) {
        return res.status(409).json({ error: "Select at least one broker instrument before enabling execution." });
      }
      if (!desk.watchlist.some((symbol) => analysisReady(desk, symbol))) {
        return res.status(409).json({ error: "Wait for fresh quotes and live history on a selected instrument before enabling execution." });
      }
      // Auto-trading a real account requires the explicit live flag as well;
      // defaulting to "on" for a funded account is not a defensible default.
      if (desk.account?.isLive && !desk.policy.liveTradingEnabled) {
        return res.status(409).json({
          error: "Enable live trading explicitly before auto-trading a real account.",
        });
      }
    }
    desk.autoTrade = enable;
    journal(desk, "risk", null, `Execution ${enable ? "enabled" : "disabled"}.`);
  }

  if (body.policy && typeof body.policy === "object") {
    desk.policy = sanitisePolicy(desk.policy, body.policy);
    journal(desk, "risk", null, "Risk policy updated.");
  }

  return res.json({ mode: desk.mode, autoTrade: desk.autoTrade, watchlist: desk.watchlist, policy: desk.policy });
});

/**
 * Clamp every policy field to a defensible range.
 *
 * The UI is not the security boundary: a hand-rolled POST must not be able to
 * set a 90% daily loss limit or a 50% per-trade risk.
 */
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
    maxOpenPositions: Math.round(num("maxOpenPositions", 1, 20)),
    maxPositionsPerSymbol: Math.round(num("maxPositionsPerSymbol", 1, 5)),
    maxCurrencyExposurePct: num("maxCurrencyExposurePct", 0.5, 10),
    haltAfterConsecutiveLosses: Math.round(num("haltAfterConsecutiveLosses", 2, 20)),
    minMarginLevelPct: num("minMarginLevelPct", 150, 5000),
    symbolCooldownMs: Math.round(num("symbolCooldownMs", 60_000, 24 * 3600_000)),
    liveTradingEnabled:
      incoming.liveTradingEnabled === undefined
        ? current.liveTradingEnabled
        : Boolean(incoming.liveTradingEnabled),
  };
}

/** POST /api/desk/risk/resume { symbol } — lift a suspension after a regime change. */
router.post("/risk/resume", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.body?.symbol ?? "");
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  desk.riskState = confirmRegimeChange(desk.riskState, symbol);
  journal(desk, "risk", symbol, `${symbol} suspension lifted — regime change confirmed.`);
  return res.json({ state: desk.riskState });
});

/** POST /api/desk/risk/new-day — reset the daily baselines. */
router.post("/risk/new-day", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  startNewTradingDay(desk);
  journal(desk, "risk", null, "New trading day — daily loss budget reset.");
  return res.json({ state: desk.riskState, account: desk.account });
});


export default router;
export { DEFAULT_RISK_POLICY };
