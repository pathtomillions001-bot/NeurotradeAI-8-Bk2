/**
 * Over/Under Turbo — analysis-layer tests.
 *
 * Pins the user-facing contract of the continuous bot:
 *   · the barrier sets are EXACTLY the requested ones (fixed, not configurable);
 *   · the scan returns only those barriers, best-first, and refuses when nothing
 *     is deployable ("wait and rescan" — never deploy into a bad tape);
 *   · the arm-entry gate reads the live window and only arms at/above
 *     break-even (a ONE-SHOT gate — the engine never gates again after arming);
 *   · the market-favorability health flags clustered/adverse tapes (the
 *     switching rescue's only trigger).
 */

import { test } from "node:test";
import assert from "node:assert";
import {
  TURBO_NORMAL_CONTRACTS,
  TURBO_RECOVERY_CONTRACTS,
  armEntryRead,
  turboMarketHealth,
  rankTurboCandidates,
  evaluateTurboPair,
  evaluateMarket,
  isNormalContract,
  isRecoveryContract,
} from "./overunder-turbo-analysis";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function uniform(n: number, seed = 7) {
  const r = rng(seed);
  return Array.from({ length: n }, () => Math.floor(r() * 10));
}
/** Digit stream where LOW digits cluster → losses of Over-1 cluster. */
function clustered(n: number, seed = 11) {
  const r = rng(seed);
  const out: number[] = [];
  let low = false;
  for (let i = 0; i < n; i++) {
    low = r() < (low ? 0.75 : 0.12);
    out.push(low ? Math.floor(r() * 2) : 2 + Math.floor(r() * 8));
  }
  return out;
}
/** Stream with no 0/1 digits at all — Over 1 is hot (~100% recent win rate). */
function hotOver1(n: number, seed = 3) {
  const r = rng(seed);
  return Array.from({ length: n }, () => 2 + Math.floor(r() * 8));
}
/** Stream that is almost all 0/1 — Over 1 is ice cold. */
function coldOver1(n: number, seed = 5) {
  const r = rng(seed);
  return Array.from({ length: n }, () => (r() < 0.9 ? Math.floor(r() * 2) : 2 + Math.floor(r() * 8)));
}

const OVER1 = { side: "DIGITOVER" as const, barrier: 1 };
const SIM = { stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, markupPercent: 10, maxStake: 500 };

test("the fixed barrier vocabulary is exactly the requested one", () => {
  assert.deepEqual(
    TURBO_NORMAL_CONTRACTS.map((c) => `${c.side}${c.barrier}`),
    ["DIGITOVER1", "DIGITUNDER8", "DIGITOVER2", "DIGITUNDER7"],
  );
  assert.deepEqual(
    TURBO_RECOVERY_CONTRACTS.map((c) => `${c.side}${c.barrier}`),
    ["DIGITOVER4", "DIGITOVER5", "DIGITUNDER5", "DIGITUNDER4"],
  );
  for (const n of TURBO_NORMAL_CONTRACTS) assert.ok(isNormalContract(n.side, n.barrier));
  for (const r of TURBO_RECOVERY_CONTRACTS) assert.ok(isRecoveryContract(r.side, r.barrier));
  // Outside the spec → rejected (sovereignty).
  assert.equal(isNormalContract("DIGITOVER", 5), false);
  assert.equal(isRecoveryContract("DIGITUNDER", 8), false);
});

test("arm entry: hot window arms, cold window waits, thin window warms up", () => {
  const hot = armEntryRead(hotOver1(200), OVER1, 40);
  assert.equal(hot.ready, true, `hot rate ${hot.recentRate} should be ≥ BE ${hot.breakEven}`);
  assert.ok(hot.recentRate >= hot.breakEven);

  const cold = armEntryRead(coldOver1(200), OVER1, 40);
  assert.equal(cold.ready, false, `cold rate ${cold.recentRate} should be < BE ${cold.breakEven}`);

  const thin = armEntryRead([1, 0, 2, 9], OVER1, 40);
  assert.equal(thin.ready, false);
  assert.match(thin.reason, /warming/);
});

test("market health: an honest tape is favorable, a clustered tape is not", () => {
  const good = turboMarketHealth("GOOD", "Good", uniform(400, 21), OVER1);
  // A fair synthetic with a house edge may legitimately sit under break-even;
  // the health check must then SAY so rather than wave it through.
  if (good.normalLcb <= good.breakEven) {
    assert.equal(good.favorable, false);
    assert.match(good.reason, /break-even/);
  } else {
    assert.equal(good.favorable, true);
  }

  const bad = turboMarketHealth("BAD", "Bad", clustered(400, 13), OVER1);
  assert.equal(bad.favorable, false, "a loss-clustered tape must be unfavorable");
  assert.ok(
    /cluster/.test(bad.reason) || /break-even/.test(bad.reason),
    `reason should name the blocker, got: ${bad.reason}`,
  );

  const thin = turboMarketHealth("THIN", "Thin", uniform(30, 2), OVER1);
  assert.equal(thin.favorable, false);
  assert.match(thin.reason, /history/);
});

test("scan ranking: only fixed-barrier triples are proposed, best first", () => {
  const candidates = evaluateMarket("FAIR", "Fair", uniform(800, 31), SIM);
  assert.equal(candidates.length, 16, "4 normal × 4 recovery must all be evaluated");
  const result = rankTurboCandidates(candidates, 1);
  assert.ok(result.best, "a uniform stream yields a best triple");
  assert.ok(
    TURBO_NORMAL_CONTRACTS.some(
      (c) => c.side === result.best!.normal.side && c.barrier === result.best!.normal.barrier,
    ),
    "the proposed normal barrier must come from the fixed set",
  );
  assert.ok(
    TURBO_RECOVERY_CONTRACTS.some(
      (c) => c.side === result.best!.recovery.side && c.barrier === result.best!.recovery.barrier,
    ),
    "the proposed recovery barrier must come from the fixed set",
  );
  assert.ok(result.allScored.length >= 1);
});

test("scan ranking: a clustered tape is refused with a named blocker (wait & rescan)", () => {
  const candidates = evaluateMarket("BAD", "Bad", clustered(800, 17), SIM);
  const result = rankTurboCandidates(candidates, 1);
  assert.equal(result.suitable, false, "a clustered tape must not be deployable");
  assert.ok(result.reason.length > 0);
});

test("scan ranking: nothing to score → explicit wait-and-rescan verdict", () => {
  const result = rankTurboCandidates([], 20);
  assert.equal(result.suitable, false);
  assert.equal(result.best, null);
  assert.match(result.reason, /re-scan/i);
  assert.equal(result.marketsScanned, 20);
});

test("evaluateTurboPair: full candidate on real history, null on thin history", () => {
  const c = evaluateTurboPair("FAIR", "Fair", uniform(400, 41), OVER1, { side: "DIGITUNDER", barrier: 5 }, SIM);
  assert.ok(c, "400 digits is enough for a full survival evaluation");
  assert.ok(c!.survival >= 0 && c!.survival <= 1);
  assert.equal(evaluateTurboPair("THIN", "Thin", uniform(60, 42), OVER1, { side: "DIGITUNDER", barrier: 5 }, SIM), null);
});
