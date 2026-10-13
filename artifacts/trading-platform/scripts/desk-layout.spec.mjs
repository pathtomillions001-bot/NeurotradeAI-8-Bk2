#!/usr/bin/env node
/**
 * v5 Desk — the browser layout contract (dev deliverable; the app never
 * imports this).
 *
 * WHY THIS EXISTS: the Desk's promise is that four workspaces tile a viewport
 * exactly — no horizontal overflow, no overlapping panels, one column template
 * and one row height per table — at 1440x900, 1280x800, 1024x768 and 390x844.
 * The pure contract test (src/components/desk/desk-layout.test.ts) proves the
 * NUMBERS tile; this script proves the RENDERED page obeys them, keeps the
 * historical data-testids, moves tab focus with arrow keys, and contains no
 * charts anywhere.
 *
 * HOW TO RUN (needs a local playwright install — deliberately NOT a package
 * dependency, per the no-new-deps rule):
 *
 *   pnpm --filter @workspace/trading-platform dev        # or any deployed URL
 *   npm i -D playwright && npx playwright install chromium
 *   BASE_URL=http://localhost:5000 node scripts/desk-layout.spec.mjs
 *
 * Every API response is intercepted with clearly synthetic fixtures of the
 * REAL wire shapes, so the spec measures the true UI code without needing a
 * paired MT5 terminal. Screenshots land in ./desk-layout-shots/ (override
 * with OUT_DIR) — {w}x{h}-{tab}.png, one per viewport per workspace, plus
 * the unlinked card and the /learning redirect.
 *
 * Exit code 0 = all checks passed; 1 = at least one failure (each failure is
 * printed with the viewport, tab and measurement that broke).
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const OUT_DIR = process.env.OUT_DIR ?? new URL("./desk-layout-shots/", import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
];
const TABS = ["command", "markets", "learning", "journal"];

/** The documented row-height set (desk-layout.ts) + the 24px table header. */
const ALLOWED_ROW_HEIGHTS = new Set([24, 28, 29, 30, 32, 34, 36, 40, 44, 48]);

const NOW = Date.now();

// ── synthetic fixtures in the real wire shapes ─────────────────────────────
// These numbers exist ONLY to drive layout; they are never shown to a user of
// the product (the app itself keeps rendering API-only data).

const INSTRUMENTS = [
  { symbol: "EURUSD", description: "Euro vs US dollar", assetClass: "forex", digits: 5, bid: 1.08421, ask: 1.08433, spreadPoints: 1.2, changePct: 0.24, watched: true, dataStatus: "live", lastQuoteAt: NOW - 400, quoteAgeMs: 400, priceWarning: null, deviationPct: null, sessionHigh: 1.0855, sessionLow: 1.0811, sparkline: [], contractSize: 100000, point: 0.00001 },
  { symbol: "GBPUSD", description: "Pound vs US dollar", assetClass: "forex", digits: 5, bid: 1.27011, ask: 1.27029, spreadPoints: 1.8, changePct: -0.12, watched: true, dataStatus: "live", lastQuoteAt: NOW - 900, quoteAgeMs: 900, priceWarning: null, deviationPct: null, sessionHigh: null, sessionLow: null, sparkline: [], contractSize: 100000, point: 0.00001 },
  { symbol: "XAUUSD", description: "Gold vs US dollar", assetClass: "metals", digits: 2, bid: 2401.35, ask: 2401.71, spreadPoints: 36, changePct: 0.41, watched: true, dataStatus: "warming", lastQuoteAt: NOW - 5200, quoteAgeMs: 5200, priceWarning: null, deviationPct: null, sessionHigh: null, sessionLow: null, sparkline: [], contractSize: 100, point: 0.01 },
];

const STATE = {
  source: "mt5",
  terminal: {
    accountId: "51234567", login: 51234567, server: "Demo-Server", company: "Demo Broker Ltd",
    pairedAt: NOW - 3_600_000, lastSyncAt: NOW - 800, lastSyncAgeMs: 800, stale: false, degraded: false,
    degradedAfterMs: 30_000, staleAfterMs: 120_000, syncIntervalMs: 1000,
  },
  account: { balance: 10_000, equity: 10_128.6, margin: 120.4, freeMargin: 10_008.2, marginLevel: 8412.3, currency: "USD", leverage: 100, mode: "netting", isLive: false, dayStartEquity: 10_000, peakEquity: 10_400 },
  mode: "intraday",
  autoTrade: false,
  watchlist: ["EURUSD", "GBPUSD", "XAUUSD"],
  timezone: "Africa/Nairobi",
  timezones: [{ id: "Africa/Nairobi", label: "Nairobi · EAT" }, { id: "UTC", label: "UTC" }],
  market: { catalogCount: 40, selectedCount: 3, liveSymbols: 2, warmingSymbols: 1, staleSymbols: 0, mismatchSymbols: 0, quoteFreshForMs: 8000 },
  feed: { clockSkewMs: 120, clockWarning: null, lastQuoteAgeMs: 400, quoteFreshForMs: 8000 },
  positions: [
    { ticket: 91011, symbol: "EURUSD", side: "buy", volume: 0.1, openPrice: 1.0831, openTime: NOW - 5_400_000, sl: 1.0831, tp: 1.0899, profit: 111.2, swap: -0.4, commission: -0.7, initialRiskMoney: 90, managementState: "be" },
    { ticket: 91012, symbol: "GBPUSD", side: "sell", volume: 0.05, openPrice: 1.2712, openTime: NOW - 1_800_000, sl: 1.2745, tp: 1.2655, profit: -21.9, swap: 0, commission: -0.35, initialRiskMoney: undefined, managementState: "open" },
  ],
  plans: [
    { id: "plan-1", symbol: "XAUUSD", side: "buy", mode: "intraday", trigger: 2400.1, triggerType: "limit", invalidate: 2396.0, sl: 2397.5, tp: [2406.5], lots: 0.05, riskMoney: 30, riskPoints: 260, expiresAt: NOW + 252_000, createdAt: NOW - 60_000 },
  ],
  policy: { baseRiskPct: 0.25, maxRiskPct: 0.35, maxDailyLossPct: 2.5, maxDrawdownPct: 6, maxOpenPositions: 6, maxPositionsPerSymbol: 2, maxCurrencyExposurePct: 1.2, haltAfterConsecutiveLosses: 4, minMarginLevelPct: 200, symbolCooldownMs: 0, liveTradingEnabled: false },
  risk: {
    state: { consecutiveLosses: 1, suspendedSymbols: ["GBPUSD"], realisedPnlToday: 128.6, tradesToday: 3, haltedUntilNextSession: false, haltReason: null },
    budget: { usedPct: 30, remainingMoney: 175, limitMoney: 250 },
    exposure: [{ key: "EUR", riskMoney: 90, riskPct: 0.89 }, { key: "GBP", riskMoney: 12, riskPct: 0.12 }],
  },
  news: { available: true, checkedAt: NOW - 30_000, events: [], rawCount: 12, redCount: 2 },
  newsUpcoming: [
    { id: "n1", time: NOW + 5_400_000, currency: "USD", country: "US", name: "Core CPI m/m", importance: "high", inMs: 5_400_000, next: true, passed: false },
    { id: "n2", time: NOW - 3_600_000, currency: "EUR", country: "DE", name: "ifo Business Climate", importance: "high", inMs: -3_600_000, next: false, passed: true },
  ],
  autoSelect: { last: { at: NOW - 640_000, mode: "intraday", scanned: 3, qualified: 1, chosen: "EURUSD", reason: "Chose EURUSD on the lower-bound edge.", skipped: ["XAUUSD"], ranked: [{ symbol: "EURUSD", expectancyR: 0.42, score: 71, grade: "A", armed: true }, { symbol: "GBPUSD", expectancyR: -0.1, score: 48, grade: "C", armed: false }] }, intervalMs: 600_000, maxCandidates: 8, noteIntervalMs: 0, nextDueAt: NOW + 420_000 },
  journal: [
    { id: "j1", ts: NOW - 120_000, kind: "signal", symbol: "EURUSD", message: "Armed buy limit 1.0831 — edge 0.42R clears the floor." },
    { id: "j2", ts: NOW - 900_000, kind: "no_trade", symbol: "GBPUSD", message: "Refused: reward:risk below the required 1:2.00." },
  ],
  serverTime: NOW,
  v4: { enabled: true, shadow: true, layers: { governance: true, regimeHmm: true, gatekeeper: true, metaModel: false, execution: true, portfolio: true, ui: true } },
};

const DECISION = {
  symbol: "EURUSD", mode: "intraday", armed: true,
  plan: { id: "plan-0", symbol: "EURUSD", side: "buy", mode: "intraday", trigger: 1.0831, triggerType: "limit", invalidate: 1.0802, sl: 1.0801, tp: [1.0899], lots: 0.1, riskMoney: 50, riskPoints: 300, expiresAt: NOW + 600_000, createdAt: NOW - 30_000 },
  confluence: { direction: "up", score: 71, baseScore: 71, grade: "A", higherTimeframeAligned: true, contextPenalty: 0, views: [], factors: [], warnings: [] },
  monteCarlo: { winProbability: 0.62, lossProbability: 0.3, timeoutProbability: 0.08, expectancyR: 0.42, grossExpectancyR: 0.6, rewardRisk: 2.4, meanBarsToResolve: 12 },
  sizing: null,
  risk: { allow: true, riskPct: 0.25, scoreBump: 0, reasons: [], breaches: [] },
  news: { status: "clear", blocked: false, reason: null, relevantEvents: [], checkedAt: NOW - 30_000 },
  evidence: null,
  qualityScore: 71, qualityThreshold: 62, winProbability: 0.62, expectancyR: 0.42,
  entryTimeframe: "M15", horizonMinutes: 180, costR: 0.18, stopWidened: false,
  rejections: [], warnings: [], summary: "Trend-up regime, higher timeframe aligned, cost covered 5.6×.",
};

const REGIME_STATES = [
  { symbol: "EURUSD", frame: "M5", mode: "intraday", state: "trend_up", posterior: { trend_up: 0.71, range: 0.2, volatile: 0.09 }, expectedDwellBars: 12, changeProbability: 0.18, fit: { bars: 200, iterations: 10, logLikelihood: -100, reused: false, adequate: true }, sides: { buy: { required: "trend_up", probability: 0.71, permit: true, codes: [], reason: "trend up permits a long" }, sell: { required: "trend_down", probability: 0.71, permit: false, codes: ["REGIME_SIDE"], reason: "no down trend" } }, asOfMs: NOW, ageMs: 120, cached: false, available: true, reason: "M5 trend up, 71% posterior", bars: 200, lastBarAtMs: NOW - 60_000 },
  { symbol: "GBPUSD", frame: "M5", mode: "intraday", state: "range", posterior: { trend_up: 0.15, range: 0.7, volatile: 0.15 }, expectedDwellBars: 20, changeProbability: 0.1, fit: { bars: 200, iterations: 10, logLikelihood: -110, reused: false, adequate: true }, sides: { buy: { required: "trend_up", probability: 0.15, permit: false, codes: ["REGIME_SIDE"], reason: "range" }, sell: { required: "trend_down", probability: 0.15, permit: false, codes: ["REGIME_SIDE"], reason: "range" } }, asOfMs: NOW, ageMs: 120, cached: false, available: true, reason: "M5 range, 70% posterior", bars: 200, lastBarAtMs: NOW - 60_000 },
  { symbol: "XAUUSD", frame: "M5", mode: "intraday", state: "volatile", posterior: { trend_up: 0.2, range: 0.2, volatile: 0.6 }, expectedDwellBars: 6, changeProbability: 0.44, fit: { bars: 200, iterations: 10, logLikelihood: -140, reused: false, adequate: true }, sides: { buy: { required: "trend_up", probability: 0.2, permit: false, codes: ["REGIME_VOLATILE"], reason: "disorder" }, sell: { required: "trend_down", probability: 0.2, permit: false, codes: ["REGIME_VOLATILE"], reason: "disorder" } }, asOfMs: NOW, ageMs: 120, cached: false, available: true, reason: "M5 disorder, 60% posterior", bars: 200, lastBarAtMs: NOW - 60_000 },
];

const FIXTURES = {
  "/desk/state": STATE,
  "/desk/markets": {
    source: "mt5", catalogCount: 40,
    markets: [
      { symbol: "EURUSD", description: "Euro vs US dollar", path: "Forex/EURUSD", assetClass: "forex", tradeable: true, selected: true, dataStatus: "live", lastQuoteAt: NOW - 400 },
      { symbol: "GBPUSD", description: "Pound vs US dollar", path: "Forex/GBPUSD", assetClass: "forex", tradeable: true, selected: true, dataStatus: "live", lastQuoteAt: NOW - 900 },
      { symbol: "XAUUSD", description: "Gold vs US dollar", path: "Metals/XAUUSD", assetClass: "metals", tradeable: true, selected: true, dataStatus: "warming", lastQuoteAt: NOW - 5200 },
      { symbol: "US30", description: "Dow Jones 30", path: "Indices/US30", assetClass: "indices", tradeable: true, selected: false, dataStatus: "stale", lastQuoteAt: NOW - 90_000 },
      { symbol: "BTCUSD", description: "Bitcoin vs US dollar", path: "Crypto/BTCUSD", assetClass: "crypto", tradeable: false, selected: false, dataStatus: "stale", lastQuoteAt: null },
    ],
  },
  "/desk/instruments": { source: "mt5", instruments: INSTRUMENTS, feed: STATE.feed },
  "/desk/performance": {
    source: "mt5", currency: "USD", equityCurve: [],
    closedTrades: [
      { ticket: 90001, symbol: "EURUSD", side: "buy", volume: 0.1, openPrice: 1.0812, profit: 128.6, swap: -0.3, commission: -0.7, rMultiple: 1.43, openedAt: NOW - 86_400_000, closedAt: NOW - 82_800_000, agents: ["trend-m15"] },
      { ticket: 90002, symbol: "XAUUSD", side: "sell", volume: 0.05, openPrice: 2398.1, profit: -41.2, swap: -0.8, commission: -0.5, rMultiple: -1.0, openedAt: NOW - 172_800_000, closedAt: NOW - 169_200_000, agents: null },
      { ticket: 90003, symbol: "GBPUSD", side: "sell", volume: 0.05, openPrice: 1.2722, profit: 58.4, swap: 0, commission: -0.35, rMultiple: null, openedAt: NOW - 259_200_000, closedAt: NOW - 255_600_000, agents: ["meanrev-h1", "trend-m15"] },
    ],
    bySymbol: [
      { symbol: "EURUSD", trades: 1, net: 127.6, wins: 1, losses: 0, winRate: 1, stats: { trades: 1, wins: 1, losses: 0, winRate: 1, totalR: 1.43, avgR: 1.43, profitFactor: 99, sharpeLike: 0, maxLosingStreak: 0, maxDrawdownR: 0 } },
      { symbol: "XAUUSD", trades: 1, net: -42.5, wins: 0, losses: 1, winRate: 0, stats: { trades: 1, wins: 0, losses: 1, winRate: 0, totalR: -1, avgR: -1, profitFactor: 0, sharpeLike: 0, maxLosingStreak: 1, maxDrawdownR: 1 } },
    ],
    overall: { trades: 3, wins: 2, losses: 1, winRate: 0.667, totalR: 0.43, avgR: 0.215, profitFactor: 1.9, sharpeLike: 0.4, maxLosingStreak: 1, maxDrawdownR: 1 },
    outcomes: [], realisedPnl: 143.3, generatedAt: NOW,
  },
  "/desk/analysis": { source: "mt5", horizonMinutes: 180, thresholds: { minRrFill: 2, minCostCoverage: 4, minEdgeR: 0.15 }, decision: DECISION },
  "/desk/scan": {
    mode: "intraday", source: "mt5", scannedAt: NOW,
    coverage: { selected: 3, live: 2, warming: 1, stale: 0 },
    results: [
      { symbol: "EURUSD", status: "live", armed: true, direction: "up", score: 71, grade: "A", expectancyR: 0.42, winProbability: 0.62, lots: 0.1, riskMoney: 50, rrFill: 2.4, edgeFloorR: 0.31, edgeRequiredR: 0.15, rejections: [], summary: "Trend-up, aligned, cost covered." },
      { symbol: "GBPUSD", status: "live", armed: false, direction: "down", score: 48, grade: "C", expectancyR: -0.1, winProbability: 0.44, lots: null, riskMoney: null, rrFill: 1.8, edgeFloorR: null, edgeRequiredR: 0.15, rejections: ["Reward:risk at the expected fill is 1:1.80, below the required 1:2.00."], summary: "" },
      { symbol: "XAUUSD", status: "warming", armed: false, direction: "none", score: 0, grade: "D", expectancyR: null, winProbability: null, lots: null, riskMoney: null, rrFill: null, edgeFloorR: null, edgeRequiredR: null, rejections: ["Quote is not fresh yet."], summary: "" },
    ],
  },
  "/desk/governance": {
    sessionId: "spec-session",
    agents: [
      { agentId: "trend-m15", status: "active", eValue: 1.24, halveAt: 5, disableAt: 20, outcomes: 34, wins: 19, totalR: 4.2, phValue: 0.4, phAlarms: 0, reason: null, updatedAtMs: NOW - 60_000 },
      { agentId: "meanrev-h1", status: "halved", eValue: 6.1, halveAt: 5, disableAt: 20, outcomes: 21, wins: 8, totalR: -2.4, phValue: 2.8, phAlarms: 1, reason: "e-value passed the halve bar on the last four losses.", updatedAtMs: NOW - 3_600_000 },
      { agentId: "break-m5", status: "disabled", eValue: 21.4, halveAt: 5, disableAt: 20, outcomes: 40, wins: 12, totalR: -8.1, phValue: 4.1, phAlarms: 3, reason: "e-value passed the disable bar.", updatedAtMs: NOW - 86_400_000 },
    ],
  },
  "/desk/learning/weekly": {
    source: "desk", weekStart: "2026-10-12", weekEnd: "2026-10-19", generatedAtMs: NOW,
    trades: {
      closed: 61, measuredR: 58, unmeasured: 3, wins: 33, hitRate: 0.569, meanR: 0.11, totalR: 6.4,
      meanPredictedProbability: 0.58, calibrationGapPoints: 2.1, brier: 0.231, meanSlippageR: 0.043,
      worstR: -1.4, bestR: 2.8,
      calibrationBuckets: [
        { label: "50-60", lower: 50, upper: 60, n: 22, meanPredicted: 0.55, realisedHitRate: 0.545, gapPoints: -0.5 },
        { label: "60-70", lower: 60, upper: 70, n: 19, meanPredicted: 0.65, realisedHitRate: 0.579, gapPoints: -7.1 },
        { label: "70-80", lower: 70, upper: 80, n: 4, meanPredicted: 0.74, realisedHitRate: 0.75, gapPoints: 1.0 },
      ],
      meanRLower80: 0.18,
    },
    decisions: { evaluated: 210, armed: 61, refused: 149, armRate: 0.29, refusalCodes: [{ code: "GK_EV_LCB", count: 82 }, { code: "GK_RR_FILL", count: 41 }, { code: "GK_REGIME", count: 18 }, { code: "GK_FAMILY", count: 8 }] },
    perSymbol: [
      { symbol: "EURUSD", trades: 31, totalR: 5.2, meanR: 0.17 },
      { symbol: "GBPUSD", trades: 18, totalR: 1.8, meanR: 0.1 },
      { symbol: "XAUUSD", trades: 12, totalR: -0.6, meanR: -0.05 },
    ],
    agents: [],
    flags: ["Two fills carry no stamped risk — their R is excluded, not zeroed."],
    window: { weekStartMs: NOW - 86_400_000, weekEndMs: NOW + 518_400_000 },
  },
  "/desk/learning/journal": {
    sessionId: "spec-session",
    entries: [
      { id: "lj1", ts: NOW - 60_000, kind: "risk", symbol: "GBPUSD", message: "Symbol suspended after the second consecutive loss.", detail: null },
      { id: "lj2", ts: NOW - 300_000, kind: "execution", symbol: "EURUSD", message: "Fill 91011 slipped 0.03R inside tolerance.", detail: null },
      { id: "lj3", ts: NOW - 900_000, kind: "no_trade", symbol: null, message: "Refused: EV at p_LCB 0.12R below the 0.20R floor.", detail: null },
    ],
  },
  "/desk/regime": { mode: "intraday", frame: "M5", ttlMs: 2000, asOfMs: NOW, states: REGIME_STATES },
  "/desk/execution": {
    execution: {
      spreadSamples: { EURUSD: { samples: 128, last: 1.2 }, GBPUSD: { samples: 96, last: 1.8 } },
      timingBuckets: 8,
      timingPooled: { wins: 12, losses: 9, rSum: 2.4 },
      slippage: { ewmaR: 0.043, samples: 21, observations: 21 },
    },
    portfolio: [["EURUSD", 128], ["GBPUSD", 96]],
  },
  "/bridge/status": {
    paired: true, eaVersion: "3.08", expectedEaVersion: "3.08", eaUpdateAvailable: false,
    lastBeatRttMs: 42, avgBeatRttMs: 55, lastPairingError: null,
  },
};

const UNLINKED_STATE = { ...STATE, source: "unlinked", terminal: null, account: null, positions: [], plans: [], journal: [] };

const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

function mockRoutes(page, { linked }) {
  return Promise.all([
    // The stream fulfills empty once → the desk honestly shows POLL.
    page.route("**/api/desk/stream", (route) =>
      route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
    ),
    page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^.*\/api/, "");
      const method = route.request().method();
      if (method !== "GET") {
        route.fulfill(json(path === "/desk/arm" ? { plan: DECISION.plan } : { ok: true }));
        return;
      }
      if (path === "/desk/state") {
        route.fulfill(json(linked ? STATE : UNLINKED_STATE));
        return;
      }
      for (const [key, fixture] of Object.entries(FIXTURES)) {
        if (path === key || path.startsWith(`${key}?`)) {
          route.fulfill(json(fixture));
          return;
        }
      }
      // Anything the desk page did not expect gets an empty 200, so foreign
      // shell polling (AI engine status etc.) cannot fail the spec.
      route.fulfill(json({}));
    }),
  ]);
}

// ── the measurements ────────────────────────────────────────────────────────

function collectMeasurements() {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const band = (selector) => {
    const el = document.querySelector(selector);
    return el ? Math.round(rect(el).h) : null;
  };
  const panels = [...document.querySelectorAll("[data-panel]")].map((el) => ({ id: el.getAttribute("data-panel"), ...rect(el) }));
  const tables = [...document.querySelectorAll("[data-table]")].map((table) => {
    const rows = [...table.querySelectorAll(".desk-tr")];
    const templates = new Set(rows.map((row) => getComputedStyle(row).gridTemplateColumns));
    const heights = [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))];
    return { id: table.getAttribute("data-table"), uniformTemplate: templates.size <= 1, heights };
  });
  const testids = ["data-source", "stream-status", "mode-scalp", "mode-intraday", "mode-swing", "timezone-select", "auto-trade-toggle", "open-bridge", "kill-switch"]
    .map((id) => [id, Boolean(document.querySelector(`[data-testid="${id}"]`))]);
  const root = document.querySelector(".desk-root");
  return {
    panels,
    tables,
    panelHeaderHeights: [...new Set([...document.querySelectorAll(".desk-panel-header")].map((el) => Math.round(rect(el).h)))],
    bands: { title: band(".desk-titlebar"), tabs: band(".desk-tabbar"), status: band(".desk-statusbar") },
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth + 1 ||
      (root ? root.scrollWidth > root.clientWidth + 1 : false),
    canvasCount: document.querySelectorAll(".desk-root canvas").length,
    chartishSvg: document.querySelectorAll(".desk-root .recharts-surface, .desk-root [data-chart]").length,
    testids,
    tablist: {
      tablist: document.querySelectorAll('[role="tablist"]').length,
      tabs: document.querySelectorAll('[role="tab"]').length,
      selected: document.querySelectorAll('[role="tab"][aria-selected="true"]').length,
      tabpanel: document.querySelectorAll('[role="tabpanel"]').length,
    },
  };
}

function boxesIntersect(a, b) {
  // A shared 1px border must not read as an overlap.
  return a.x < b.x + b.w - 1.5 && b.x < a.x + a.w - 1.5 && a.y < b.y + b.h - 1.5 && b.y < a.y + a.h - 1.5;
}

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const browser = await chromium.launch();
console.log(`Desk layout spec → ${BASE_URL} (screens: ${OUT_DIR})`);

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: vp });
  await context.addInitScript(() => {
    try { localStorage.setItem("neurotrade_landing_dismissed", "1"); } catch { /* private mode */ }
  });
  const page = await context.newPage();
  await mockRoutes(page, { linked: true });

  console.log(`\n[${vp.width}x${vp.height}]`);
  for (const tab of TABS) {
    await page.goto(`${BASE_URL}/terminal?tab=${tab}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`[data-workspace="${tab}"]`, { timeout: 15_000 });
    // Let the queries resolve and the panels fill before measuring.
    await page.waitForTimeout(900);

    const m = await page.evaluate(collectMeasurements);
    const shot = `${OUT_DIR}${vp.width}x${vp.height}-${tab}.png`;
    await page.screenshot({ path: shot });

    check(`${tab}: panels rendered`, m.panels.length > 0, `found ${m.panels.length}`);
    check(`${tab}: no horizontal overflow`, !m.horizontalOverflow);
    const overlaps = [];
    for (let i = 0; i < m.panels.length; i += 1) {
      for (let j = i + 1; j < m.panels.length; j += 1) {
        if (boxesIntersect(m.panels[i], m.panels[j])) overlaps.push(`${m.panels[i].id}×${m.panels[j].id}`);
      }
    }
    check(`${tab}: no panel intersects another`, overlaps.length === 0, overlaps.join(", "));
    if (vp.width >= 1024) {
      check(`${tab}: bands exact (48/40/28)`, m.bands.title === 48 && m.bands.tabs === 40 && m.bands.status === 28, JSON.stringify(m.bands));
      check(`${tab}: panel headers 36px`, m.panelHeaderHeights.every((h) => h === 36), JSON.stringify(m.panelHeaderHeights));
      for (const table of m.tables) {
        check(`${tab}: table ${table.id} one column template`, table.uniformTemplate);
        check(
          `${tab}: table ${table.id} heights documented`,
          table.heights.every((h) => ALLOWED_ROW_HEIGHTS.has(h)),
          JSON.stringify(table.heights),
        );
      }
    }
    check(`${tab}: no canvas anywhere on the desk`, m.canvasCount === 0, `${m.canvasCount} canvas`);
    check(`${tab}: no chart svg`, m.chartishSvg === 0, `${m.chartishSvg} chartish nodes`);
    const missing = m.testids.filter(([, present]) => !present).map(([id]) => id);
    check(`${tab}: all historical testids present`, missing.length === 0, missing.join(", "));
  }

  // Tablist semantics + arrow keys, once per viewport.
  await page.goto(`${BASE_URL}/terminal?tab=command`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-workspace="command"]', { timeout: 15_000 });
  const tl = await page.evaluate(collectMeasurements);
  check("tablist: one tablist, four tabs, one selected, one panel", tl.tablist.tablist === 1 && tl.tablist.tabs === 4 && tl.tablist.selected === 1 && tl.tablist.tabpanel === 1, JSON.stringify(tl.tablist));
  await page.focus('[role="tab"][aria-selected="true"]');
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
  const afterArrow = await page.evaluate(() => ({
    selected: document.querySelector('[role="tab"][aria-selected="true"]')?.id ?? "",
    search: window.location.search,
    panel: document.querySelector('[role="tabpanel"]')?.getAttribute("data-workspace") ?? "",
  }));
  check("tablist: ArrowRight moves selection, URL and panel", afterArrow.selected === "desk-tab-markets" && afterArrow.search.includes("tab=markets") && afterArrow.panel === "markets", JSON.stringify(afterArrow));

  await context.close();
}

// ── unlinked: the connect card, disabled controls, no numbers ───────────────
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    try { localStorage.setItem("neurotrade_landing_dismissed", "1"); } catch { /* private mode */ }
  });
  const page = await context.newPage();
  await mockRoutes(page, { linked: false });
  await page.goto(`${BASE_URL}/terminal`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="connect-card"]', { timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT_DIR}1440x900-unlinked.png` });
  const unlinked = await page.evaluate(() => ({
    source: document.querySelector('[data-testid="data-source"]')?.textContent ?? "",
    killDisabled: document.querySelector('[data-testid="kill-switch"]')?.disabled ?? null,
    grid: document.querySelectorAll(".desk-grid [data-panel]").length,
    statusBar: document.querySelectorAll('[data-testid="status-bar"]').length,
    tabs: document.querySelectorAll('[role="tab"]').length,
  }));
  check("unlinked: source chip says MT5 REQUIRED", unlinked.source.includes("MT5 REQUIRED"), unlinked.source);
  check("unlinked: kill switch present but disabled", unlinked.killDisabled === true);
  check("unlinked: no workspace grid, no tabs, no status bar", unlinked.grid === 0 && unlinked.tabs === 0 && unlinked.statusBar === 0, JSON.stringify(unlinked));
  await context.close();
}

// ── the old /learning URL lands on the Learning workspace ──────────────────
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    try { localStorage.setItem("neurotrade_landing_dismissed", "1"); } catch { /* private mode */ }
  });
  const page = await context.newPage();
  await mockRoutes(page, { linked: true });
  await page.goto(`${BASE_URL}/learning`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-workspace="learning"]', { timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT_DIR}1440x900-learning-redirect.png` });
  const landed = await page.evaluate(() => ({
    path: window.location.pathname,
    search: window.location.search,
    governance: Boolean(document.querySelector('[data-panel="governance"]')),
  }));
  check("/learning redirects to /terminal?tab=learning", landed.path === "/terminal" && landed.search.includes("tab=learning"), JSON.stringify(landed));
  check("/learning redirect renders the Learning workspace", landed.governance);
  await context.close();
}

await browser.close();

if (failures > 0) {
  console.error(`\n${failures} DESK LAYOUT CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL DESK LAYOUT CHECKS PASSED");
