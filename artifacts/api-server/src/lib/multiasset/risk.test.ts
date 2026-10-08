/**
 * Risk governor tests.
 *
 * The central guarantee asserted here: after a loss, risk goes DOWN. If a
 * future change ever introduces loss-chasing stake escalation, these tests
 * fail loudly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RISK_POLICY,
  confirmRegimeChange,
  createRiskState,
  evaluateRisk,
  ladderFor,
  recordOutcome,
  remainingDailyBudget,
  resetForNewSession,
  type RiskState,
} from "./risk";
import type { AccountSnapshot, Position, SymbolSpec } from "./types";

const EURUSD: SymbolSpec = {
  symbol: "EURUSD",
  assetClass: "forex",
  point: 0.00001,
  digits: 5,
  tickSize: 0.00001,
  tickValue: 1,
  contractSize: 100_000,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  marginInitial: 0,
  swapLong: 0,
  swapShort: 0,
  commissionPerLot: 0,
  spreadPoints: 10,
  baseCurrency: "EUR",
  quoteCurrency: "USD",
};

const GBPUSD: SymbolSpec = { ...EURUSD, symbol: "GBPUSD", baseCurrency: "GBP" };

const account: AccountSnapshot = {
  balance: 5000,
  equity: 5000,
  margin: 0,
  freeMargin: 5000,
  marginLevel: Number.POSITIVE_INFINITY,
  currency: "USD",
  leverage: 500,
  mode: "hedging",
  isLive: false,
  dayStartEquity: 5000,
  peakEquity: 5000,
};

const specs = new Map<string, SymbolSpec>([
  ["EURUSD", EURUSD],
  ["GBPUSD", GBPUSD],
]);

function check(overrides: {
  account?: Partial<AccountSnapshot>;
  positions?: Position[];
  state?: RiskState;
  policy?: Partial<typeof DEFAULT_RISK_POLICY>;
  symbol?: string;
  now?: number;
} = {}) {
  return evaluateRisk({
    symbol: overrides.symbol ?? "EURUSD",
    spec: overrides.symbol === "GBPUSD" ? GBPUSD : EURUSD,
    account: { ...account, ...(overrides.account ?? {}) },
    positions: overrides.positions ?? [],
    specs,
    state: overrides.state ?? createRiskState(),
    policy: overrides.policy,
    now: overrides.now ?? 1_000_000,
  });
}

function loss(symbol = "EURUSD", at = 1_000): { symbol: string; profit: number; closedAt: number } {
  return { symbol, profit: -50, closedAt: at };
}

// ── The core promise ─────────────────────────────────────────────────────────

test("risk DECREASES after consecutive losses — never increases", () => {
  let state = createRiskState();
  const sizes: number[] = [check({ state }).riskPct];

  for (let i = 0; i < 4; i++) {
    state = recordOutcome(state, loss("EURUSD", 1_000 + i), DEFAULT_RISK_POLICY);
    sizes.push(check({ state }).riskPct);
  }

  for (let i = 1; i < sizes.length; i++) {
    assert.ok(
      sizes[i] <= sizes[i - 1] + 1e-12,
      `risk rose from ${sizes[i - 1]} to ${sizes[i]} after a loss — martingale regression`,
    );
  }
  assert.ok(sizes[sizes.length - 1] < sizes[0], "risk must be materially lower after a losing run");
});

test("the loss ladder lowers size and raises the quality bar in step", () => {
  assert.deepEqual(ladderFor(0), { riskMultiplier: 1.0, scoreBump: 0 });
  assert.deepEqual(ladderFor(1), { riskMultiplier: 1.0, scoreBump: 0 });
  assert.equal(ladderFor(2).riskMultiplier, 0.75);
  assert.equal(ladderFor(3).riskMultiplier, 0.5);
  assert.ok(ladderFor(3).scoreBump > ladderFor(2).scoreBump);
  // Out-of-range values clamp rather than throwing.
  assert.deepEqual(ladderFor(99), ladderFor(4));
  assert.deepEqual(ladderFor(-5), ladderFor(0));
});

test("a win resets the streak and restores full size", () => {
  let state = createRiskState();
  state = recordOutcome(state, loss());
  state = recordOutcome(state, loss());
  assert.equal(state.consecutiveLosses, 2);
  const reduced = check({ state }).riskPct;

  state = recordOutcome(state, { symbol: "EURUSD", profit: 120, closedAt: 2_000 });
  assert.equal(state.consecutiveLosses, 0);
  assert.ok(check({ state }).riskPct > reduced);
});

test("risk never exceeds the policy ceiling — and the desk budget caps that ceiling", () => {
  const decision = check({ policy: { baseRiskPct: 50, maxRiskPct: 2 } });
  assert.ok(decision.riskPct <= 2);
  // The desk's per-trade budget is 0.5%: a policy asking for 2% gets 0.5%, and
  // the ceiling is what the sizer's minimum-lot decision is judged against.
  assert.equal(decision.riskCeilingPct, 0.5);
  assert.ok(decision.riskPct <= 0.5 + 1e-12, `${decision.riskPct}% exceeds the budget`);
});

// ── Symbol-level responses ───────────────────────────────────────────────────

test("three losses on one symbol trigger a cool-down", () => {
  let state = createRiskState();
  for (let i = 0; i < 3; i++) state = recordOutcome(state, loss("EURUSD", 1_000));
  assert.ok((state.symbolCooldownUntil.EURUSD ?? 0) > 1_000);

  const blocked = check({ state, now: 1_000 + 60_000 });
  assert.equal(blocked.allow, false);
  assert.ok(blocked.breaches.some((b) => /cooling down/.test(b)));

  // A different symbol is unaffected.
  assert.equal(check({ state, symbol: "GBPUSD", now: 1_000 + 60_000 }).allow, true);
});

test("cool-down expires on its own", () => {
  let state = createRiskState();
  for (let i = 0; i < 3; i++) state = recordOutcome(state, loss("EURUSD", 1_000));
  const after = check({ state, now: 1_000 + DEFAULT_RISK_POLICY.symbolCooldownMs + 1 });
  assert.ok(!after.breaches.some((b) => /cooling down/.test(b)));
});

test("four losses on a symbol suspend it until a regime change is confirmed", () => {
  let state = createRiskState();
  for (let i = 0; i < 4; i++) state = recordOutcome(state, loss("EURUSD", 1_000));
  assert.deepEqual(state.suspendedSymbols, ["EURUSD"]);

  const blocked = check({ state, now: 10_000_000 });
  assert.equal(blocked.allow, false);
  assert.ok(blocked.breaches.some((b) => /suspended/.test(b)));

  state = confirmRegimeChange(state, "EURUSD");
  assert.deepEqual(state.suspendedSymbols, []);
  assert.equal(check({ state, now: 10_000_000 }).allow, true);
});

test("a suspension survives the daily reset; the loss counters do not", () => {
  let state = createRiskState();
  for (let i = 0; i < 4; i++) state = recordOutcome(state, loss("EURUSD", 1_000));
  state = resetForNewSession(state);
  assert.deepEqual(state.suspendedSymbols, ["EURUSD"]);
  assert.equal(state.consecutiveLosses, 0);
  assert.equal(state.realisedPnlToday, 0);
});

test("five consecutive losses halt the desk for the session", () => {
  let state = createRiskState();
  for (let i = 0; i < 5; i++) state = recordOutcome(state, loss("EURUSD", 1_000));
  assert.equal(state.haltedUntilNextSession, true);
  // Even a fresh, untouched symbol is blocked once the desk is halted.
  const decision = check({ state, symbol: "GBPUSD" });
  assert.equal(decision.allow, false);
  assert.ok(decision.breaches.some((b) => /consecutive losses/.test(b)));
});

// ── Account-level circuit breakers ───────────────────────────────────────────

test("the daily loss limit blocks new trades", () => {
  const atLimit = check({ account: { equity: 4850 } }); // −3% of 5,000
  assert.equal(atLimit.allow, false);
  assert.ok(atLimit.breaches.some((b) => /Daily loss/.test(b)));

  const underLimit = check({ account: { equity: 4950 } }); // −1%
  assert.equal(underLimit.allow, true);
  assert.ok(underLimit.reasons.some((r) => /Daily P&L/.test(r)));
});

test("the drawdown-from-peak limit blocks new trades", () => {
  const decision = check({ account: { equity: 4400, peakEquity: 5000, dayStartEquity: 4400 } });
  assert.equal(decision.allow, false);
  assert.ok(decision.breaches.some((b) => /Drawdown/.test(b)));
});

test("the open-position cap is enforced", () => {
  // The default cap is deliberately generous (12) — the desk imposes no
  // per-mode limit on how many setups may be taken. What matters is that the
  // cap still exists and still refuses once it is reached.
  const positions: Position[] = Array.from({ length: DEFAULT_RISK_POLICY.maxOpenPositions }, (_, i) => ({
    ticket: i + 1, symbol: `SYM${i}`, side: "buy", volume: 0.1, openPrice: 1,
    openTime: 0, sl: null, tp: null, profit: 0, swap: 0, commission: 0,
  }));
  const decision = check({ positions });
  assert.equal(decision.allow, false);
  assert.ok(decision.breaches.some((b) => /positions open/.test(b)));
  // One fewer position and the same desk is allowed to trade again.
  assert.equal(check({ positions: positions.slice(0, -1) }).allow, true);
});

test("the per-symbol position limit leaves room to add, then blocks", () => {
  const limit = DEFAULT_RISK_POLICY.maxPositionsPerSymbol;
  const positions: Position[] = Array.from({ length: limit }, (_, i) => ({
    ticket: i + 1, symbol: "EURUSD", side: "buy", volume: 0.1, openPrice: 1.08,
    openTime: 0, sl: null, tp: null, profit: 0, swap: 0, commission: 0,
  }));
  // At the per-symbol limit, the same symbol is refused...
  assert.equal(check({ positions }).allow, false);
  // ...while a different symbol is still fine, and one fewer EURUSD position
  // re-opens the symbol.
  assert.equal(check({ positions, symbol: "GBPUSD" }).allow, true);
  assert.equal(check({ positions: positions.slice(0, -1) }).allow, true);
});

test("correlated exposure is capped across symbols, not just per trade", () => {
  // Two open longs against USD at 1% each already reach the 2% USD cap, so a
  // third dollar-denominated trade must be refused even though no single
  // trade breaks any per-trade rule.
  const positions: Position[] = [
    {
      ticket: 1, symbol: "EURUSD", side: "buy", volume: 0.4, openPrice: 1.0845,
      openTime: 0, sl: 1.0833, tp: null, profit: 0, swap: 0, commission: 0,
      initialRiskMoney: 50,
    },
    {
      ticket: 2, symbol: "GBPUSD", side: "buy", volume: 0.4, openPrice: 1.27,
      openTime: 0, sl: 1.2688, tp: null, profit: 0, swap: 0, commission: 0,
      initialRiskMoney: 50,
    },
  ];
  const decision = check({ positions, policy: { maxPositionsPerSymbol: 5, maxOpenPositions: 10 } });
  assert.equal(decision.allow, false);
  assert.ok(decision.breaches.some((b) => /exposure on USD/.test(b)), decision.breaches.join(" | "));
});

test("a low margin level blocks new trades", () => {
  const decision = check({ account: { marginLevel: 300, margin: 1000 } });
  assert.equal(decision.allow, false);
  assert.ok(decision.breaches.some((b) => /Margin level/.test(b)));
});

test("an unopened account with infinite margin level is not blocked", () => {
  assert.equal(check({ account: { marginLevel: Number.POSITIVE_INFINITY } }).allow, true);
});

// ── Live-account gate ────────────────────────────────────────────────────────

test("a real-money account is refused until live trading is explicitly enabled", () => {
  const blocked = check({ account: { isLive: true } });
  assert.equal(blocked.allow, false);
  assert.ok(blocked.breaches.some((b) => /Live trading is disabled/.test(b)));

  const allowed = check({ account: { isLive: true }, policy: { liveTradingEnabled: true } });
  assert.equal(allowed.allow, true);
});

test("a demo account trades without the live flag", () => {
  assert.equal(check({ account: { isLive: false } }).allow, true);
});

// ── Bookkeeping ──────────────────────────────────────────────────────────────

test("realised P&L and trade count accumulate", () => {
  let state = createRiskState();
  state = recordOutcome(state, { symbol: "EURUSD", profit: -30, closedAt: 1 });
  state = recordOutcome(state, { symbol: "EURUSD", profit: 80, closedAt: 2 });
  assert.equal(state.realisedPnlToday, 50);
  assert.equal(state.tradesToday, 2);
});

test("the daily budget gauge reports usage, remaining and limit", () => {
  const fresh = remainingDailyBudget(account);
  assert.equal(fresh.limitMoney, 150); // 3% of 5,000
  assert.equal(fresh.remainingMoney, 150);
  assert.equal(fresh.usedPct, 0);

  const half = remainingDailyBudget({ ...account, equity: 4925 });
  assert.ok(Math.abs(half.usedPct - 50) < 1e-9);
  assert.ok(Math.abs(half.remainingMoney - 75) < 1e-9);

  // Past the limit it saturates rather than going negative.
  const blown = remainingDailyBudget({ ...account, equity: 4000 });
  assert.equal(blown.usedPct, 100);
  assert.equal(blown.remainingMoney, 0);
});

test("recordOutcome does not mutate the state it is given", () => {
  const state = createRiskState();
  const next = recordOutcome(state, loss());
  assert.equal(state.consecutiveLosses, 0, "input state must be untouched");
  assert.equal(next.consecutiveLosses, 1);
});
