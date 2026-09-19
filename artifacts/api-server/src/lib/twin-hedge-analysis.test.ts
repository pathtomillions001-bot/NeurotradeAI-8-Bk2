/**
 * Twin-Lock Hedge Sentinel — analysis & ledger-contract tests.
 *
 * Pins the three things the bot's product rules rest on:
 *   1. the hard-wired contract pairs and their win semantics;
 *   2. the 4/5 boundary math — hazard model, crossing stats, entry gate;
 *   3. the recovery sizing fed to the SHARED ledger as the pair's net-profit
 *      rate (m−1), so debt digests on the ROUND, not on one leg.
 */

import { test } from "node:test";
import assert from "node:assert";
import {
  TWIN_NORMAL_LEGS,
  TWIN_RECOVERY_LEGS,
  isGapDigit,
  legWins,
  legLabel,
  recoveryBreakEvenGapRate,
  edgeHazard,
  crossingStats,
  twinEntryGate,
  simulateTwinSession,
  evaluateTwinMarket,
  screenAndRankTwin,
} from "./twin-hedge-analysis";
import { calculateBotRecoveryStake, toCents } from "./recovery-math";
import { reduceRecoveryOutcome, createRecoveryState } from "./agents/recovery-engine";

function rng(seed: number) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function uniform(n: number, seed = 7) { const r = rng(seed); return Array.from({ length: n }, () => Math.floor(r() * 10)); }
/** A stream that NEVER shows 4 or 5 — the dream environment for both pairs. */
function noGap(n: number, seed = 3) { const r = rng(seed); const safe = [0, 1, 2, 3, 6, 7, 8, 9]; return Array.from({ length: n }, () => safe[Math.floor(r() * 8)]!); }
/** A stream dominated by 4/5 — the disaster environment. */
function gapHeavy(n: number, seed = 5, share = 0.45) { const r = rng(seed); return Array.from({ length: n }, () => r() < share ? (r() < 0.5 ? 4 : 5) : Math.floor(r() * 10)); }

// ── 1. Contract vocabulary ────────────────────────────────────────────────────

test("pairs are exactly Over4+Under5 normal and Over5+Under4 recovery", () => {
  assert.deepEqual(TWIN_NORMAL_LEGS.map(l => `${l.side}${l.barrier}`), ["DIGITOVER4", "DIGITUNDER5"]);
  assert.deepEqual(TWIN_RECOVERY_LEGS.map(l => `${l.side}${l.barrier}`), ["DIGITOVER5", "DIGITUNDER4"]);
  assert.equal(legLabel(TWIN_NORMAL_LEGS[0]!), "Over 4");
  assert.equal(legLabel(TWIN_RECOVERY_LEGS[1]!), "Under 4");
});

test("gap digits are 4 and 5 and only those", () => {
  assert.equal(isGapDigit(4), true);
  assert.equal(isGapDigit(5), true);
  assert.equal(isGapDigit(3), false);
  assert.equal(isGapDigit(6), false);
});

test("normal legs are complementary: exactly one wins on ANY same-tick digit", () => {
  for (let d = 0; d <= 9; d++) {
    const a = legWins(TWIN_NORMAL_LEGS[0]!, d);
    const b = legWins(TWIN_NORMAL_LEGS[1]!, d);
    assert.notEqual(a, b, `digit ${d} must win exactly one normal leg`);
  }
});

test("recovery legs lose BOTH iff the digit is 4 or 5 (same tick)", () => {
  for (let d = 0; d <= 9; d++) {
    const a = legWins(TWIN_RECOVERY_LEGS[0]!, d);
    const b = legWins(TWIN_RECOVERY_LEGS[1]!, d);
    assert.equal(!a && !b, isGapDigit(d), `digit ${d}: both-lose ${isGapDigit(d) ? "expected" : "forbidden"}`);
  }
});

test("recovery break-even gap-avoidance rate is 2/m", () => {
  const q = recoveryBreakEvenGapRate(2.43);
  assert.ok(Math.abs(q - 2 / 2.43) < 1e-9);
  assert.equal(recoveryBreakEvenGapRate(2.0) > 0.99, true);
});

// ── 2. Hazard model & crossing stats ──────────────────────────────────────────

test("edgeHazard: short history returns a refusing hazard", () => {
  const h = edgeHazard([1, 2, 3]);
  assert.ok(h.pWorst >= 0.9);
});

test("edgeHazard: gap-free stream clears the ceiling, gap-heavy does not", () => {
  const clean = edgeHazard(noGap(600));
  const hot = edgeHazard(gapHeavy(600));
  assert.ok(clean.pWorst < 0.15, `clean worst ${clean.pWorst}`);
  assert.ok(hot.pWorst > 0.35, `hot worst ${hot.pWorst}`);
  assert.ok(clean.safeLcb > hot.safeLcb);
});

test("crossingStats: alternation raises the rate, blocks lower it", () => {
  // 3,6,3,6,… crosses the boundary on EVERY step.
  const flip: number[] = [];
  for (let i = 0; i < 400; i++) flip.push(i % 2 === 0 ? 3 : 6);
  const c = crossingStats(flip);
  assert.ok(c.rate > 0.95, `alternating stream should cross every step, got ${c.rate}`);
  // 0,1,2 … 7,8,9 blocks — crossing rate ≈ 0.
  const block: number[] = [];
  for (let i = 0; i < 400; i++) block.push(Math.floor(i / 200) === 0 ? (i % 3) : 6 + (i % 3));
  const b = crossingStats(block);
  assert.ok(b.rate < 0.05, `blocked stream should rarely cross, got ${b.rate}`);
});

// ── 3. Entry gate — the two lanes ────────────────────────────────────────────

test("fast lane FIRES on a fair uniform stream — the case the old gate refused forever", () => {
  // A fair stream shows 4/5 ~20% of the time; its worst-case POSTERIOR bound
  // sits above the old 0.23–0.29 ceilings most of the time, so the gate
  // closed and the bot never traded. The fast lane judges the point rate
  // instead and must fire.
  const digits = uniform(600, 11);
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30 });
  assert.equal(v.fire, true, v.reason);
});

test("fast lane fires even when the current tick IS a gap digit (the pair is self-hedged)", () => {
  // Entering on 4 or 5 only matters through the stream's overall 4/5 rate —
  // on one settlement tick exactly one leg wins either way. A gap-free stream
  // with a single trailing 4 must still trade.
  const digits = noGap(300);
  digits[digits.length - 1] = 4;
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30, waitedTicks: 999, maxWaitTicks: 12 });
  assert.equal(v.fire, true, v.reason);
});

test("fast lane fires on a crossing tick — crossings are priced by the window, not the instant", () => {
  const digits = noGap(300);
  digits[digits.length - 2] = 2;   // LOW
  digits[digits.length - 1] = 7;   // HIGH — crossed on last tick
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30, crossedOnLastTick: true });
  assert.equal(v.fire, true, v.reason);
});

test("fast lane refuses a pathologically 4/5-heavy stream", () => {
  const digits = gapHeavy(300, 23, 0.45);
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30 });
  assert.equal(v.fire, false);
  assert.match(v.reason, /gap rate/);
});

test("fast lane refuses an up-crossing-dominant stream (the both-lose trigger is hot)", () => {
  // Long calm low side (no crossings), then a tail that climbs over the
  // boundary twice and comes back down once: 2 up-crossings vs 1
  // down-crossing in the recent window → asymmetry ≈ −0.33 < −0.2.
  const digits: number[] = [];
  for (let i = 0; i < 110; i++) digits.push(i % 2 === 0 ? 2 : 3);
  digits.push(4, 5, 6, 3, 4, 5, 6, 7);
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.99 });
  assert.equal(v.fire, false);
  assert.match(v.reason, /up-crossings/);
});

test("recovery lane holds on a boundary digit, then the patience valve FORCES the fire", () => {
  const digits = gapHeavy(300, 17, 0.4);
  const held = twinEntryGate({ digits, mode: "recovery", maxHazard: 0.40, waitedTicks: 3, maxWaitTicks: 12 });
  assert.equal(held.fire, false);
  assert.match(held.reason, /hazard|gap|cool-down/);
  // Past the valve, debt must be attacked even on an unfavourable stream —
  // and the verdict says FORCED because q̂ sits under the digest line.
  const forced = twinEntryGate({ digits, mode: "recovery", maxHazard: 0.40, waitedTicks: 12, maxWaitTicks: 12, minSafe: 0.83 });
  assert.equal(forced.fire, true);
  assert.equal(forced.forced, true);
  assert.match(forced.reason, /forced/i);
});

test("recovery lane fires unforced when the measured safe rate clears the digest line", () => {
  const digits = noGap(600, 9);
  const v = twinEntryGate({
    digits, mode: "recovery", maxHazard: 0.40, minSafe: 0.83,
    waitedTicks: 0, maxWaitTicks: 8, ticksSinceBoundary: 5,
  });
  assert.equal(v.fire, true, v.reason);
  assert.notEqual(v.forced, true);
});

test("gate fires on a clean gap-free stream away from the boundary", () => {
  const digits = noGap(600);
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30, ticksSinceBoundary: 10 });
  assert.equal(v.fire, true, v.reason);
});

// ── 4. Session simulation mechanics ───────────────────────────────────────────

test("same-tick execution (skew=0) can never produce both-loose normal rounds", () => {
  const digits = gapHeavy(400, 13, 0.35); // even a hot stream cannot both-lose a complementary pair on one tick
  const sim = simulateTwinSession(digits, {
    stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3,
    markupPercent: 10, payoutNormal: 1.95, payoutRecovery: 2.43,
    legSkewProb: 0, maxRounds: 300,
  }, 25, 10);
  assert.equal(sim.bothLoseRate, 0);
});

test("skewed settlement introduces both outcomes and the simulator prices them", () => {
  const digits = uniform(600);
  const sim = simulateTwinSession(digits, {
    stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3,
    markupPercent: 10, payoutNormal: 1.95, payoutRecovery: 2.43,
    legSkewProb: 0.4, maxRounds: 300,
  }, 25, 10);
  assert.ok(sim.bothLoseRate > 0, "40% skew on uniform digits must produce both-lose rounds");
  assert.ok(sim.bothWinRate > 0, "…and equally both-win rounds");
  assert.ok(sim.survival >= 0 && sim.survival <= 1);
});

test("evaluateTwinMarket: gap-free market is recovery-viable, gap-heavy is not", () => {
  const base = { stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, markupPercent: 10, maxStake: 500 };
  const clean = evaluateTwinMarket("R_100", "Clean", noGap(400, 21), base);
  const hot = evaluateTwinMarket("R_50", "Hot", gapHeavy(400, 22, 0.42), base);
  assert.equal(clean.recoveryViable, true, clean.reason);
  assert.equal(clean.recoveryViableWorst, true);
  assert.equal(hot.recoveryViable, false);
  assert.ok(clean.score > hot.score);
  // The hostile boundary is WARNed about, not silently BLOCKed: the digest
  // line is a badge and the gate is what holds the actual trades.
  assert.ok(hot.signals.some(s => s.startsWith("WARN") || s.startsWith("INFO")));
});

test("evaluateTwinMarket: a fair uniform market is tradeable (score clears the floor, no BLOCKED signal)", () => {
  // The regime that kept the bot idle: honest 20% gap rate, no structure.
  // It must rank as a deployable market — the normal pair is self-hedged.
  const base = { stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, markupPercent: 10, maxStake: 500 };
  const fair = evaluateTwinMarket("R_75", "Fair", uniform(400, 41), base);
  assert.ok(!fair.signals.some(s => s.startsWith("BLOCKED")), JSON.stringify(fair.signals));
  assert.ok(fair.gapHazard <= 0.30, `gap ${fair.gapHazard}`);
});

test("screenAndRankTwin puts viable markets first and flags significance", () => {
  const base = { stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, markupPercent: 10, maxStake: 500 };
  const cands = [
    evaluateTwinMarket("R_50", "Hot", gapHeavy(400, 31, 0.42), base),
    evaluateTwinMarket("R_100", "Clean", noGap(400, 32), base),
  ];
  const ranked = screenAndRankTwin(cands);
  assert.equal(ranked[0]!.symbol, "R_100");
  assert.equal(typeof ranked[0]!.significant, "boolean");
});

// ── 5. Ledger contracts: the pair fed to the shared formula ──────────────────

test("recovery stake fed (m−1) to the shared formula digests the TOTAL round loss", () => {
  // Both legs of a normal $1 round lose → total lost = $2.
  const debt = 2;
  const mRecover = 2.43;               // winning-side payout of Over5/Under4
  const legStake = calculateBotRecoveryStake(debt, Math.max(1.05, mRecover - 1), 10);
  // calculateBotRecoveryStake divides by (multiplier−1) = (m−2) → stake per leg.
  assert.ok(Math.abs(legStake - (debt * 1.1) / (mRecover - 2)) < 1e-9);
  // A covered recovery round nets S·(m−2) — that must repay debt + markup.
  const netWin = legStake * (mRecover - 2);
  assert.ok(toCents(netWin) >= toCents(debt * 1.1));
});

test("reduceRecoveryOutcome: only a both-lose round arms recovery; split never does", () => {
  let s = createRecoveryState();
  // Split normal round (net −0.05): the engine SKIPS the ledger entirely,
  // which this models by not calling recordOutcome — state must be untouched.
  assert.equal(s.inRecovery, false);
  // Both-lost normal round: total stake 2, payout feed 1 → target 0, debt 2.
  s = reduceRecoveryOutcome(s, false, -2, 2, 3, "TWINPAIR", 1);
  assert.equal(s.inRecovery, true);
  assert.equal(s.unrecoveredAmount, 2);
  assert.equal(s.targetProfit, 0);
  // A covered recovery round nets +2.20 → debt clears, recovery exits.
  s = reduceRecoveryOutcome(s, true, 2.2, 10.24, 3, "TWINPAIR", 1.43);
  assert.equal(s.inRecovery, false);
  assert.equal(s.unrecoveredAmount, 0);
});

test("both-lost recovery round compounds the debt by its FULL round stake", () => {
  let s = createRecoveryState();
  s = reduceRecoveryOutcome(s, false, -2, 2, 3, "TWINPAIR", 1);   // debt 2
  s = reduceRecoveryOutcome(s, false, -10.24, 10.24, 3, "TWINPAIR", 1.43); // recovery both lost
  assert.equal(s.inRecovery, true);
  assert.equal(s.unrecoveredAmount, 12.24);
  assert.equal(s.recoveryStep, 2);
});
