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
import { evaluate, horizonMinutes } from "../lib/multiasset/agent";
import { equityCurveSimulation } from "../lib/multiasset/montecarlo";
import { aggregateExposure } from "../lib/multiasset/sizing";
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
const TERMINAL_STALE_MS = 30_000;
const QUOTE_STALE_MS = 15_000;

function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (TIMEFRAMES as readonly string[]).includes(value);
}

function terminalIsFresh(desk: DeskState, now = Date.now()): boolean {
  return Boolean(desk.terminal && now - desk.terminal.lastSyncAt <= TERMINAL_STALE_MS);
}

function connectionProblem(desk: DeskState, now = Date.now()): string | null {
  if (!desk.terminal) return "Link a MetaTrader 5 terminal before requesting live Desk data.";
  if (now - desk.terminal.lastSyncAt > TERMINAL_STALE_MS) {
    return "The MetaTrader 5 terminal heartbeat is stale. New analysis and entries are paused.";
  }
  if (!desk.account) return "Waiting for the paired MetaTrader 5 terminal to send its first account snapshot.";
  return null;
}

/** Only terminal-backed, fresh broker data may enter the agent pipeline. */
function resolveLiveSymbol(
  desk: DeskState,
  symbol: string,
  now = Date.now(),
): { spec: SymbolSpec; quote: Quote; series: Partial<Record<Timeframe, Bar[]>> } | null {
  if (!terminalIsFresh(desk, now)) return null;
  const spec = desk.specs.get(symbol);
  const quote = desk.quotes.get(symbol);
  if (!spec || !quote || now - quote.ts > QUOTE_STALE_MS) return null;
  return { spec, quote, series: seriesFor(desk, symbol) };
}

function symbolReadiness(desk: DeskState, symbol: string, now = Date.now()): "live" | "warming" | "stale" {
  if (!desk.terminal || !terminalIsFresh(desk, now)) return "stale";
  const spec = desk.specs.get(symbol);
  const quote = desk.quotes.get(symbol);
  if (!spec || !quote) return "warming";
  return now - quote.ts <= QUOTE_STALE_MS ? "live" : "stale";
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
    now,
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
    rejections: decision.rejections,
    summary: decision.summary,
  };
}

// ── Desk overview and market universe ────────────────────────────────────────

router.get("/state", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const now = Date.now();
  expirePlans(desk, now);
  const account = accountFor(desk);
  const liveSymbols = desk.watchlist.filter((symbol) => symbolReadiness(desk, symbol, now) === "live");
  const staleSymbols = desk.watchlist.filter((symbol) => symbolReadiness(desk, symbol, now) === "stale");

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
          stale: now - desk.terminal.lastSyncAt > TERMINAL_STALE_MS,
        }
      : null,
    account,
    mode: desk.mode,
    autoTrade: desk.autoTrade,
    watchlist: desk.watchlist,
    market: {
      catalogCount: desk.catalog.size,
      selectedCount: desk.watchlist.length,
      liveSymbols: liveSymbols.length,
      warmingSymbols: desk.watchlist.length - liveSymbols.length - staleSymbols.length,
      staleSymbols: staleSymbols.length,
      quoteFreshForMs: QUOTE_STALE_MS,
    },
    positions: desk.positions,
    plans: [...desk.plans.values()],
    policy: desk.policy,
    risk: {
      state: desk.riskState,
      budget: account ? remainingDailyBudget(account, desk.policy) : null,
      exposure: account ? aggregateExposure(desk.positions, desk.specs, account.equity) : [],
    },
    news: desk.news,
    journal: desk.journal.slice(0, 50),
    serverTime: now,
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

/** Quotes for the user's selected symbols; absent quotes are explicitly null. */
router.get("/instruments", (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const now = Date.now();
  const instruments = desk.watchlist.map((symbol) => {
    const catalog = desk.catalog.get(symbol);
    const spec = desk.specs.get(symbol);
    const quote = desk.quotes.get(symbol);
    const series = seriesFor(desk, symbol).M5 ?? [];
    const first = series.length > 0 ? series[0]?.[4] : null;
    const last = series.length > 0 ? series[series.length - 1]?.[4] : null;
    return {
      symbol,
      description: catalog?.description ?? symbol,
      assetClass: catalog?.assetClass ?? spec?.assetClass ?? "other",
      digits: spec?.digits ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spreadPoints: quote?.spreadPoints ?? null,
      changePct: first && last ? ((last - first) / first) * 100 : null,
      watched: true,
      dataStatus: symbolReadiness(desk, symbol, now),
      lastQuoteAt: quote?.ts ?? null,
    };
  });
  res.json({ source: desk.terminal ? "mt5" : "unlinked", instruments });
});

/** Retained as a live-data API for the agent and integrations; no Desk chart uses it. */
router.get("/candles", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbol = String(req.query.symbol ?? "");
  const timeframe = req.query.timeframe;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!isTimeframe(timeframe)) return res.status(400).json({ error: `timeframe must be one of ${TIMEFRAMES.join(", ")}` });
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
  });

  return res.json({
    source: "mt5",
    horizonMinutes: horizonMinutes(mode),
    decision: {
      ...decision,
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
  });

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
    journal(desk, "bridge", null, `${next.length} broker market${next.length === 1 ? "" : "s"} selected for live coverage.`);
  }

  if (body.policy && typeof body.policy === "object") {
    desk.policy = sanitisePolicy(desk.policy, body.policy as Record<string, unknown>);
    journal(desk, "risk", null, "Risk policy updated.");
  }

  return res.json({ mode: desk.mode, autoTrade: desk.autoTrade, watchlist: desk.watchlist, policy: desk.policy });
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
    maxOpenPositions: Math.round(num("maxOpenPositions", 1, 20)),
    maxPositionsPerSymbol: Math.round(num("maxPositionsPerSymbol", 1, 5)),
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
