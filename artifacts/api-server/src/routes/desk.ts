/**
 * Multi-Asset Desk — terminal-facing API.
 *
 * Everything the Bloomberg-style terminal needs: instruments, quotes, candles,
 * agent analysis, armed plans, positions and the live risk budget.
 *
 * Until a MetaTrader 5 terminal is paired the desk answers from the
 * deterministic replay feed (lib/multiasset/simulator.ts) so the UI is fully
 * functional — and every response says which source it came from, because a
 * trading screen that cannot tell you whether its prices are real is worse
 * than no screen at all.
 */

import { Router, type IRouter } from "express";
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
  simulatedAccount,
  simulatedCandles,
  simulatedQuote,
  simulatedSpec,
  simulatedSymbols,
} from "../lib/multiasset/simulator";
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

/**
 * Resolve a symbol's spec, quote and series from the live terminal when one is
 * paired and from the replay feed otherwise.
 *
 * Centralised so no route can accidentally mix a live spec with simulated
 * prices — sizing computed from one broker's spec against another feed's
 * prices would be wrong in a way that is very hard to notice.
 */
function resolveSymbol(
  desk: DeskState,
  symbol: string,
): { spec: SymbolSpec; quote: Quote; series: Partial<Record<Timeframe, Bar[]>>; live: boolean } | null {
  if (!desk.simulated) {
    const spec = desk.specs.get(symbol);
    const quote = desk.quotes.get(symbol);
    if (!spec || !quote) return null;
    return { spec, quote, series: seriesFor(desk, symbol), live: true };
  }

  const spec = simulatedSpec(symbol);
  const quote = simulatedQuote(symbol);
  if (!spec || !quote) return null;

  const series: Partial<Record<Timeframe, Bar[]>> = {};
  for (const timeframe of TIMEFRAMES) {
    const candles = simulatedCandles(symbol, timeframe);
    if (candles) series[timeframe] = candles.bars;
  }
  return { spec, quote, series, live: false };
}

function accountFor(desk: DeskState) {
  return desk.account ?? simulatedAccount();
}

function specMap(desk: DeskState): Map<string, SymbolSpec> {
  if (!desk.simulated) return desk.specs;
  const map = new Map<string, SymbolSpec>();
  for (const symbol of simulatedSymbols()) {
    const spec = simulatedSpec(symbol);
    if (spec) map.set(symbol, spec);
  }
  return map;
}

// ── Desk overview ────────────────────────────────────────────────────────────

/** GET /api/desk/state — one call that boots the whole terminal. */
router.get("/state", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  expirePlans(desk);

  const account = accountFor(desk);
  const specs = specMap(desk);
  const budget = remainingDailyBudget(account, desk.policy);

  res.json({
    source: desk.simulated ? "replay" : "mt5",
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
          stale: Date.now() - desk.terminal.lastSyncAt > 30_000,
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
      budget,
      exposure: aggregateExposure(desk.positions, specs, account.equity),
    },
    journal: desk.journal.slice(0, 50),
    serverTime: Date.now(),
  });
});

/** GET /api/desk/instruments — the tradeable universe with live quotes. */
router.get("/instruments", (req, res) => {
  const desk = getDesk(getBrowserSessionId());
  const symbols = desk.simulated ? simulatedSymbols() : [...desk.specs.keys()];

  const instruments = symbols
    .map((symbol) => {
      const resolved = resolveSymbol(desk, symbol);
      if (!resolved) return null;
      const m5 = resolved.series.M5 ?? [];
      const first = m5.length > 0 ? m5[0][4] : null;
      const last = m5.length > 0 ? m5[m5.length - 1][4] : null;
      return {
        symbol,
        assetClass: resolved.spec.assetClass,
        digits: resolved.spec.digits,
        bid: resolved.quote.bid,
        ask: resolved.quote.ask,
        spreadPoints: resolved.quote.spreadPoints,
        // Session change over the M5 window we hold — enough for a quote board.
        changePct: first && last ? ((last - first) / first) * 100 : 0,
        watched: desk.watchlist.includes(symbol),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  res.json({ source: desk.simulated ? "replay" : "mt5", instruments });
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

  const resolved = resolveSymbol(desk, symbol);
  if (!resolved) return res.status(404).json({ error: `No data for ${symbol}` });

  const bars = resolved.series[timeframe] ?? [];
  return res.json({
    symbol,
    timeframe,
    source: resolved.live ? "mt5" : "replay",
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

  const resolved = resolveSymbol(desk, symbol);
  if (!resolved) return res.status(404).json({ error: `No data for ${symbol}` });

  const account = accountFor(desk);
  const decision = evaluate({
    symbol,
    mode,
    spec: resolved.spec,
    quote: resolved.quote,
    series: resolved.series,
    account,
    positions: desk.positions,
    specs: specMap(desk),
    riskState: desk.riskState,
    policy: desk.policy,
  });

  return res.json({
    source: resolved.live ? "mt5" : "replay",
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

  const account = accountFor(desk);
  const specs = specMap(desk);

  const results = desk.watchlist
    .map((symbol) => {
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

  return res.json({ mode, source: desk.simulated ? "replay" : "mt5", results, scannedAt: Date.now() });
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

  const resolved = resolveSymbol(desk, symbol);
  if (!resolved) return res.status(404).json({ error: `No data for ${symbol}` });

  const decision = evaluate({
    symbol,
    mode,
    spec: resolved.spec,
    quote: resolved.quote,
    series: resolved.series,
    account: accountFor(desk),
    positions: desk.positions,
    specs: specMap(desk),
    riskState: desk.riskState,
    policy: desk.policy,
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

  if (body.autoTrade !== undefined) {
    const enable = Boolean(body.autoTrade);
    // Auto-trading a real account requires the explicit live flag as well;
    // defaulting to "on" for a funded account is not a defensible default.
    if (enable && desk.account?.isLive && !desk.policy.liveTradingEnabled) {
      return res.status(409).json({
        error: "Enable live trading explicitly before auto-trading a real account.",
      });
    }
    desk.autoTrade = enable;
    journal(desk, "risk", null, `Auto-trade ${enable ? "enabled" : "disabled"}.`);
  }

  if (Array.isArray(body.watchlist)) {
    const available = new Set(desk.simulated ? simulatedSymbols() : [...desk.specs.keys()]);
    const next: string[] = (body.watchlist as unknown[])
      .map((s: unknown) => String(s))
      .filter((s: string) => available.size === 0 || available.has(s));
    if (next.length > 0) desk.watchlist = [...new Set(next)].slice(0, 20);
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

/**
 * GET /api/desk/risk/projection
 *
 * Simulates the equity curve under the desk's current settings, and under a
 * martingale progression for comparison. This is deliberately prominent: it
 * is the evidence behind the refusal to implement loss-chasing stakes.
 */
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
    note:
      "Both runs use the same win rate and reward:risk. The only difference is that " +
      "the martingale column doubles stake after every loss. Compare the ruin probabilities.",
  });
});

function clampNumber(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

export default router;
export { DEFAULT_RISK_POLICY };
