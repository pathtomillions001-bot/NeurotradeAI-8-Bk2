/**
 * v5 Desk — the screen's arithmetic.
 *
 * These functions decide what a row, a badge or a pipeline node CLAIMS: a gate
 * row printed as passing when the server refused it is not a styling bug, it is
 * a false statement about money. So the mapping is tested, in the style of
 * learning.test.ts — pure inputs, asserted outputs, and every "unknown" must
 * come back as null (an em dash), never as a zero.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentAttribution,
  autoSelectSummary,
  buildAlerts,
  buildGateRows,
  buildOpportunityRows,
  buildPipeline,
  buildRiskRows,
  closedTradesCsv,
  committedRisk,
  dayChangePct,
  deskSearchForTab,
  deskTabFromSearch,
  filterOpportunities,
  formatPct,
  formatPrice,
  formatSignedPct,
  formatSignedR,
  gatePassCount,
  governedAgentAlertCount,
  netOpenResults,
  nextAutoSelectLabel,
  openRiskPct,
  opportunityStateId,
  regimePermitLabel,
  regimeSplit,
  regimeStateLabel,
  regimeTopProbability,
  riskBadge,
  rolloutDemoNote,
  rolloutStage,
  shortCountdown,
  triggerTypeLabel,
  type GateRow,
} from "./desk-ui";
import type { AgentDecision, DeskStateResponse, Instrument, Position, RegimeRead, ScanRow } from "./desk";

// ── fixtures ────────────────────────────────────────────────────────────────

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    symbol: "EURUSD",
    mode: "intraday",
    armed: true,
    plan: { id: "p1", symbol: "EURUSD", side: "buy", mode: "intraday", trigger: 1.1, triggerType: "limit", invalidate: 1.09, sl: 1.095, tp: [1.12], lots: 0.1, riskMoney: 50, riskPoints: 50, expiresAt: 0, createdAt: 0 },
    confluence: { direction: "up", score: 71, baseScore: 71, grade: "A", higherTimeframeAligned: true, contextPenalty: 0, views: [], factors: [], warnings: [] },
    monteCarlo: { winProbability: 0.62, lossProbability: 0.3, timeoutProbability: 0.08, expectancyR: 0.42, grossExpectancyR: 0.5, rewardRisk: 2.4, meanBarsToResolve: 12 },
    sizing: null,
    risk: { allow: true, riskPct: 0.35, scoreBump: 0, reasons: [], breaches: [] },
    news: { status: "clear", blocked: false, reason: null, relevantEvents: [], checkedAt: 0 },
    evidence: null,
    qualityScore: 71,
    qualityThreshold: 62,
    winProbability: 0.62,
    expectancyR: 0.42,
    entryTimeframe: "M15",
    horizonMinutes: 180,
    costR: 0.18,
    stopWidened: false,
    rejections: [],
    warnings: [],
    summary: "",
    ...overrides,
  } as AgentDecision;
}

function regimeRead(overrides: Partial<RegimeRead> = {}): RegimeRead {
  return {
    symbol: "EURUSD",
    frame: "M5",
    mode: "intraday",
    state: "trend_up",
    posterior: { trend_up: 0.71, range: 0.2, volatile: 0.09 },
    expectedDwellBars: 12,
    changeProbability: 0.18,
    fit: { bars: 200, iterations: 10, logLikelihood: -100, reused: false, adequate: true },
    sides: {
      buy: { required: "trend_up", probability: 0.71, permit: true, codes: [], reason: "trend up permits a long" },
      sell: { required: "trend_down", probability: 0.71, permit: false, codes: ["REGIME_SIDE"], reason: "no down trend" },
    },
    asOfMs: 0,
    ageMs: 100,
    cached: false,
    available: true,
    reason: "",
    bars: 200,
    lastBarAtMs: 0,
    ...overrides,
  } as RegimeRead;
}

function instrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    symbol: "EURUSD",
    description: "Euro vs US dollar",
    assetClass: "forex",
    digits: 5,
    bid: 1.0842,
    ask: 1.0843,
    spreadPoints: 1,
    changePct: 0.24,
    watched: true,
    dataStatus: "live",
    lastQuoteAt: 0,
    quoteAgeMs: 400,
    priceWarning: null,
    deviationPct: null,
    sessionHigh: null,
    sessionLow: null,
    sparkline: [],
    contractSize: 100000,
    point: 0.00001,
    ...overrides,
  } as Instrument;
}

function scanRow(overrides: Partial<ScanRow> = {}): ScanRow {
  return {
    symbol: "EURUSD",
    status: "live",
    armed: false,
    direction: "up",
    score: 60,
    grade: "B",
    expectancyR: 0.24,
    winProbability: 0.58,
    lots: 0.1,
    riskMoney: 40,
    rejections: ["Reward:risk at the expected fill is 1:1.80, below the required 1:2.00."],
    summary: "",
    ...overrides,
  } as ScanRow;
}

function deskState(overrides: Partial<DeskStateResponse> = {}): DeskStateResponse {
  return {
    source: "mt5",
    terminal: null,
    account: { balance: 10000, equity: 10100, margin: 0, freeMargin: 10100, marginLevel: 0, currency: "USD", leverage: 100, mode: "netting", isLive: false, dayStartEquity: 10000, peakEquity: 10400 },
    mode: "intraday",
    autoTrade: false,
    watchlist: ["EURUSD"],
    timezone: "Africa/Nairobi",
    timezones: [],
    market: { catalogCount: 40, selectedCount: 8, liveSymbols: 6, warmingSymbols: 1, staleSymbols: 1, mismatchSymbols: 0, quoteFreshForMs: 8000 },
    feed: { clockSkewMs: null, clockWarning: null, lastQuoteAgeMs: 400, quoteFreshForMs: 8000 },
    positions: [],
    plans: [],
    policy: { baseRiskPct: 0.25, maxRiskPct: 0.35, maxDailyLossPct: 2.5, maxDrawdownPct: 6, maxOpenPositions: 6, maxPositionsPerSymbol: 2, maxCurrencyExposurePct: 1.2, haltAfterConsecutiveLosses: 4, minMarginLevelPct: 200, symbolCooldownMs: 0, liveTradingEnabled: false },
    risk: {
      state: { consecutiveLosses: 1, suspendedSymbols: [], realisedPnlToday: 128.6, tradesToday: 3, haltedUntilNextSession: false, haltReason: null },
      budget: { usedPct: 30, remainingMoney: 175, limitMoney: 250 },
      exposure: [{ key: "EUR", riskMoney: 90, riskPct: 0.9 }],
    },
    news: { available: true, checkedAt: 0, events: [] },
    newsUpcoming: [],
    autoSelect: { last: null, intervalMs: 600000, maxCandidates: 8, noteIntervalMs: 0, nextDueAt: null },
    journal: [],
    serverTime: 0,
    ...overrides,
  } as DeskStateResponse;
}

// ── tab / URL state ─────────────────────────────────────────────────────────

test("D1 — the tab lives in the URL, and an unknown tab is Command", () => {
  assert.equal(deskTabFromSearch("?tab=learning"), "learning");
  assert.equal(deskTabFromSearch("tab=markets"), "markets");
  assert.equal(deskTabFromSearch("?tab=journal&x=1"), "journal");
  assert.equal(deskTabFromSearch(""), "command", "no query ⇒ the default workspace");
  assert.equal(deskTabFromSearch("?tab=nonsense"), "command", "an unknown tab must not white-screen");
  assert.equal(deskTabFromSearch("?tab=LEARNING"), "command", "the parameter is case-sensitive like the route");
  assert.equal(deskSearchForTab("learning"), "?tab=learning");
  assert.equal(deskSearchForTab("command"), "?tab=command");
});

// ── title-bar maths ─────────────────────────────────────────────────────────

test("D2 — day% and open-risk maths, with nulls instead of fake zeros", () => {
  assert.equal(dayChangePct(10100, 10000), 1);
  assert.ok(Math.abs((dayChangePct(9900, 10000) ?? 0) + 1) < 1e-9);
  assert.equal(dayChangePct(10100, null), null, "no day-start stamp ⇒ em dash, not 0%");
  assert.equal(dayChangePct(null, 10000), null);
  assert.equal(dayChangePct(10100, 0), null, "a zero baseline has no percentage");

  assert.equal(openRiskPct([{ riskPct: 0.9 }, { riskPct: 0.35 }]), 1.25);
  assert.equal(openRiskPct([]), 0);
  assert.equal(openRiskPct(null), 0);

  // Net open: money over every position, R only over the stamped ones.
  const positions = [
    { profit: 128.6, swap: 0, commission: 0, initialRiskMoney: 90 },
    { profit: -40, swap: -1, commission: -0.5, initialRiskMoney: undefined },
  ] as unknown as Position[];
  const net = netOpenResults(positions);
  assert.ok(Math.abs(net.money - 87.1) < 1e-9);
  assert.ok(Math.abs((net.r ?? 0) - 128.6 / 90) < 1e-9, "R covers only the measured position");
  assert.equal(net.unmeasured, 1);
  assert.equal(netOpenResults([]).r, null, "no positions ⇒ no R, and no 0.0R claim");

  // Committed risk reads the exposure and the plans against the equity.
  const state = deskState({ plans: [{ riskMoney: 30 } as never] });
  const committed = committedRisk(state);
  assert.ok(Math.abs(committed.committedPct - 0.9) < 1e-9);
  assert.ok(Math.abs((committed.plansAddPct ?? 0) - (30 / 10100) * 100) < 1e-9);
  assert.equal(committedRisk(null).plansAddPct, null);
});

test("D3 — formatting keeps signs, digits and em dashes", () => {
  assert.equal(formatPct(0.4256), "0.43%");
  assert.equal(formatPct(null), "—");
  assert.equal(formatSignedPct(0.4), "+0.40%");
  assert.equal(formatSignedPct(-0.4), "−0.40%");
  assert.equal(formatSignedR(1.43), "+1.4R");
  assert.equal(formatSignedR(null), "—");
  assert.equal(formatPrice(1.0842, 5), "1.08420");
  assert.equal(formatPrice(null, 5), "—");
  assert.equal(formatPrice(1.0842, null), "—", "no digits ⇒ no invented precision");
  assert.equal(triggerTypeLabel("limit"), "Limit order");
  assert.equal(triggerTypeLabel("break"), "Break stop");
  assert.equal(triggerTypeLabel(undefined), null);
  assert.equal(regimeStateLabel("trend_up"), "Trend up");
  assert.equal(regimeStateLabel(null), null);
});

test("D4 — the plan countdown counts in the units that matter", () => {
  const now = 1_000_000;
  assert.equal(shortCountdown(now + 42_000, now), "42s");
  assert.equal(shortCountdown(now + 252_000, now), "4m 12s");
  assert.equal(shortCountdown(now + 7_500_000, now), "2h 05m");
  assert.equal(shortCountdown(now - 1, now), "expired");
  assert.equal(shortCountdown(now, now), "expired");
});

// ── gate rows ───────────────────────────────────────────────────────────────

const THRESHOLDS = { minRrFill: 2, minCostCoverage: 4, minEdgeR: 0.15 };

test("D5 — the legacy gate rows use the server's own constants, and fail first when refused", () => {
  const refused = decision({
    armed: false,
    plan: null,
    monteCarlo: { winProbability: 0.55, lossProbability: 0.4, timeoutProbability: 0.05, expectancyR: 0.1, grossExpectancyR: 0.2, rewardRisk: 1.8, meanBarsToResolve: 9 },
    costR: 0.3,
    expectancyR: 0.1,
    rejections: [
      "Reward:risk at the expected fill is 1:1.80, below the required 1:2.00.",
      "Net expectancy 0.10R, below the 0.15R minimum.",
    ],
  });
  const rows = buildGateRows({
    decision: refused,
    thresholds: THRESHOLDS,
    regime: regimeRead(),
    openRiskPctValue: 0.9,
    exposureCapPct: 1.2,
    dailyLossUsedPct: 30,
    halted: false,
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  // R:R fails against the SERVER's 2.0 floor, and carries the plain sentence.
  const rr = byId.get("rr-fill");
  assert.ok(rr && rr.pass === false);
  assert.equal(rr?.value, "1.80R");
  assert.equal(rr?.threshold, "≥ 2.00R");
  assert.match(rr?.detail ?? "", /below the required 1:2\.00/);
  // Edge fails against the server's 0.15R floor.
  const edge = byId.get("edge-floor");
  assert.ok(edge && edge.pass === false);
  assert.equal(edge?.threshold, "≥ 0.15R");
  // Cost 30% of R fails the 1/4 = 25% coverage invariant.
  const cost = byId.get("cost-vol");
  assert.ok(cost && cost.pass === false);
  assert.equal(cost?.threshold, "≤ 25% of R");
  // Regime permits the long (decision direction up, buy permit true).
  assert.equal(byId.get("regime")?.pass, true);
  // News is clear ⇒ passes, always rendered.
  assert.equal(byId.get("news")?.pass, true);
  // Heat 0.9 < cap 1.2 ⇒ passes; daily loss 30% < 100 ⇒ passes.
  assert.equal(byId.get("heat")?.pass, true);
  assert.equal(byId.get("daily-loss")?.pass, true);
  // No gatekeeper ⇒ no multiple-testing row (only the gatekeeper measures it).
  assert.equal(byId.has("family"), false);
  // REFUSED ⇒ every failing row comes first, order stable inside each group.
  const firstPass = rows.findIndex((row) => row.pass);
  const lastFail = rows.map((row) => row.pass).lastIndexOf(false);
  assert.ok(lastFail < firstPass || firstPass === -1, "failing rows must precede passing rows");
  assert.deepEqual(rows.slice(0, 3).map((row) => row.id), ["rr-fill", "edge-floor", "cost-vol"]);

  // An armed decision keeps the canonical order and all-green semantics.
  const armed = buildGateRows({ decision: decision(), thresholds: THRESHOLDS, openRiskPctValue: 0.9, exposureCapPct: 1.2, dailyLossUsedPct: 30 });
  assert.ok(armed.every((row) => row.pass), `armed fixture must pass every row: ${JSON.stringify(armed.filter((r) => !r.pass))}`);
  assert.deepEqual(armed.slice(0, 3).map((row) => row.id), ["rr-fill", "edge-floor", "cost-vol"]);
});

test("D6 — the gatekeeper's rows carry the server's own thresholds and sentences", () => {
  const gkDecision = decision({
    armed: false,
    plan: null,
    gatekeeper: {
      armed: false,
      code: "GK_EV_LCB",
      codes: ["GK_EV_LCB"],
      reason: "[GK_EV_LCB] EV at p_LCB 0.12R below the 0.20R floor.",
      reasons: [
        { code: "GK_RR_FILL", label: "R:R at fill", pass: true, value: 2.4, threshold: 2, detail: "R:R 2.40 at the expected fill." },
        { code: "GK_COST_SIGMA", label: "Cost/σh", pass: true, value: 0.1, threshold: 0.15, detail: "Cost 0.10 of horizon σ." },
        { code: "GK_EV_LCB", label: "EV_LCB", pass: false, value: 0.12, threshold: 0.2, detail: "EV at p_LCB 0.12R below the 0.20R floor." },
        { code: "GK_REGIME", label: "Regime", pass: true, value: 0.71, threshold: 0.5, detail: "Regime permit 0.71." },
        { code: "GK_FAMILY", label: "Family", pass: true, value: 0.02, threshold: 0.1, detail: "BH q 0.10 cleared." },
      ],
      evLcbR: 0.12,
      requiredEvLcbR: 0.2,
      rrFill: 2.4,
      costR: 0.1,
      horizonSigma: 0.002,
      costOverSigma: 0.1,
      edgePValue: 0.02,
      bhThreshold: 0.1,
      mcP05MeanR: null,
      mcTargetShare: null,
      horizonBars: 12,
    },
  });
  const rows = buildGateRows({ decision: gkDecision, thresholds: THRESHOLDS });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("rr-fill")?.threshold, "≥ 2.00R");
  assert.equal(byId.get("edge-floor")?.pass, false);
  assert.equal(byId.get("edge-floor")?.detail, "EV at p_LCB 0.12R below the 0.20R floor.");
  assert.equal(byId.get("cost-vol")?.pass, true);
  assert.equal(byId.get("family")?.pass, true, "the gatekeeper supplies the multiple-testing row");
  // Refused ⇒ the EV row leads.
  assert.equal(rows[0].id, "edge-floor");
  assert.deepEqual(gatePassCount(rows), { pass: rows.length - 1, total: rows.length });
});

test("D7 — a row without data is omitted, and an em dash is never a zero", () => {
  // No decision at all ⇒ no rows (the panel shows its own empty state).
  assert.deepEqual(buildGateRows({ decision: null }), []);
  // No thresholds (older server) and no gatekeeper ⇒ the edge row is omitted
  // rather than printed against a made-up floor.
  const bare = decision({ monteCarlo: null, costR: null, expectancyR: null });
  const rows = buildGateRows({ decision: bare });
  const ids = rows.map((row) => row.id);
  assert.equal(ids.includes("edge-floor"), false);
  assert.equal(ids.includes("heat"), false, "no exposure data ⇒ no heat row");
  assert.equal(ids.includes("daily-loss"), false);
  // News always exists on a decision.
  assert.equal(ids.includes("news"), true);
  // A halted desk fails the daily-loss row even at 0% used.
  const halted = buildGateRows({ decision: decision(), dailyLossUsedPct: 0, halted: true });
  assert.equal(halted.find((row) => row.id === "daily-loss")?.pass, false);
});

// ── pipeline ────────────────────────────────────────────────────────────────

test("D8 — the pipeline's current node is the first failure, else the edge gate", () => {
  const healthy = buildPipeline({
    liveSymbols: 8, selectedCount: 8, mismatchSymbols: 0,
    regime: regimeRead(), decision: decision(), gateRows: [pass("a"), pass("b")], openPositions: 2,
  });
  assert.equal(healthy.length, 7);
  assert.deepEqual(healthy.map((node) => node.id), ["L0", "L1", "L2", "L3", "L4", "L5", "L6"]);
  assert.equal(healthy.find((node) => node.current)?.id, "L4", "a healthy pipeline sits at the edge gate");
  assert.equal(healthy[0].value, "8 of 8 fresh");
  assert.equal(healthy[1].value, "Trend up 71%");
  assert.equal(healthy[3].value, "62%");
  assert.equal(healthy[4].value, "2 of 2 pass");
  assert.equal(healthy[5].value, "Limit order");
  assert.equal(healthy[6].value, "2 open");
  assert.ok(healthy.every((node) => node.state !== "block"));

  // A mismatched feed blocks at L0 and the current node moves there.
  const blockedFeed = buildPipeline({
    liveSymbols: 6, selectedCount: 8, mismatchSymbols: 1,
    regime: null, decision: null, gateRows: [], openPositions: 0,
  });
  assert.equal(blockedFeed[0].state, "block");
  assert.equal(blockedFeed.find((node) => node.current)?.id, "L0");

  // A refused decision blocks at L4 (all other layers healthy).
  const refused = buildPipeline({
    liveSymbols: 8, selectedCount: 8, mismatchSymbols: 0,
    regime: regimeRead(),
    decision: decision({ armed: false, plan: null }),
    gateRows: [fail("rr"), pass("news")],
    openPositions: 0,
  });
  assert.equal(refused[4].state, "block");
  assert.equal(refused[4].value, "1 of 2 pass");
  assert.equal(refused.find((node) => node.current)?.id, "L4");
  assert.equal(refused[5].value, "—", "no plan ⇒ no order style, and L5 warns");
  assert.equal(refused[5].state, "warn");

  // A regime that forbids the decision's side blocks at L1.
  const regimeBlocks = buildPipeline({
    liveSymbols: 8, selectedCount: 8, mismatchSymbols: 0,
    regime: regimeRead({ sides: { buy: { required: "trend_up", probability: 0.2, permit: false, codes: ["REGIME_SIDE"], reason: "no" }, sell: { required: "trend_down", probability: 0.1, permit: false, codes: [], reason: "" } } } as never),
    decision: decision(),
    gateRows: [pass("a")],
    openPositions: 0,
  });
  assert.equal(regimeBlocks[1].state, "block");
  assert.equal(regimeBlocks.find((node) => node.current)?.id, "L1");

  // Lower bound shows when the server supplies it.
  const withBound = buildPipeline({
    liveSymbols: 1, selectedCount: 1, mismatchSymbols: 0,
    regime: null, decision: decision({ sizingProbabilityLowerBound: 0.54 }), gateRows: [], openPositions: 0,
  });
  assert.equal(withBound[3].value, "62% (LB 54%)");
  // No decision at all ⇒ the statistical layers warn with em dashes.
  const empty = buildPipeline({ liveSymbols: 0, selectedCount: 0, mismatchSymbols: 0, regime: null, decision: null, gateRows: [], openPositions: 0 });
  assert.equal(empty[1].value, "—");
  assert.equal(empty[2].value, "—");
  assert.equal(empty[3].value, "—");
  assert.equal(empty[0].value, "no markets");
});

function pass(id: string): GateRow {
  return { id, label: id, pass: true, value: null, threshold: null, valueNum: null, thresholdNum: null, detail: null };
}
function fail(id: string): GateRow {
  return { id, label: id, pass: false, value: null, threshold: null, valueNum: null, thresholdNum: null, detail: null };
}

// ── opportunities ───────────────────────────────────────────────────────────

test("D9 — opportunities merge feed, scan and regime; sort by edge; badge honestly", () => {
  const rows = buildOpportunityRows({
    instruments: [
      instrument({ symbol: "EURUSD" }),
      instrument({ symbol: "XAUUSD", assetClass: "metals", bid: 2400.5, digits: 2, dataStatus: "warming" }),
      instrument({ symbol: "US30", assetClass: "indices", dataStatus: "mismatch" }),
      instrument({ symbol: "GBPUSD", bid: 1.27, digits: 5 }),
    ],
    scans: [
      scanRow({ symbol: "EURUSD", expectancyR: 0.24, armed: true, rejections: [] }),
      scanRow({ symbol: "GBPUSD", expectancyR: 0.41, armed: false }),
      scanRow({ symbol: "US30", expectancyR: 0.9, status: "mismatch" }),
    ],
    regimes: [regimeRead({ symbol: "EURUSD" })],
    selected: "EURUSD",
  });
  // Sorted by edge descending; XAUUSD (never scanned) sorts last.
  assert.deepEqual(rows.map((row) => row.symbol), ["US30", "GBPUSD", "EURUSD", "XAUUSD"]);
  const eur = rows.find((row) => row.symbol === "EURUSD");
  assert.equal(eur?.stateId, "armed");
  assert.equal(eur?.stateLabel, "Armed");
  assert.equal(eur?.regimeLabel, "Trend up 71%");
  assert.equal(eur?.priceLabel, "1.08420");
  assert.equal(eur?.selected, true);
  assert.equal(rows.find((row) => row.symbol === "US30")?.stateId, "blocked", "a mismatched feed outranks an armed scan");
  assert.equal(rows.find((row) => row.symbol === "XAUUSD")?.stateId, "warming");
  assert.equal(rows.find((row) => row.symbol === "XAUUSD")?.regimeLabel, null);
  assert.equal(rows.find((row) => row.symbol === "GBPUSD")?.stateId, "gate");

  // The badge precedence, isolated.
  assert.equal(opportunityStateId(instrument({ dataStatus: "stale" }), scanRow({ armed: true })), "blocked");
  assert.equal(opportunityStateId(instrument(), scanRow({ armed: true })), "armed");
  assert.equal(opportunityStateId(instrument(), scanRow({ armed: false, rejections: ["no"]})), "gate");
  assert.equal(opportunityStateId(instrument(), scanRow({ armed: false, rejections: [] })), "no-edge");
  assert.equal(opportunityStateId(instrument(), null), "no-edge");

  // Filters.
  assert.deepEqual(filterOpportunities(rows, "armed").map((row) => row.symbol), ["EURUSD"]);
  assert.deepEqual(filterOpportunities(rows, "forex").map((row) => row.symbol), ["GBPUSD", "EURUSD"]);
  assert.deepEqual(filterOpportunities(rows, "other").map((row) => row.symbol), ["US30", "XAUUSD"]);
  assert.equal(filterOpportunities(rows, "all").length, 4);
});

// ── risk rows ───────────────────────────────────────────────────────────────

test("D10 — risk rows measure against the server's limits, and the badge reads them", () => {
  const rows = buildRiskRows({ state: deskState(), slippageEwmaR: 0.05 });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("day")?.value, "+128.60");
  assert.equal(byId.get("day")?.tone, "good");
  assert.equal(byId.get("daily-loss")?.value, "30%");
  assert.equal(byId.get("daily-loss")?.unit, "of 250.00 limit");
  assert.ok(Math.abs((byId.get("daily-loss")?.fraction ?? 0) - 0.3) < 1e-9);
  assert.equal(byId.get("daily-loss")?.tone, "good");
  // Drawdown: peak 10400, equity 10100 ⇒ 2.88% of the 6% kill level.
  assert.equal(byId.get("drawdown")?.value, "2.88%");
  assert.equal(byId.get("drawdown")?.unit, "of 6.0% kill level");
  assert.equal(byId.get("heat")?.value, "0.90%");
  assert.equal(byId.get("heat")?.unit, "of 1.20% cap");
  assert.equal(byId.get("streak")?.value, "1");
  assert.equal(byId.get("streak")?.unit, "vs 4 backstop");
  assert.equal(byId.get("slippage")?.value, "0.050R");
  assert.equal(riskBadge(rows, false).label, "Healthy");

  // Near a limit: used 85% of the daily budget ⇒ amber badge.
  const nearState = deskState();
  nearState.risk.budget = { usedPct: 85, remainingMoney: 37, limitMoney: 250 };
  const near = buildRiskRows({ state: nearState, slippageEwmaR: null });
  assert.equal(riskBadge(near, false).label, "Near a limit");
  // Slippage without the ledger is an em dash, not a healthy 0.000R.
  assert.equal(near.find((row) => row.id === "slippage")?.value, "—");
  assert.equal(near.find((row) => row.id === "slippage")?.fraction, null);
  // Halted outranks everything.
  assert.equal(riskBadge(near, true).label, "Halted");
  // No state at all ⇒ six neutral em-dash rows (the skeleton, not zeros).
  const empty = buildRiskRows({ state: null, slippageEwmaR: null });
  assert.equal(empty.length, 6);
  assert.ok(empty.every((row) => row.value === "—" && row.tone === "neutral"));
});

// ── alerts ──────────────────────────────────────────────────────────────────

test("D11 — the alert strip is one slot, most severe first", () => {
  const halted = deskState();
  halted.risk.state.haltedUntilNextSession = true;
  halted.risk.state.haltReason = "Daily loss limit reached — halted until the next session.";
  const alerts = buildAlerts({ state: halted, mismatchedSymbols: ["US30"], actionError: "Arm failed", nowMs: 0 });
  assert.deepEqual(alerts.map((alert) => alert.id), ["halt", "mismatch", "action-error"]);
  assert.equal(alerts[0].tone, "rose");
  assert.match(alerts[0].text, /Daily loss limit reached/);
  assert.match(alerts[1].text, /US30 is reporting a price that disagrees/);

  // Stale outranks degraded; degraded is the calm sky variant.
  const staleState = deskState({ terminal: { lastSyncAt: 0, lastSyncAgeMs: 130_000, stale: true, degraded: true, staleAfterMs: 120_000, syncIntervalMs: 1000 } as never });
  const staleAlerts = buildAlerts({ state: staleState, mismatchedSymbols: [], actionError: null, nowMs: 130_000 });
  assert.deepEqual(staleAlerts.map((alert) => alert.id), ["stale", "reconnecting"]);
  assert.match(staleAlerts[0].text, /has not synced for 130s \(limit 120s\)/);

  // A clean desk has no alerts at all.
  assert.deepEqual(buildAlerts({ state: deskState(), mismatchedSymbols: [], actionError: null, nowMs: 0 }), []);
  assert.deepEqual(buildAlerts({ state: null, mismatchedSymbols: [], actionError: "x", nowMs: 0 }), []);
});

// ── rollout, regime split, misc ─────────────────────────────────────────────

test("D12 — the rollout stage is derived, and the demo note reads the constant", () => {
  assert.equal(rolloutStage({ v4: null, accountIsLive: true, liveTradingEnabled: true, baseRiskPct: 0.35 }), 0);
  assert.equal(rolloutStage({ v4: { enabled: true, shadow: true, layers: {} } as never, accountIsLive: true, liveTradingEnabled: true, baseRiskPct: 0.35 }), 0);
  assert.equal(rolloutStage({ v4: { enabled: true, shadow: false, layers: {} } as never, accountIsLive: false, liveTradingEnabled: true, baseRiskPct: 0.1 }), 1);
  assert.equal(rolloutStage({ v4: { enabled: true, shadow: false, layers: {} } as never, accountIsLive: true, liveTradingEnabled: false, baseRiskPct: 0.1 }), 1);
  assert.equal(rolloutStage({ v4: { enabled: true, shadow: false, layers: {} } as never, accountIsLive: true, liveTradingEnabled: true, baseRiskPct: 0.1 }), 2);
  assert.equal(rolloutStage({ v4: { enabled: true, shadow: false, layers: {} } as never, accountIsLive: true, liveTradingEnabled: true, baseRiskPct: 0.25 }), 3);
  assert.equal(rolloutStage({ v4: { enabled: true, shadow: false, layers: {} } as never, accountIsLive: true, liveTradingEnabled: true, baseRiskPct: 0.35 }), 4);
  assert.equal(rolloutDemoNote(61), "61 of 200 trades needed to leave demo");
  assert.equal(rolloutDemoNote(null), "0 of 200 trades needed to leave demo");
});

test("D13 — regime split, permits, badge counts and the auto-select sentence", () => {
  const split = regimeSplit(regimeRead());
  assert.ok(split && Math.abs(split.trend - 0.71) < 1e-9 && Math.abs(split.range - 0.2) < 1e-9 && Math.abs(split.disorder - 0.09) < 1e-9);
  assert.equal(regimeSplit(regimeRead({ available: false })), null);
  assert.equal(regimeSplit(null), null);
  assert.equal(regimePermitLabel(regimeRead()), "Buy ok · Sell no");
  assert.equal(regimePermitLabel(null), null);
  assert.equal(regimeTopProbability(regimeRead()), 0.71);
  assert.equal(regimeTopProbability(regimeRead({ posterior: {} })), null);

  assert.equal(governedAgentAlertCount([{ status: "active" }, { status: "halved" }, { status: "disabled" }]), 2);
  assert.equal(governedAgentAlertCount([]), 0);

  assert.equal(
    autoSelectSummary({ scanned: 9, qualified: 2, skipped: ["US30"], reason: "Chose EURUSD on the lower-bound edge." }),
    "Scanned 9 - qualified 2 - skipped 1 (US30). Chose EURUSD on the lower-bound edge.",
  );
  assert.equal(autoSelectSummary(null), null);
  assert.equal(nextAutoSelectLabel(null, 0), null);
  assert.equal(nextAutoSelectLabel(45_000, 0), "next pass in 45s");
  assert.equal(nextAutoSelectLabel(125_000, 0), "next pass in 2m");

  const csv = closedTradesCsv([
    { closedAt: 0, symbol: "EURUSD", side: "buy", volume: 0.1, agents: ["trend"], rMultiple: 1.4, profit: 128.6, swap: 0, commission: 0 },
    { closedAt: 1, symbol: "XAUUSD", side: "sell", volume: 0.05, agents: null, rMultiple: null, profit: -40, swap: -1, commission: -0.5 },
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "closedAt,symbol,side,lots,agents,resultR,pnl");
  assert.equal(lines[1], "1970-01-01T00:00:00.000Z,EURUSD,buy,0.1,trend,1.400,128.60");
  // No attribution and no R ⇒ empty cells, never invented ones.
  assert.equal(lines[2], "1970-01-01T00:00:00.001Z,XAUUSD,sell,0.05,,,-41.50");
});

test("D14 — by-agent attribution pools only what the server attributed", () => {
  const rows = agentAttribution([
    { agents: ["trend", "meanrev"], rMultiple: 1.4 },
    { agents: ["trend"], rMultiple: -0.6 },
    { agents: ["meanrev"], rMultiple: null },
    { agents: null, rMultiple: 2.0 },
    { agents: [], rMultiple: 0.5 },
    { agents: ["trend", "trend"], rMultiple: 0.2 },
  ]);
  // trend: 1.4 - 0.6 + 0.2 = 1.0 over 3 trades (the duplicated agent counts once per trade).
  const trend = rows.find((row) => row.agent === "trend");
  assert.ok(trend && trend.trades === 3 && trend.measured === 3);
  assert.ok(Math.abs((trend?.totalR ?? 0) - 1.0) < 1e-9);
  // meanrev: one measured (1.4), one unmeasured ⇒ totalR is the measured sum.
  const meanrev = rows.find((row) => row.agent === "meanrev");
  assert.ok(meanrev && meanrev.trades === 2 && meanrev.measured === 1);
  assert.ok(Math.abs((meanrev?.totalR ?? 0) - 1.4) < 1e-9);
  // The unattributed trades (null and []) belong to no row at all.
  assert.deepEqual(rows.map((row) => row.agent).sort(), ["meanrev", "trend"]);
  // Sorted by totalR descending: meanrev's 1.4R outranks trend's 1.0R.
  assert.deepEqual(rows.map((row) => row.agent), ["meanrev", "trend"]);
  // An agent whose trades are ALL unmeasured shows totalR null, not 0.
  const unmeasured = agentAttribution([{ agents: ["x"], rMultiple: null }]);
  assert.equal(unmeasured[0].totalR, null);
  assert.deepEqual(agentAttribution([]), []);
});
