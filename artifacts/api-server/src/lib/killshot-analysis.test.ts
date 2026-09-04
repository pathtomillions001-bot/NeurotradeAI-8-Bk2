import { test } from "node:test";
import assert from "node:assert";
import {
  sprt, contextModel, anytimeLowerBound, lossStructure, stationarity, concordance,
  evaluateKillShotCandidate, screenKillShotCandidates, validateKillShotContract,
  killShotWinSet, killShotPayout, killShotBreakEven, killShotLabel,
  KILLSHOT_GATES,
} from "./killshot-analysis";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function uniformDigits(n: number, seed = 7) {
  const r = rng(seed);
  return Array.from({ length: n }, () => Math.floor(r() * 10));
}
/**
 * Digit stream in which `winDigits` occur with probability `p` and every other
 * digit shares the remainder uniformly. This is how a contract is given a real,
 * known edge to find.
 */
function biasedDigits(n: number, seed: number, winDigits: number[], p: number) {
  const r = rng(seed);
  const others = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d => !winDigits.includes(d));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (r() < p) out.push(winDigits[Math.floor(r() * winDigits.length)]!);
    else out.push(others[Math.floor(r() * others.length)]!);
  }
  return out;
}

/** Digit stream biased so that HIGH digits are over-represented. */
function highBiased(n: number, seed = 13, pHigh = 0.90) {
  const r = rng(seed);
  return Array.from({ length: n }, () =>
    r() < pHigh ? 2 + Math.floor(r() * 8) : Math.floor(r() * 2));
}
/**
 * Stream with a HIGH win rate for "Over 1" (~94%) whose few losses nonetheless
 * arrive in pairs. This is the exact adversarial case the bot must refuse:
 * average accuracy looks excellent, but the loss structure would drive the
 * recovery ladder deep.
 */
function pairedLosses(n: number, seed = 17) {
  const r = rng(seed);
  const out: number[] = [];
  let low = false;
  for (let i = 0; i < n; i++) {
    // P(low | low) = 0.50, P(low | high) = 0.03  ⇒  stationary P(low) ≈ 5.7%
    low = r() < (low ? 0.50 : 0.03);
    out.push(low ? Math.floor(r() * 2) : 2 + Math.floor(r() * 8));
  }
  return out;
}

// ── Contract vocabulary ───────────────────────────────────────────────────────

test("exactly one side may be chosen — no 'both' mode exists", () => {
  assert.deepEqual([...killShotWinSet({ kind: "over", digit: 7 })], [8, 9]);
  assert.deepEqual([...killShotWinSet({ kind: "under", digit: 2 })], [0, 1]);
  assert.deepEqual([...killShotWinSet({ kind: "match", digit: 5 })], [5]);
  assert.deepEqual([...killShotWinSet({ kind: "even" })], [0, 2, 4, 6, 8]);
  assert.deepEqual([...killShotWinSet({ kind: "odd" })], [1, 3, 5, 7, 9]);
});

test("validation accepts each single side and rejects impossible ones", () => {
  assert.equal(validateKillShotContract({ kind: "over", digit: 7 }).ok, true);
  assert.equal(validateKillShotContract({ kind: "under", digit: 2 }).ok, true);
  assert.equal(validateKillShotContract({ kind: "even" }).ok, true);
  assert.equal(validateKillShotContract({ kind: "odd" }).ok, true);
  // Matches may delegate the digit to the AI.
  const m = validateKillShotContract({ kind: "match" });
  assert.equal(m.ok, true);
  assert.equal(m.ok && m.contract.digit, undefined);

  assert.equal(validateKillShotContract({ kind: "over", digit: 9 }).ok, false, "Over 9 can never win");
  assert.equal(validateKillShotContract({ kind: "under", digit: 0 }).ok, false, "Under 0 can never win");
  assert.equal(validateKillShotContract({ kind: "both" }).ok, false, "there is no 'both' mode");
  assert.equal(validateKillShotContract({ kind: "over", digit: 12 }).ok, false);
});

test("payout and break-even are consistent", () => {
  for (const c of [
    { kind: "over" as const, digit: 1 },
    { kind: "under" as const, digit: 8 },
    { kind: "match" as const, digit: 3 },
    { kind: "even" as const },
  ]) {
    const p = killShotPayout(c);
    assert.ok(p > 1, `${killShotLabel(c)} payout ${p}`);
    assert.ok(Math.abs(killShotBreakEven(c) - 1 / p) < 1e-9);
  }
});

// ── L1: SPRT ──────────────────────────────────────────────────────────────────

test("SPRT fires on a real edge and abandons a null stream", () => {
  const edge = Array.from({ length: 400 }, (_, i) => (i % 10 < 9 ? 1 : 0)); // 90%
  const fired = sprt(edge, 0.815, 0.87);
  assert.equal(fired.decision, "fire");
  assert.ok(fired.logLR >= fired.upper);
  assert.ok(fired.oddsForEdge > 100, `odds ${fired.oddsForEdge}`);

  const r = rng(101);
  const nullStream = Array.from({ length: 400 }, () => (r() < 0.60 ? 1 : 0));
  const abandoned = sprt(nullStream, 0.815, 0.87);
  assert.equal(abandoned.decision, "abandon");
});

test("SPRT reports progress and an expected time to decision while undecided", () => {
  const r = rng(103);
  const marginal = Array.from({ length: 60 }, () => (r() < 0.83 ? 1 : 0));
  const res = sprt(marginal, 0.815, 0.87);
  if (res.decision === "continue") {
    assert.ok(res.progress < 1);
    assert.ok(res.expectedRemaining > 0);
  }
});

test("the selection surcharge makes firing strictly harder", () => {
  const s = Array.from({ length: 300 }, (_, i) => (i % 10 < 9 ? 1 : 0));
  const plain = sprt(s, 0.815, 0.87, 0.005, 0.10, 0);
  const penalised = sprt(s, 0.815, 0.87, 0.005, 0.10, Math.log(190));
  assert.ok(penalised.upper > plain.upper, "penalty must raise the fire threshold");
});

// ── L2 / L3 ───────────────────────────────────────────────────────────────────

test("context model mixes orders and never returns a degenerate probability", () => {
  const m = contextModel(uniformDigits(600), killShotWinSet({ kind: "over", digit: 1 }));
  assert.ok(m.p > 0 && m.p < 1);
  assert.ok(m.byOrder.length >= 1);
  assert.ok(m.byOrder.every(o => o.weight >= 0 && o.p > 0 && o.p < 1));
  assert.ok(m.dominantOrder >= 0 && m.dominantOrder <= 3);
});

test("anytime-valid lower bound sits below the mean and tightens with data", () => {
  const short = anytimeLowerBound(Array.from({ length: 60 }, (_, i) => (i % 10 < 9 ? 1 : 0)));
  const long = anytimeLowerBound(Array.from({ length: 600 }, (_, i) => (i % 10 < 9 ? 1 : 0)));
  assert.ok(short.lower <= short.mean);
  assert.ok(long.lower <= long.mean);
  assert.ok(long.lower > short.lower, `more data must tighten the bound: ${short.lower} → ${long.lower}`);
  assert.ok(long.lower < 0.9 + 1e-9);
});

// ── L4: the consecutive-loss gate (the user's stated priority) ────────────────

test("loss structure detects paired losses and clears a well-behaved stream", () => {
  const clean = uniformDigits(800).map(d => (d > 1 ? 1 : 0));
  const paired = pairedLosses(800).map(d => (d > 1 ? 1 : 0));
  const c = lossStructure(clean);
  const p = lossStructure(paired);
  assert.ok(p.clusterRatio > c.clusterRatio, `paired ξ ${p.clusterRatio} vs clean ${c.clusterRatio}`);
  // ξ is the scale-free discriminator, and it is what the gate actually uses.
  // Raw P(two in a row) is NOT comparable across these two streams: the paired
  // one loses far less often, so its joint pairing probability is smaller even
  // though its losses are dramatically more clustered. That is precisely why
  // the bot gates on ξ rather than on any raw frequency.
  assert.ok(c.clusterRatio <= 1.0, `well-behaved stream ξ ${c.clusterRatio} should be ≤ 1`);
  assert.ok(p.clusterRatio > 2, `paired stream ξ ${p.clusterRatio} should be far above 1`);
  assert.ok(p.expectedMaxRun > c.expectedMaxRun);
  // The paired stream loses far LESS often, yet its runs are longer relative to
  // its loss count — which is exactly the danger a win-rate-only view misses.
  assert.ok(p.pLoss < c.pLoss, `paired stream should lose less often: ${p.pLoss} vs ${c.pLoss}`);
  assert.ok(p.maxLossRun / p.pLoss > c.maxLossRun / c.pLoss, "runs must be longer per unit of loss rate");
  assert.ok(p.runsZ < c.runsZ, "the paired stream must look less alternating");
  // The headline point: a win-rate-only view would PREFER the paired stream.
  assert.ok(1 - p.pLoss > 1 - c.pLoss, "the dangerous stream has the better win rate");
});

test("a market that pairs its losses is refused even with a high win rate", () => {
  // pairedLosses wins ~94% of Over-1 trades, but pairs the losses.
  const digits = pairedLosses(900);
  const cand = evaluateKillShotCandidate("PAIRED", "Paired", digits, { kind: "over", digit: 1 });
  assert.ok(cand, "candidate should be scored");
  const winRate = digits.filter(d => d > 1).length / digits.length;
  assert.ok(winRate > 0.90, `sanity: the win rate must genuinely look excellent, got ${winRate}`);
  assert.equal(cand!.deployable, false, "paired losses must veto regardless of win rate");
  assert.ok(
    cand!.blockers.some(b => b.includes("cluster") || b.includes("losses in a row")),
    `expected a loss-pairing blocker, got: ${cand!.blockers.join(" | ")}`,
  );
});

// ── L5 / L6 ───────────────────────────────────────────────────────────────────

test("stationarity flags drift via both the chi-square z and the trend slope", () => {
  const stable = uniformDigits(600).map(d => (d > 1 ? 1 : 0));
  const drift = [...Array(300).fill(1), ...Array(300).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0))];
  const s = stationarity(stable);
  const d = stationarity(drift);
  assert.ok(Math.abs(s.z) < 3, `stable z ${s.z}`);
  assert.ok(d.z > 3, `drifting z ${d.z}`);
  assert.ok(Math.abs(d.trend) > Math.abs(s.trend));
});

test("concordance requires the edge to appear across horizons", () => {
  const c = concordance(highBiased(600), killShotWinSet({ kind: "over", digit: 1 }), 0.815, 0.02);
  assert.ok(c.total >= 3);
  assert.ok(c.rates.every(r => r.p >= 0 && r.p <= 1));
  assert.ok(c.spread >= 0);
});

// ── Full candidate + screening ────────────────────────────────────────────────

test("thin history is refused outright", () => {
  assert.equal(evaluateKillShotCandidate("X", "X", uniformDigits(80), { kind: "over", digit: 1 }), null);
  assert.ok(KILLSHOT_GATES.minSamples >= 200, "the sample floor must stay high");
});

test("a fair market yields no deployable kill shot", () => {
  // A uniform digit stream is exactly break-even by construction; a bot whose
  // promise is 'no margin for error' must refuse it.
  const cand = evaluateKillShotCandidate("FAIR", "Fair", uniformDigits(900), { kind: "over", digit: 1 });
  assert.ok(cand);
  assert.equal(cand!.deployable, false, "a fair market must never produce a kill shot");
  assert.ok(cand!.blockers.length > 0);
});

test("every candidate reports the full evidence stack", () => {
  const cand = evaluateKillShotCandidate("V", "V", highBiased(900), { kind: "over", digit: 1 });
  assert.ok(cand);
  assert.ok(cand!.sprt && cand!.context && cand!.loss && cand!.stationarity && cand!.concordance);
  assert.ok(cand!.signals.length >= 7, "all seven layers must be surfaced");
  assert.ok(cand!.confidence >= 0 && cand!.confidence <= 100);
  assert.ok(cand!.pLower <= cand!.pWin, "the valid floor must not exceed the point estimate");
});

test("BH screening is a hard requirement for deployability", () => {
  const cands = [
    evaluateKillShotCandidate("A", "A", highBiased(900, 1), { kind: "over", digit: 1 }),
    evaluateKillShotCandidate("B", "B", uniformDigits(900, 2), { kind: "over", digit: 1 }),
    evaluateKillShotCandidate("C", "C", uniformDigits(900, 3), { kind: "over", digit: 1 }),
  ].filter(Boolean) as NonNullable<ReturnType<typeof evaluateKillShotCandidate>>[];
  const screened = screenKillShotCandidates(cands);
  assert.equal(screened.length, cands.length);
  // Deployable candidates must be sorted first and must have passed FDR.
  for (const c of screened) {
    if (c.deployable) assert.equal(c.significant, true, "a deployable shot must pass FDR");
  }
  for (let i = 1; i < screened.length; i++) {
    if (screened[i]!.deployable) assert.equal(screened[i - 1]!.deployable, true, "deployables sort first");
  }
});

test("gate constants keep the bot selective without making it unable to fire", () => {
  // Type-I error may be looser than the original 0.5% — the multiple-comparison
  // risk in hunt mode is carried by the BH screen and the selection surcharge —
  // but it must stay at or below 5%.
  assert.ok(KILLSHOT_GATES.alpha <= 0.05, `alpha ${KILLSHOT_GATES.alpha}`);
  assert.ok(KILLSHOT_GATES.maxClusterRatio <= 1.0, "losses must never be allowed to attract losses");
  assert.ok(KILLSHOT_GATES.minConfidence >= 60, `minConfidence ${KILLSHOT_GATES.minConfidence}`);
  assert.ok(KILLSHOT_GATES.minAgreeingHorizons >= 2, "the edge must appear in at least two horizons");
  // The alternative H₁ must be stated in absolute points and stay small: a
  // relative δ made H₁ unreachable on high-probability contracts.
  assert.ok(KILLSHOT_GATES.deltaAbs > 0 && KILLSHOT_GATES.deltaAbs <= 0.03);
});

test("every Deriv digit contract is structurally −EV on an unbiased stream, and says so", () => {
  // This is the fact the old refusal message hid. Each contract pays below its
  // fair rate, so an unbiased stream is always slightly −EV and the market must
  // be measurably hot before ANY analysis can call the contract +EV.
  const contracts = [
    { kind: "over" as const, digit: 0 },
    { kind: "over" as const, digit: 4 },
    { kind: "over" as const, digit: 8 },
    { kind: "under" as const, digit: 5 },
    { kind: "match" as const, digit: 5 },
    { kind: "even" as const },
    { kind: "odd" as const },
  ];
  for (const c of contracts) {
    const cand = evaluateKillShotCandidate("S", "S", uniformDigits(1200, 5), c);
    assert.ok(cand, `${killShotLabel(c)} should be scored`);
    assert.equal(cand!.fairRate, killShotWinSet(c).size / 10);
    assert.ok(cand!.headroomPP < 0, `${killShotLabel(c)} must report negative headroom`);
    assert.ok(cand!.requiredRate > cand!.breakEven, "H₁ must sit above break-even");
    assert.equal(cand!.deployable, false, `${killShotLabel(c)} must not fire on a fair stream`);
    // Every candidate must surface the structural fact, whatever else blocked
    // it — the old refusal message said "re-scan in a few minutes", which was
    // wrong advice for a block that is arithmetic, not transient.
    assert.ok(
      cand!.signals.some(sig => sig.includes("structural headroom")),
      `${killShotLabel(c)} must report its headroom: ${cand!.signals.join(" | ")}`,
    );
  }
});

test("a genuinely biased market IS deployable — for every contract family", () => {
  // The regression this whole recalibration exists for. The previous gates
  // refused all of these: the SPRT alternative was unreachable, the flat 2%
  // ceiling on P(two losses in a row) is unsatisfiable below an ~86% win rate,
  // and the loss-pairing veto tripped on sampling noise.
  const cases: Array<[string, number[], Parameters<typeof evaluateKillShotCandidate>[3]]> = [
    ["Over 4 at 58%",  biasedDigits(1200, 22, [5, 6, 7, 8, 9], 0.58), { kind: "over", digit: 4 }],
    ["Over 4 at 65%",  biasedDigits(1200, 23, [5, 6, 7, 8, 9], 0.65), { kind: "over", digit: 4 }],
    ["Over 7 at 27%",  biasedDigits(1200, 24, [8, 9], 0.27),          { kind: "over", digit: 7 }],
    ["Matches 5 at 14%", biasedDigits(1200, 25, [5], 0.14),           { kind: "match", digit: 5 }],
    ["Even at 57%",    biasedDigits(1200, 26, [0, 2, 4, 6, 8], 0.57), { kind: "even" }],
    ["Over 1 at 90%",  biasedDigits(1200, 21, [2, 3, 4, 5, 6, 7, 8, 9], 0.90), { kind: "over", digit: 1 }],
  ];
  for (const [name, digits, contract] of cases) {
    const cand = evaluateKillShotCandidate("HOT", name, digits, contract);
    assert.ok(cand, `${name} should be scored`);
    assert.equal(cand!.sprt.decision, "fire", `${name}: the sequential test must fire`);
    assert.ok(cand!.expectedValue > 0, `${name}: EV must be positive, got ${cand!.expectedValue}`);
    assert.ok(cand!.tier !== "marginal", `${name}: tier ${cand!.tier}`);
    assert.equal(cand!.deployable, true, `${name}: ${cand!.blockers.join(" | ") || `conf ${cand!.confidence}`}`);
    assert.equal(cand!.blockers.length, 0, `${name} must be clean: ${cand!.blockers.join(" | ")}`);
  }
});

test("the loss-pairing veto uses a confidence bound, so noise cannot refuse a clean stream", () => {
  // ξ wanders either side of 1.0 on an independent stream purely from sampling
  // noise. Gating on the point estimate vetoed clean markets roughly half the
  // time; gating on the one-sided lower bound only vetoes DEMONSTRATED clustering.
  const paired = pairedLosses(1200).map(d => (d > 1 ? 1 : 0));
  const clean = biasedDigits(1200, 24, [8, 9], 0.27).map(d => (d > 7 ? 1 : 0));
  const p = lossStructure(paired);
  const c = lossStructure(clean);

  assert.ok(p.clusterRatioLower > 1, `genuinely paired losses must stay vetoed: bound ${p.clusterRatioLower}`);
  assert.ok(p.clusterRatioLower < p.clusterRatio, "the bound must sit below the estimate");
  assert.ok(c.clusterRatioLower <= c.clusterRatio, "the bound must sit below the estimate");
  assert.ok(c.clusterRatioLower < 1, `a clean stream must clear the bound, got ${c.clusterRatioLower}`);
});
