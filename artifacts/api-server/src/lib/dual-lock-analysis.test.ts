import { test } from "node:test";
import assert from "node:assert";
import {
  evaluateMarket, screenAndRank, lossClustering, stationarityZ,
  conditionalTransitionRate, simulateSession, winSet, lossSet,
  DUAL_LOCK_NORMAL_CONTRACTS, DUAL_LOCK_RECOVERY_CONTRACTS, isDeployable, DUAL_LOCK_MIN_SURVIVAL,
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

test("the 90% survival bar is enforced — nothing at or below 90% may be locked", () => {
  assert.ok(DUAL_LOCK_MIN_SURVIVAL > 0.9, `bar ${DUAL_LOCK_MIN_SURVIVAL} must exceed 0.90`);
  const base = {
    metrics: { blocked: 0 }, score: 95, clusterRatio: 0.98,
  } as any;
  assert.equal(isDeployable({ ...base, survival: 0.90 }), false, "exactly 90% must be refused");
  assert.equal(isDeployable({ ...base, survival: 0.899 }), false, "89.9% must be refused");
  assert.equal(isDeployable({ ...base, survival: 0.95 }), true, "95% must be accepted");
});

test("every scored candidate carries an edge-validity forecast", () => {
  const params = { stake:1, takeProfit:10, stopLoss:5, maxRecoverySteps:3, markupPercent:10, maxStake:500 };
  const scored = evaluateMarket("FAIR","Fair", uniform(800), params);
  const withValidity = scored.filter(c => c.validity);
  assert.ok(withValidity.length > 0, "candidates should report a validity horizon");
  for (const c of withValidity) {
    assert.ok(c.validity!.p20Ticks > 0);
    assert.ok(c.validity!.p20Ticks < c.validity!.p50Ticks);
    assert.ok(c.signals.some(s => s.includes("edge validity")), "validity must be surfaced in signals");
  }
});
