/**
 * Boundary Hedge Sentinel — analysis & ledger-contract tests.
 *
 * Pins the things the bot's product rules rest on:
 *   1. the hard-wired contract pairs and their win semantics;
 *   2. the 4/5 boundary math — hazard model, entry gate;
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
  twinEntryGate,
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

// ── 2. Hazard model ──────────────────────────────────────────────────────────

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

// ── 3. Entry gate — the two lanes ────────────────────────────────────────────

test("normal lane FIRES on a fair uniform stream", () => {
  // A fair stream shows 4/5 ~20% of the time — the gate must fire.
  const digits = uniform(600, 11);
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30 });
  assert.equal(v.fire, true, v.reason);
});

test("normal lane fires even when the current tick IS a gap digit", () => {
  // Entering on 4 or 5 only matters through the stream's overall 4/5 rate.
  const digits = noGap(300);
  digits[digits.length - 1] = 4;
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30 });
  assert.equal(v.fire, true, v.reason);
});

test("normal lane refuses a pathologically 4/5-heavy stream", () => {
  const digits = gapHeavy(300, 23, 0.45);
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30 });
  assert.equal(v.fire, false);
  assert.match(v.reason, /gap rate/);
});

test("recovery lane holds on a boundary digit", () => {
  // Stream with current digit = 4 (a gap digit) → recovery waits
  const digits = uniform(300, 15);
  digits[digits.length - 1] = 4; // force current digit to be a gap
  const held = twinEntryGate({ digits, mode: "recovery", waitedTicks: 1, maxWaitTicks: 5 });
  assert.equal(held.fire, false);
  assert.match(held.reason, /gap/);
});

test("recovery lane patience valve FORCES the fire after maxWaitTicks", () => {
  // Stream with current digit = 4 but patience valve exceeded
  const digits = uniform(300, 17);
  digits[digits.length - 1] = 4; // force current digit to be a gap
  const forced = twinEntryGate({ digits, mode: "recovery", waitedTicks: 5, maxWaitTicks: 5 });
  assert.equal(forced.fire, true);
  assert.equal(forced.forced, true);
  assert.match(forced.reason, /forced/i);
});

test("recovery lane fires unforced on a safe stream with non-gap current digit", () => {
  const digits = noGap(600, 9);
  digits[digits.length - 1] = 7; // not a gap digit
  const v = twinEntryGate({ digits, mode: "recovery", waitedTicks: 0, maxWaitTicks: 5 });
  assert.equal(v.fire, true, v.reason);
  assert.notEqual(v.forced, true);
});

test("gate fires on a clean gap-free stream", () => {
  const digits = noGap(600);
  const v = twinEntryGate({ digits, mode: "normal", maxHazard: 0.30 });
  assert.equal(v.fire, true, v.reason);
});

// ── 4. Market evaluation ─────────────────────────────────────────────────────

test("evaluateTwinMarket: gap-free market is recovery-viable, gap-heavy is not", () => {
  const opts = { stake: 1, payoutNormal: 1.95, payoutRecovery: 2.43 };
  const clean = evaluateTwinMarket("R_100", "Clean", noGap(400, 21), opts);
  const hot = evaluateTwinMarket("R_50", "Hot", gapHeavy(400, 22, 0.42), opts);
  assert.equal(clean.recoveryViable, true, clean.reason);
  assert.equal(hot.recoveryViable, false);
  assert.ok(clean.score > hot.score);
  assert.ok(hot.signals.some(s => s.startsWith("WARN") || s.startsWith("INFO")));
});

test("evaluateTwinMarket: a fair uniform market is tradeable (no BLOCKED signal)", () => {
  const opts = { stake: 1, payoutNormal: 1.95, payoutRecovery: 2.43 };
  const fair = evaluateTwinMarket("R_75", "Fair", uniform(400, 41), opts);
  assert.ok(!fair.signals.some(s => s.startsWith("BLOCKED")), JSON.stringify(fair.signals));
  assert.ok(fair.gapHazard <= 0.30, `gap ${fair.gapHazard}`);
});

test("screenAndRankTwin puts viable markets first and flags significance", () => {
  const opts = { stake: 1, payoutNormal: 1.95, payoutRecovery: 2.43 };
  const cands = [
    evaluateTwinMarket("R_50", "Hot", gapHeavy(400, 31, 0.42), opts),
    evaluateTwinMarket("R_100", "Clean", noGap(400, 32), opts),
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