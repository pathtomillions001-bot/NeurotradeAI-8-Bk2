import { test } from "node:test";
import assert from "node:assert";
import {
  evaluateMarket, screenAndRank, lossClustering, stationarityZ,
  conditionalTransitionRate, simulateSession, winSet, lossSet,
  DUAL_LOCK_NORMAL_CONTRACTS, DUAL_LOCK_RECOVERY_CONTRACTS, isDeployable, DUAL_LOCK_MIN_SURVIVAL, DUAL_LOCK_MIN_SCORE,
} from "./dual-lock-analysis";

function rng(seed: number) { let s = seed >>> 0; return () => { s ^= s<<13; s>>>=0; s^=s>>17; s^=s<<5; s>>>=0; return s/4294967296; }; }
function uniform(n: number, seed = 7) { const r = rng(seed); return Array.from({length:n}, () => Math.floor(r()*10)); }
/** Digit stream where LOW digits cluster → losses of Over-1 cluster. */
function clustered(n: number, seed = 11) {
  const r = rng(seed); const out: number[] = []; let low = false;
  for (let i=0;i<n;i++){ low = r() < (low ? 0.75 : 0.12); out.push(low ? Math.floor(r()*2) : 2+Math.floor(r()*8)); }
  return out;
}

test("contract vocabulary is exactly the requested one", () => {
  assert.deepEqual(DUAL_LOCK_NORMAL_CONTRACTS.map(c=>`${c.side}${c.barrier}`),
    ["DIGITOVER1","DIGITUNDER8","DIGITOVER2","DIGITUNDER7"]);
  assert.deepEqual(DUAL_LOCK_RECOVERY_CONTRACTS.map(c=>`${c.side}${c.barrier}`),
    ["DIGITOVER4","DIGITOVER5","DIGITUNDER5","DIGITUNDER4"]);
  assert.deepEqual([...winSet({side:"DIGITOVER",barrier:1})], [2,3,4,5,6,7,8,9]);
  assert.deepEqual([...lossSet({side:"DIGITOVER",barrier:1})], [0,1]);
});

test("loss clustering detects a clustered stream and clears a fair one", () => {
  const fair = uniform(600).map(d => d > 1 ? 1 : 0);
  const clus = clustered(600).map(d => d > 1 ? 1 : 0);
  const f = lossClustering(fair), c = lossClustering(clus);
  assert.ok(f.clusterRatio < 1.15, `fair xi ${f.clusterRatio}`);
  assert.ok(c.clusterRatio > 1.5, `clustered xi ${c.clusterRatio}`);
  assert.ok(c.expectedMaxRun > f.expectedMaxRun);
});

test("stationarity z flags a drifting rate", () => {
  const stable = uniform(400).map(d => d>1?1:0);
  const drift = [...Array(200).fill(1), ...Array(200).fill(0).map((_,i)=> i%3===0?1:0)];
  assert.ok(Math.abs(stationarityZ(stable).z) < 3);
  assert.ok(stationarityZ(drift).z > 3);
});

test("conditional recovery rate uses the post-loss state", () => {
  const d = clustered(800);
  const r = conditionalTransitionRate(d, lossSet({side:"DIGITOVER",barrier:1}), winSet({side:"DIGITUNDER",barrier:5}));
  // after a 0/1 digit, this clustered stream stays low → UNDER 5 should be well above fair 0.5
  assert.ok(r.p > 0.55, `cond ${r.p}`);
  assert.ok(r.n > 20);
});

test("clustered market is rejected, fair market yields candidates", () => {
  const params = { stake:1, takeProfit:10, stopLoss:5, maxRecoverySteps:3, markupPercent:10, maxStake:500 };
  const bad = screenAndRank(evaluateMarket("BAD","Bad", clustered(800), params));
  assert.ok(bad.every(c => !isDeployable(c) || c.clusterRatio <= 1.08), "clustered market must not be deployable on a clustered leg");
  const fair = screenAndRank(evaluateMarket("FAIR","Fair", uniform(800), params));
  assert.ok(fair.length === 16, `expected 16 pairs, got ${fair.length}`);
  assert.ok(fair[0]!.survival >= 0 && fair[0]!.survival <= 1);
});

test("simulation obeys TP/SL and returns a probability", () => {
  const r = simulateSession(uniform(800), {side:"DIGITOVER",barrier:1}, {side:"DIGITUNDER",barrier:5},
    { stake:1, takeProfit:10, stopLoss:5, maxRecoverySteps:3, markupPercent:10, maxStake:500 });
  assert.ok(r.survival + r.ruin <= 1.0001);
  assert.ok(r.survival > 0.2 && r.survival < 1, `survival ${r.survival}`);
});

test("insufficient history yields no candidates", () => {
  assert.equal(evaluateMarket("X","X", uniform(50)).length, 0);
});

test("the survival floor is lifted — survival ranks, it no longer vetoes", () => {
  assert.equal(DUAL_LOCK_MIN_SURVIVAL, 0, "the 90% survival gate must be gone");
  // Nothing else was loosened: the bot must behave exactly as it did before the
  // survival gate existed, and that state had a 58 composite floor.
  assert.equal(DUAL_LOCK_MIN_SCORE, 58, "the composite floor must be unchanged at 58");
  const base = {
    metrics: { blocked: 0 }, score: 95, clusterRatio: 0.98,
  } as any;
  // A low-survival market is now lockable: it will simply rank below a
  // higher-survival one, and the user sees the number on the scan card.
  assert.equal(isDeployable({ ...base, survival: 0.05 }), true, "5% survival must no longer be refused");
  assert.equal(isDeployable({ ...base, survival: 0.50 }), true, "50% survival must be accepted");
  assert.equal(isDeployable({ ...base, survival: 0.95 }), true, "95% must still be accepted");
  // The structural gates still bite.
  assert.equal(isDeployable({ ...base, survival: 0.99, clusterRatio: 1.20 }), false, "clustering must still veto");
  assert.equal(isDeployable({ ...base, survival: 0.99, score: 20 }), false, "a poor structural read must still veto");
  assert.equal(isDeployable({ ...base, survival: 0.99, metrics: { blocked: 1 } }), false, "a blocked candidate must still veto");
});

test("ranking still puts the highest-survival candidate first", () => {
  const mk = (survival: number) => ({
    symbol: "S", displayName: "S", normal: { side: "DIGITOVER", barrier: 1 },
    recovery: { side: "DIGITUNDER", barrier: 5 }, score: 60, survival, ruin: 1 - survival,
    meanPnl: 0, normalLcb: 0.8, normalMean: 0.82, normalBreakEven: 0.81, normalPayout: 1.23,
    recoveryConditional: 0.5, recoveryLcb: 0.5, recoveryBreakEven: 0.51, recoveryPayout: 1.95,
    clusterRatio: 1.0, pTwoInARow: 0.04, expectedMaxLossRun: 2, stationarityZ: 0,
    significant: true, pValue: 0.001, samples: 400, reason: "", signals: [],
    metrics: { blocked: 0 },
  } as any);
  const ranked = screenAndRank([mk(0.35), mk(0.9), mk(0.6)]);
  assert.deepEqual(ranked.map(c => c.survival), [0.9, 0.6, 0.35]);
  // …and every one of them is deployable now.
  assert.ok(ranked.every(c => isDeployable(c)));
});

