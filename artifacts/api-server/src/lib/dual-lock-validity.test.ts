import { test } from "node:test";
import assert from "node:assert";
import {
  driftHorizon, memoryHorizon, dwellHorizon, estimateEdgeValidity,
  EdgeValidityTracker, secondsPerTick,
} from "./dual-lock-validity";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Stationary Bernoulli series at rate p. */
function stationary(n: number, p: number, seed = 3): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => (r() < p ? 1 : 0));
}

/** Series whose rate drifts steadily from pStart to pEnd. */
function drifting(n: number, pStart: number, pEnd: number, seed = 5): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const p = pStart + ((pEnd - pStart) * i) / n;
    return r() < p ? 1 : 0;
  });
}

test("tick cadence distinguishes 1s indices from the classic ones", () => {
  assert.equal(secondsPerTick("1HZ100V"), 1);
  assert.equal(secondsPerTick("R_50"), 2);
});

test("a stationary market shows no measurable drift, a drifting one does", () => {
  const stable = driftHorizon(stationary(800, 0.8), 0.75);
  const drift = driftHorizon(drifting(800, 0.88, 0.68), 0.75);
  assert.ok(drift.sigmaDrift > stable.sigmaDrift,
    `drifting sigma ${drift.sigmaDrift} should exceed stable ${stable.sigmaDrift}`);
  assert.ok(drift.horizonTicks < stable.horizonTicks,
    "a drifting market must have the shorter validity horizon");
});

test("drift horizon shrinks as the margin shrinks", () => {
  const s = drifting(800, 0.88, 0.70);
  const wide = driftHorizon(s, 0.60);
  const tight = driftHorizon(s, 0.78);
  assert.ok(tight.horizonTicks < wide.horizonTicks,
    `tight margin ${tight.horizonTicks} must expire before wide ${wide.horizonTicks}`);
});

test("memory horizon reflects serial dependence", () => {
  // Strongly persistent series: long runs ⇒ high rho ⇒ long memory.
  const r = rng(9);
  const sticky: number[] = [];
  let v = 1;
  for (let i = 0; i < 600; i++) { if (r() < 0.15) v = 1 - v; sticky.push(v); }
  const m = memoryHorizon(sticky);
  assert.ok(m.rho > 0.4, `sticky rho ${m.rho}`);
  assert.ok(Number.isFinite(m.horizonTicks) && m.horizonTicks > 0);

  // Independent series ⇒ no memory to lose ⇒ this horizon must not bind.
  const iid = memoryHorizon(stationary(600, 0.5, 21));
  assert.ok(iid.rho < 0.15, `iid rho ${iid.rho}`);
});

test("CUSUM dwell finds change points in a regime-switching stream, none in a stable one", () => {
  const switching = [...stationary(200, 0.85, 1), ...stationary(200, 0.45, 2),
                     ...stationary(200, 0.85, 3), ...stationary(200, 0.45, 4)];
  const d = dwellHorizon(switching);
  assert.ok(d.changePoints >= 1, `expected change points, got ${d.changePoints}`);
  assert.ok(Number.isFinite(d.horizonTicks));

  const stable = dwellHorizon(stationary(800, 0.8, 31));
  assert.ok(stable.changePoints <= d.changePoints);
});

test("validity forecast is ordered p20 < p50 <= mean and reports a binding factor", () => {
  const v = estimateEdgeValidity(drifting(600, 0.86, 0.72), 0.76, "1HZ100V");
  assert.ok(v.p20Ticks < v.p50Ticks, `p20 ${v.p20Ticks} p50 ${v.p50Ticks}`);
  assert.ok(v.p50Ticks <= v.meanTicks);
  assert.ok(v.p20Seconds > 0 && v.p50Seconds > 0);
  assert.ok(["drift", "memory", "regime-dwell", "unbounded"].includes(v.bindingFactor));
  assert.ok(v.confidence >= 20 && v.confidence <= 95);
  assert.ok(v.summary.includes("re-scan"));
});

test("a drifting market forecasts a shorter validity than a stable one", () => {
  const stable = estimateEdgeValidity(stationary(800, 0.82, 41), 0.74, "R_50");
  const drift = estimateEdgeValidity(drifting(800, 0.90, 0.66, 43), 0.74, "R_50");
  assert.ok(drift.p50Ticks < stable.p50Ticks,
    `drifting ${drift.p50Ticks} should be shorter than stable ${stable.p50Ticks}`);
});

test("tracker stays fresh while the locked rate holds", () => {
  const horizon = estimateEdgeValidity(stationary(800, 0.8, 51), 0.72, "1HZ100V");
  const t = new EdgeValidityTracker(0.8, horizon);
  const r = rng(77);
  for (let i = 0; i < 60; i++) t.recordNormalOutcome(r() < 0.8);
  const s = t.snapshot();
  assert.equal(s.changeDetected, false, "no change should be detected on an on-model stream");
  assert.ok(s.freshness > 55, `freshness ${s.freshness}`);
  assert.ok(["fresh", "aging"].includes(s.state), `state ${s.state}`);
  assert.ok(Math.abs(s.deviationSigma) < 3);
});

test("tracker detects a real collapse of the locked edge", () => {
  const horizon = estimateEdgeValidity(stationary(800, 0.8, 61), 0.72, "1HZ100V");
  const t = new EdgeValidityTracker(0.8, horizon);
  const r = rng(88);
  for (let i = 0; i < 30; i++) t.recordNormalOutcome(r() < 0.8);   // on model
  for (let i = 0; i < 60; i++) t.recordNormalOutcome(r() < 0.45);  // regime break
  const s = t.snapshot();
  assert.ok(s.changeDetected, "Page–Hinkley must fire on a 35-point rate collapse");
  assert.equal(s.state, "expired");
  assert.ok(s.deviationSigma < 0, `deviation ${s.deviationSigma}`);
  assert.ok(s.advice.toLowerCase().includes("re-scan"));
});

test("the tracker is purely advisory — it exposes no stop control", () => {
  const horizon = estimateEdgeValidity(stationary(400, 0.8, 71), 0.72, "R_50");
  const t = new EdgeValidityTracker(0.8, horizon) as unknown as Record<string, unknown>;
  for (const key of ["stop", "halt", "shouldStop", "kill"]) {
    assert.equal(key in t, false, `tracker must not expose a '${key}' control`);
  }
});
