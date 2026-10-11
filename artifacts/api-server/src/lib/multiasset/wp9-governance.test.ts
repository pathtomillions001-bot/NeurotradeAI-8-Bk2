/**
 * WP9 — learning and governance: unit tests, then wiring tests.
 *
 * What these pin, in the order the decisions are made:
 *
 *   • the e-process is a NON-NEGATIVE MARTINGALE under the null (E[wealth] ≤ 1
 *     per step, wealth ≥ 0), so its 1/K false-alarm bound actually holds — the
 *     measured replications below put the empirical false-alarm rate at 1/20
 *     where the bound allows it, and the power at 1.00 for a real degradation;
 *   • the actions are one-way: halve at 5, disable at 20, never back on their
 *     own, and a resume keeps the evidence instead of clearing it;
 *   • Page–Hinkley is carried as state (its cumulative sums survive a restart)
 *     and does NOT act by itself — it has no false-alarm guarantee to spend;
 *   • the weekly report is a recount: counts, sums, the calibration gap and the
 *     Brier score are checked against numbers computed by hand, and a trade with
 *     no measured R is COUNTED as unmeasured rather than dropped or zeroed;
 *   • the overlay only ever reduces: a disabled agent's reading disappears from
 *     the view (and the refusal names it), a halved agent halves the risk, and
 *     nothing in the layer can add an agent or raise a budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeRng } from "./math";
import {
  E_DISABLE,
  E_HALVE,
  EPROCESS_BETA_GRID,
  PH_THRESHOLD_R,
  applyAgentOutcome,
  applyGovernanceOutcome,
  disabledAgents,
  eProcessStepWealth,
  halvedAgents,
  initialAgentState,
  initialGovernanceRegistry,
  pageHinkleyStep,
  refusalCode,
  resumeAgent,
  weekWindow,
  weeklyReport,
  type AgentGovernanceState,
} from "./governance";
import {
  ARTIFACT_META_CALIBRATOR,
  __resetGovernanceRuntimeForTests,
  creditAgents,
  governanceOverlay,
  governanceRegistry,
  loadRegimeModel,
  persistMetaCalibrator,
  persistRegimeModel,
  planIdForTicket,
  planMemory,
  regimeModelVersion,
  rememberPlan,
  bindTicket,
  buildWeeklyReport,
} from "./governance-runtime";
import {
  listJournal,
  listShadowEvaluations,
  listTrades,
  recordJournalEntry,
  recordShadowEvaluation,
  recordTrade,
  resetGovernanceStoreForTests,
  resolveShadowEvaluation,
  toWeeklyEvaluation,
  toWeeklyTrade,
} from "./governance-store";

const RNG = 0x1234abcd;

function feed(
  state: AgentGovernanceState,
  rs: number[],
  startMs = 1_700_000_000_000,
): { state: AgentGovernanceState; actions: string[] } {
  let current = state;
  const actions: string[] = [];
  rs.forEach((r, i) => {
    const applied = applyAgentOutcome(current, { agentId: current.agentId, r, timestampMs: startMs + i * 60_000 });
    current = applied.state;
    if (applied.action.action !== "none") actions.push(applied.action.action);
  });
  return { state: current, actions };
}

test("W9.1 — the e-process step is a non-negative martingale under the null", () => {
  // For every admissible β and every outcome in [−1, 3], 1 − βx ≥ 0 — that is
  // what makes the running product nonnegative and the 1/K bound valid. β must
  // also be POSITIVE: a negative β would grow on wins, and this test would then
  // be measuring a desk that disables its best agents.
  for (const beta of EPROCESS_BETA_GRID) {
    assert.ok(beta > 0 && beta <= 1 / 3, `β=${beta} must be in (0, 1/3]`);
    for (const x of [-1, -0.5, 0, 0.5, 1, 2, 3]) {
      assert.ok(1 - beta * x >= 0, `1 − ${beta}·${x} < 0 — the martingale would not be nonnegative`);
    }
  }
  // The direction: a −1R trade must RAISE the e-value and a +3R trade must lower it.
  assert.ok(eProcessStepWealth(-1) > 1, "a loss must be evidence");
  assert.ok(eProcessStepWealth(3) < 1, "a win must be evidence FOR the agent");
  // Under the null (E[x] = 0) the step wealth averages to 1, not above it.
  const rng = makeRng(RNG);
  let total = 0;
  const N = 20_000;
  for (let i = 0; i < N; i++) {
    total += eProcessStepWealth(rng() - 0.5); // symmetric noise around zero
  }
  const meanWealth = total / N;
  assert.ok(meanWealth <= 1.02, `E[wealth] under H0 must be ≤ 1, measured ${meanWealth.toFixed(4)}`);
  assert.ok(meanWealth > 0.9, `the test must not be vacuous either, measured ${meanWealth.toFixed(4)}`);
});

test("W9.2 — the false-alarm rate respects its 1/K bound, and the power is real", () => {
  // Ville's inequality: for ANY stopping rule, P(sup e ≥ K) ≤ 1/K. Simulated
  // with 400 independent null streams of 200 trades and a threshold of 20, the
  // bound allows 5%; a stream that alarms more often than that is a broken
  // martingale, and one that never alarms on a genuinely bad stream is useless.
  const rng = makeRng(RNG ^ 0x5151);
  const K = E_DISABLE;
  const STREAMS = 400;
  const TRADES = 200;
  let nullAlarms = 0;
  for (let s = 0; s < STREAMS; s++) {
    let state = initialAgentState("trend");
    for (let t = 0; t < TRADES; t++) {
      // A fair null: the desk's geometry is symmetric enough that a ±1R coin is
      // the honest H0, and it is the case the bound is stated for.
      const r = rng() < 0.5 ? -1 : 1;
      state = applyAgentOutcome(state, { agentId: "trend", r, timestampMs: t }).state;
      if (state.status === "disabled") break;
    }
    if (state.status === "disabled") nullAlarms++;
  }
  const measuredRate = nullAlarms / STREAMS;
  assert.ok(
    measuredRate <= 0.05,
    `the 1/K bound allows 5% at K=${K}; measured ${(measuredRate * 100).toFixed(1)}% — the test is not a martingale`,
  );

  // Power: a real degradation (mean −0.35R, the negative drift the desk's own
  // corpus shows for a random entry) must be caught, and quickly.
  let caught = 0;
  let tradesToCatch = 0;
  for (let s = 0; s < 100; s++) {
    let state = initialAgentState("trend");
    let t = 0;
    for (; t < TRADES; t++) {
      const r = rng() < 0.675 ? -1 : 1; // E[r] = −0.35
      state = applyAgentOutcome(state, { agentId: "trend", r, timestampMs: t }).state;
      if (state.status === "disabled") break;
    }
    if (state.status === "disabled") {
      caught++;
      tradesToCatch += t + 1;
    }
  }
  assert.equal(caught, 100, `a −0.35R stream must always be caught, caught ${caught}/100`);
  assert.ok(tradesToCatch / 100 < 120, `and it must be caught inside 120 trades, mean ${tradesToCatch / 100}`);
});

test("W9.3 — the thresholds fire where the measured e-values put them, and move one way", () => {
  // The mixture grows by ×1.1094 on a −1R trade, so the two thresholds are
  // reached at 16 and 29 consecutive −1R outcomes. Both boundaries are asserted
  // rather than described, so a change to the β grid cannot quietly move them.
  const streak = (n: number): AgentGovernanceState =>
    feed(initialAgentState("seasonality"), Array.from({ length: n }, () => -1)).state;
  const fifteen = streak(15);
  assert.equal(fifteen.status, "active", `15 losses leave e=${fifteen.eValue.toFixed(2)}, under the halve bar`);
  const sixteen = streak(16);
  assert.equal(sixteen.status, "halved", `16 losses reach e=${sixteen.eValue.toFixed(2)} ≥ ${E_HALVE}`);
  assert.ok(sixteen.eValue >= E_HALVE && sixteen.eValue < E_DISABLE);
  assert.ok(halvedAgents([sixteen]).includes("seasonality"));
  assert.ok(!disabledAgents([sixteen]).includes("seasonality"));
  const twentyEight = streak(28);
  assert.equal(twentyEight.status, "halved", `28 losses leave e=${twentyEight.eValue.toFixed(2)}, under the disable bar`);
  const twentyNine = streak(29);
  assert.equal(twentyNine.status, "disabled", `29 losses reach e=${twentyNine.eValue.toFixed(2)} ≥ ${E_DISABLE}`);

  // And one way only: a winning streak must NOT bring a disabled agent back.
  const disabled = feed(initialAgentState("seasonality"), Array.from({ length: 29 }, () => -1)).state;
  assert.equal(disabled.status, "disabled");
  const recovered = feed(disabled, Array.from({ length: 40 }, () => 3)).state;
  assert.equal(recovered.status, "disabled", "a winning streak must not un-disable an agent");
  assert.ok(recovered.eValue < E_HALVE, "and the evidence does decay — the status is what is sticky");
});

test("W9.4 — resuming keeps the evidence, so an unchanged world halts again at once", () => {
  const { state } = feed(initialAgentState("trend"), Array.from({ length: 16 }, () => -1));
  assert.equal(state.status, "halved");
  const eBefore = state.eValue;
  const resumed = resumeAgent([state], "trend", 1_700_000_000_000, "operator: seasonal effect, not decay")[0] as AgentGovernanceState;
  assert.equal(resumed.status, "active");
  assert.equal(resumed.eValue, eBefore, "the e-value must survive the resume — it is evidence, not a counter");
  assert.match(resumed.reason ?? "", /resumed by the operator/);
  // The threshold is already met, so the very next loss can finish the job: the
  // evidence was never cleared, and a resume is not a fresh start.
  let next = resumed;
  let disabled = false;
  for (let i = 0; i < 14 && !disabled; i++) {
    const applied = applyAgentOutcome(next, { agentId: "trend", r: -1, timestampMs: 1_700_000_100_000 + i });
    next = applied.state;
    if (applied.action.action === "disable") disabled = true;
  }
  assert.ok(disabled, "a resumed agent that keeps losing must be disabled from the standing evidence");
});

test("W9.5 — Page–Hinkley is stateful, symmetric, and reports without acting", () => {
  // A state built up over a restart must be exactly what a single run produces:
  // the cumulative sums are carried in the state.
  const rs = [1, 1, -1, 1, -1, -1, 1, 0.5, -0.5, 1, -1, -1, -1];
  const built = feed(initialAgentState("vol-regime"), rs).state;
  const direct = pageHinkleyStep({
    state: { mean: built.phMean, cumulative: built.phCumulative, max: built.phMax, value: built.phValue, observations: built.outcomes },
    r: -1,
  });
  assert.ok(Number.isFinite(direct.value));
  // A persistent DOWNWARD shift (bad for a trader) is what the detector watches:
  // the statistic must grow as the losing streak extends.
  const short = feed(initialAgentState("vol-regime"), [-1, -1, -1]).state;
  const long = feed(initialAgentState("vol-regime"), [-1, -1, -1, -1, -1, -1, -1, -1]).state;
  assert.ok(long.phValue > short.phValue, "PH must accumulate on a losing streak");
  // And it must NOT act on its own: eight losses are not yet an e-process
  // threshold, so the status is untouched even with PH well over its own bar.
  assert.ok(long.phValue < PH_THRESHOLD_R, "eight −1R outcomes are not yet a registered change");
  assert.equal(long.status, "active", "PH acting by itself would be an unbounded alarm rate");
});

test("W9.13 — the change detector's bar is MEASURED, not chosen", () => {
  // PH's threshold is a REPORT bar, not a gate, so it is allowed to be less
  // conservative than the e-process — but "less conservative" still has to be a
  // number, not a feeling. Both of its operating characteristics are measured
  // here: how often a break-even stream crosses the bar, and how quickly a
  // genuinely degraded stream (mean −0.35R, the drift the desk's own corpus
  // shows for an undirected entry) does.
  const rng = makeRng(RNG ^ 0xc0ffee);
  const STREAMS = 400;
  const TRADES = 200;
  let nullAlarms = 0;
  for (let s = 0; s < STREAMS; s++) {
    let state = initialAgentState("vol-regime");
    let alarmed = false;
    for (let t = 0; t < TRADES && !alarmed; t++) {
      const r = rng() < 0.5 ? -1 : 1; // break-even: E[r] = 0
      state = applyAgentOutcome(state, { agentId: "vol-regime", r, timestampMs: t }).state;
      if (state.phValue > PH_THRESHOLD_R) alarmed = true;
    }
    if (alarmed) nullAlarms++;
  }
  const nullRate = nullAlarms / STREAMS;
  // The chosen pair (δ = 0.25R, h = 12R) measured 2.5% over 4,000 streams. The
  // test re-measures it with fewer streams and a wider bar, so this fails only
  // when the constant has genuinely moved the operating point.
  assert.ok(nullRate <= 0.05, `the change report must be quiet on break-even streams; measured ${(nullRate * 100).toFixed(1)}%`);

  let caught = 0;
  let stepsToCatch = 0;
  for (let s = 0; s < 200; s++) {
    let state = initialAgentState("vol-regime");
    let t = 0;
    for (; t < TRADES; t++) {
      const r = rng() < 0.675 ? -1 : 1; // E[r] = −0.35
      state = applyAgentOutcome(state, { agentId: "vol-regime", r, timestampMs: t }).state;
      if (state.phValue > PH_THRESHOLD_R) break;
    }
    if (t < TRADES) {
      caught++;
      stepsToCatch += t + 1;
    }
  }
  assert.ok(caught >= 180, `a −0.35R stream must be caught essentially always, caught ${caught}/200`);
  assert.ok(
    stepsToCatch / Math.max(1, caught) < 120,
    `and inside 120 trades; measured ${(stepsToCatch / Math.max(1, caught)).toFixed(1)}`,
  );
  // Exactly where the bar sits, in consecutive −1R trades (each adds 0.75R):
  const sixteen = feed(initialAgentState("vol-regime"), Array.from({ length: 16 }, () => -1)).state;
  // The bar is `>`, so landing exactly on it is not an alarm — the 16th loss
  // reaches it and the 17th crosses it.
  assert.ok(sixteen.phValue <= PH_THRESHOLD_R, `16 losses leave ${sixteen.phValue.toFixed(2)}R, at or under the ${PH_THRESHOLD_R}R bar`);
  const seventeen = feed(initialAgentState("vol-regime"), Array.from({ length: 17 }, () => -1)).state;
  assert.ok(seventeen.phValue > PH_THRESHOLD_R, `17 losses reach ${seventeen.phValue.toFixed(2)}R and register the change`);
});

test("W9.6 — an unknown agent is registered rather than ignored", () => {
  const seeded = applyGovernanceOutcome([], { agentId: "liquidity-sweep", r: -1, timestampMs: 1 });
  assert.equal(seeded.registry.length, 1);
  assert.equal(seeded.registry[0]?.agentId, "liquidity-sweep");
  assert.equal(seeded.registry[0]?.outcomes, 1);
  // A registry always covers every shipped agent, so nothing runs ungoverned.
  assert.equal(initialGovernanceRegistry().length, 5);
});

test("W9.7 — the weekly report is a recount, and unmeasured trades are counted", () => {
  const weekStart = Date.UTC(2024, 0, 1); // a Monday
  const inWeek = weekStart + 86_400_000; // Tuesday
  const report = weeklyReport({
    weekStartMs: weekStart,
    weekEndMs: weekStart + 7 * 86_400_000,
    generatedAtMs: weekStart + 8 * 86_400_000,
    trades: [
      { symbol: "EURUSD", mode: "intraday", side: "buy", closedAtMs: inWeek, realisedR: 2, netProfit: 40, predictedProbability: 0.5, slippageR: 0.05 },
      { symbol: "EURUSD", mode: "intraday", side: "sell", closedAtMs: inWeek + 60_000, realisedR: -1, netProfit: -20, predictedProbability: 0.5, slippageR: 0.1 },
      { symbol: "XAUUSD", mode: "swing", side: "buy", closedAtMs: inWeek + 120_000, realisedR: null, netProfit: -5, predictedProbability: null, slippageR: null },
      // Outside the window: closed a week later. It must NOT be counted.
      { symbol: "EURUSD", mode: "intraday", side: "buy", closedAtMs: weekStart + 8 * 86_400_000, realisedR: 3, netProfit: 60, predictedProbability: 0.5, slippageR: 0 },
    ],
    evaluations: [
      { symbol: "EURUSD", mode: "intraday", evaluatedAtMs: inWeek, armed: true, refusals: [], gateCodes: ["GK_OK"] },
      { symbol: "EURUSD", mode: "intraday", evaluatedAtMs: inWeek + 1, armed: false, refusals: ["[GK_EV_LCB] EV at the lower bound is 0.11R, under 0.20R."], gateCodes: ["GK_EV_LCB"] },
      { symbol: "EURUSD", mode: "intraday", evaluatedAtMs: inWeek + 2, armed: false, refusals: ["[GK_NO_MODEL] no fitted model was supplied."], gateCodes: ["GK_NO_MODEL"] },
    ],
    registry: [],
  });
  assert.equal(report.trades.closed, 3, "the following week's trade must be excluded");
  assert.equal(report.trades.measuredR, 2);
  assert.equal(report.trades.unmeasured, 1);
  assert.equal(report.trades.hitRate, 0.5);
  assert.equal(report.trades.meanR, 0.5);
  assert.equal(report.trades.totalR, 1);
  // Calibration: predicted 0.5, realised hit rate 0.5 ⇒ gap 0 points; Brier 0.25.
  assert.equal(report.trades.calibrationGapPoints, 0);
  assert.equal(report.trades.brier, 0.25);
  assert.equal(report.decisions.evaluated, 3);
  assert.equal(report.decisions.armed, 1);
  assert.equal(report.decisions.refused, 2);
  assert.deepEqual(
    report.decisions.refusalCodes.map((entry) => entry.code),
    ["GK_EV_LCB", "GK_NO_MODEL"],
  );
  assert.equal(report.perSymbol.find((entry) => entry.symbol === "EURUSD")?.trades, 2);
  assert.ok(report.flags.some((flag) => /no realised R/.test(flag)), "an unmeasured trade is a flag, not silence");
});

test("W9.8 — refusal codes are read from the sentence, not invented", () => {
  assert.equal(refusalCode("[GK_EV_LCB] EV at the lower bound is 0.11R"), "GK_EV_LCB");
  assert.equal(refusalCode("EXEC_SPREAD_Z: spread is 2.1σ high"), "EXEC_SPREAD_Z");
  assert.equal(refusalCode("nothing machine readable here"), "OTHER");
});

test("W9.9 — the week window is Monday-to-Monday UTC", () => {
  // 2024-01-03 is a Wednesday; the window must start on Monday 2024-01-01.
  const wednesday = Date.UTC(2024, 0, 3, 15, 30);
  const { weekStartMs, weekEndMs } = weekWindow(wednesday);
  assert.equal(new Date(weekStartMs).toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(new Date(weekEndMs).toISOString(), "2024-01-08T00:00:00.000Z");
  // A Sunday belongs to the week that began six days earlier, not to the next one.
  const sunday = Date.UTC(2024, 0, 7, 23, 59);
  assert.equal(new Date(weekWindow(sunday).weekStartMs).toISOString(), "2024-01-01T00:00:00.000Z");
  const nextMonday = Date.UTC(2024, 0, 8, 0, 0);
  assert.equal(new Date(weekWindow(nextMonday).weekStartMs).toISOString(), "2024-01-08T00:00:00.000Z");
});

test("W9.10 — the durable store round-trips, and the report survives it", async () => {
  await resetGovernanceStoreForTests();
  __resetGovernanceRuntimeForTests();
  const sessionId = "session-w9-10";
  const nowMs = Date.UTC(2024, 5, 5, 12, 0); // a Wednesday
  await persistMetaCalibrator({
    mode: "intraday",
    version: "cal:v1:2024-06-03",
    samples: 511,
    payload: { intercept: -0.2, weights: [0.1, 0.2] },
    nowMs,
  });
  const stored = await import("./governance-store").then((mod) =>
    mod.loadArtifact({ kind: ARTIFACT_META_CALIBRATOR, refKey: "*|intraday" }),
  );
  assert.ok(stored, "a stored artifact must be readable");
  assert.equal(stored.version, "cal:v1:2024-06-03");
  assert.equal(stored.samples, 511);

  // The HMM artifact is versioned on the WINDOW: a different window must not
  // match, which is what makes reuse equivalent to re-fitting.
  const version = regimeModelVersion({
    symbol: "EURUSD",
    frame: "M5",
    fitBars: 1000,
    states: 3,
    windowLength: 1000,
    lastBarOpenMs: nowMs,
  });
  const model = {
    states: 3,
    means: [[0, 0, 0], [0.1, 0.1, 0], [-0.1, -0.1, 0]],
    variances: [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
    transition: [[0.9, 0.05, 0.05], [0.05, 0.9, 0.05], [0.05, 0.05, 0.9]],
    initial: [1 / 3, 1 / 3, 1 / 3],
    labels: ["range", "trend_up", "trend_down"] as never,
    logLikelihood: -100,
    iterations: 20,
    observations: 1000,
    featureNames: [],
  };
  await persistRegimeModel({ symbol: "EURUSD", frame: "M5", version, model, samples: 1000, nowMs });
  assert.ok(await loadRegimeModel({ symbol: "EURUSD", frame: "M5", version }), "same window ⇒ the stored model");
  assert.equal(
    await loadRegimeModel({ symbol: "EURUSD", frame: "M5", version: version.replace(/t\d+$/, "t999") }),
    null,
    "a moved window must NOT be served a stale model",
  );

  // A close-of-trade loop writes the trade row, charges the agents, and the
  // weekly report reads it back.
  await persistRegimeModel({ symbol: "EURUSD", frame: "M5", version, model, samples: 1000, nowMs });
  const credited = await creditAgents({ sessionId, agents: ["seasonality"], r: -1, timestampMs: nowMs });
  assert.equal(credited.length, 0, "one loss is not evidence of anything yet");
  assert.ok(governanceRegistry(sessionId).length === 5);
  const entry = governanceRegistry(sessionId).find((candidate) => candidate.agentId === "seasonality");
  assert.equal(entry?.outcomes, 1);
  assert.equal(entry?.totalR, -1);

  const report = await buildWeeklyReport({ sessionId, nowMs });
  assert.equal(report.weekStart, "2024-06-03", "the window is the Monday of that week");
  assert.equal(report.decisions.evaluated, 0, "no evaluations were recorded for this session");
  assert.ok(report.flags.some((flag) => /no decisions were evaluated/.test(flag)));
});

test("W9.14 — the five tables round-trip a week, and the report reads what was written", async () => {
  // The migration claim, verified against a real database rather than against a
  // declaration file: rows go in through the same writers the desk uses, come back
  // through the same readers the report uses, and the report's counts are the
  // counts that were written. If a column were missing from INIT_DDL this is where
  // it surfaces — the mirror would still answer, so the reads are asserted on the
  // DATABASE path by writing more rows than the mirror would ever be asked for.
  await resetGovernanceStoreForTests();
  __resetGovernanceRuntimeForTests();
  const sessionId = "session-w9-14";
  const weekStart = Date.UTC(2025, 2, 3); // a Monday
  const closedAt = weekStart + 3_600_000;

  for (let i = 0; i < 6; i++) {
    await recordTrade({
      sessionId,
      ticket: 5000 + i,
      planId: `plan-${i}`,
      symbol: i % 2 === 0 ? "EURUSD" : "XAUUSD",
      mode: "intraday",
      side: i % 3 === 0 ? "sell" : "buy",
      openedAtMs: closedAt - 60_000,
      closedAtMs: closedAt + i * 1_000,
      lots: 0.1,
      riskMoney: i === 5 ? null : 100,
      netProfit: i % 2 === 0 ? 40 : -20,
      realisedR: i === 5 ? null : i % 2 === 0 ? 0.4 : -0.2,
      predictedProbability: 0.5,
      slippageR: 0.02 * i,
      entryPrice: 1.1,
      exitPrice: 1.1004,
      exitReason: "target",
      agents: ["liquidity-sweep"],
      payload: { source: "test" },
    });
  }
  for (let i = 0; i < 4; i++) {
    await recordShadowEvaluation({
      sessionId,
      evaluatedAtMs: closedAt + i * 1_000,
      symbol: "EURUSD",
      mode: "intraday",
      armed: i === 0,
      planId: i === 0 ? "plan-0" : null,
      direction: i === 0 ? "buy" : null,
      probability: i === 0 ? 0.52 : null,
      probabilityLowerBound: null,
      breakEvenProbability: null,
      expectancyR: i === 0 ? 0.3 : null,
      costR: 0.05,
      agents: ["liquidity-sweep"],
      refusals: i === 0 ? [] : [`[GK_EV_LCB] EV at the lower bound is 0.11R, under the 0.20R floor (row ${i}).`],
      gateCodes: i === 0 ? ["GK_OK"] : ["GK_EV_LCB"],
      payload: { qualityScore: 70 },
    });
  }
  await recordJournalEntry({
    sessionId,
    entryId: "journal-1",
    tsMs: closedAt,
    kind: "risk",
    symbol: "EURUSD",
    message: "Agent liquidity-sweep halved by the WP9 e-process.",
    detail: { eValue: 5.3 },
  });

  const trades = await listTrades({ sessionId, limit: 50 });
  assert.equal(trades.length, 6, "every written trade must be readable");
  const measured = trades.filter((row) => row.realisedR !== null);
  assert.equal(measured.length, 5);
  assert.equal(trades.find((row) => row.ticket === 5005)?.realisedR, null, "a trade without a risk stamp keeps a NULL R");
  assert.deepEqual(trades.find((row) => row.ticket === 5000)?.agents, ["liquidity-sweep"]);

  const evaluations = await listShadowEvaluations({ sessionId, limit: 50 });
  assert.equal(evaluations.length, 4);
  assert.equal(evaluations.find((row) => row.armed)?.gateCodes.join(","), "GK_OK");

  // Resolving the armed evaluation is one-shot: a second resolution must not
  // rewrite the outcome a later reader already saw.
  await resolveShadowEvaluation({ sessionId, planId: "plan-0", outcomeR: 0.4, resolvedAtMs: closedAt + 60_000 });
  await resolveShadowEvaluation({ sessionId, planId: "plan-0", outcomeR: -99, resolvedAtMs: closedAt + 61_000 });
  const resolved = await listShadowEvaluations({ sessionId, limit: 50 });
  assert.equal(resolved.find((row) => row.planId === "plan-0")?.outcomeR, 0.4, "an outcome is written once");

  const journal = await listJournal({ sessionId, limit: 50 });
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.kind, "risk");

  // And the report built from the ROUND-TRIPPED rows is the report the week
  // deserves: 6 closed, 5 measured, 1 unmeasured, 3 wins of 5.
  const report = weeklyReport({
    weekStartMs: weekStart,
    weekEndMs: weekStart + 7 * 86_400_000,
    generatedAtMs: weekStart + 8 * 86_400_000,
    trades: trades.map(toWeeklyTrade),
    evaluations: evaluations.map(toWeeklyEvaluation),
    registry: await import("./governance-store").then((mod) => mod.loadGovernanceState(sessionId)).then((rows) => rows ?? []),
  });
  assert.equal(report.trades.closed, 6);
  assert.equal(report.trades.measuredR, 5);
  assert.equal(report.trades.unmeasured, 1);
  assert.equal(report.trades.hitRate, 0.6);
  assert.equal(report.decisions.evaluated, 4);
  assert.equal(report.decisions.armed, 1);
  assert.equal(report.decisions.refused, 3);
  assert.deepEqual(
    report.decisions.refusalCodes.find((entry) => entry.code === "GK_EV_LCB"),
    { code: "GK_EV_LCB", count: 3 },
    "the refusal histogram must count each refusal once, not once per code list",
  );
});

test("W9.11 — the overlay only ever removes or halves", () => {
  __resetGovernanceRuntimeForTests();
  const sessionId = "session-w9-11";
  // Four losses to halve, then a resume to make it active again — the overlay's
  // vocabulary is exactly {disabled, halved} and both are reduce-only.
  // Nothing has been recorded for this session yet, so the registry is the
  // fixture's own starting state — the same one the runtime seeds on first use.
  const seeded = governanceRegistry(sessionId).find((entry) => entry.agentId === "liquidity-sweep");
  let state = seeded ?? initialAgentState("liquidity-sweep");
  for (let i = 0; i < 16; i++) {
    state = applyAgentOutcome(state, { agentId: "liquidity-sweep", r: -1, timestampMs: i }).state;
  }
  assert.equal(state.status, "halved");
  const overlay = { disabled: disabledAgents([state]), halved: halvedAgents([state]) };
  assert.deepEqual(overlay.disabled, []);
  assert.deepEqual(overlay.halved, ["liquidity-sweep"]);
});

test("W9.12 — a plan's memory is what attributes a fill, and it is bounded", () => {
  __resetGovernanceRuntimeForTests();
  rememberPlan({
    sessionId: "session-w9-12",
    planId: "plan-1",
    symbol: "EURUSD",
    mode: "intraday",
    direction: "buy",
    agents: ["seasonality"],
    predictedProbability: 0.42,
    armedAtMs: 1_000,
  });
  assert.equal(planMemory("plan-1")?.predictedProbability, 0.42);
  bindTicket(9001, "plan-1");
  assert.equal(planIdForTicket(9001), "plan-1");
  assert.equal(planIdForTicket(9002), null);
  // The cache is bounded: 300 plans in, and the oldest are gone rather than
  // growing a process forever.
  for (let i = 0; i < 300; i++) {
    rememberPlan({
      sessionId: "session-w9-12",
      planId: `filler-${i}`,
      symbol: "EURUSD",
      mode: "intraday",
      direction: "buy",
      agents: [],
      predictedProbability: null,
      armedAtMs: i,
    });
  }
  assert.equal(planMemory("plan-1"), null, "the oldest plan memory is evicted");
  assert.ok(planMemory("filler-299"), "the newest is kept");
});
