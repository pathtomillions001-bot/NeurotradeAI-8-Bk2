/**
 * Kill-Shot Oracle — analysis tests.
 *
 * The bot's entire claim is "the number you are shown was measured on data the
 * model never saw." That claim is worth nothing unless it is mechanically true,
 * so the centrepiece here is the NO-LOOK-AHEAD test: the live entry decision is
 * recomputed from a truncated prefix of the digit stream and must reproduce, to
 * the digit, the decision the walk-forward ledger recorded at that tick. If any
 * future information ever leaks into a feature, that test fails.
 *
 * The rest of the file guards the properties the previous Bot 7 got wrong:
 *   · the scan must PRODUCE SHOTS on ordinary random data (the "found nothing"
 *     bug) — selectivity is a quantile of the model's own distribution, so a
 *     rule that fires 2× in 180 ticks can no longer happen;
 *   · a fair market must NOT be certified (the opposite failure);
 *   · the sequential evidence must be a genuine e-value under the null;
 *   · the ladder arithmetic must match the shared recovery formula;
 *   · the contract vocabulary must never admit both sides of a pair.
 */

import { test } from "node:test";
import assert from "node:assert";
import {
  ShotEnsemble, shotWinSet, shotPayout, shotBreakEven, shotLabel, validateShotContract,
  KILLSHOT_CONTRACT_TYPE, wilsonLower, detectability, certaintySpec, KILLSHOT_CERTAINTY,
  fitPlatt, fitRegimeHmm, lossChain, ladderDepthLimit, ladderAbsorption, expectedShotsToLadderBreak,
  evidenceValue, stationarity, pageHinkley, concordance, walkForward, evaluateLiveEntry,
  evaluateCandidate, screenCandidates, effectiveSampleSize, MIN_HISTORY, SCAN_WINDOW,
  type ShotContract, type ModelCard,
} from "./killshot-analysis";

// ── deterministic generators ──────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** A fair, memoryless digit stream — the null world. */
function uniform(n: number, seed = 7): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => Math.floor(r() * 10));
}

/**
 * A stream with REAL conditional structure: after two consecutive low digits
 * the next digit is strongly biased high. Marginally it is close to fair, so
 * only a model that conditions on context can see the edge — exactly the thing
 * the bot claims to do.
 */
function conditional(n: number, seed = 3, strength = 0.82): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = out[i - 1] ?? 9;
    const b = out[i - 2] ?? 9;
    const primed = a <= 2 && b <= 2;
    if (primed && r() < strength) out.push(5 + Math.floor(r() * 5));
    else out.push(Math.floor(r() * 10));
  }
  return out;
}

/** A stream whose LOW digits arrive in bursts → Over-1 losses cluster. */
function clustered(n: number, seed = 11): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let low = false;
  for (let i = 0; i < n; i++) {
    low = r() < (low ? 0.72 : 0.1);
    out.push(low ? Math.floor(r() * 2) : 2 + Math.floor(r() * 8));
  }
  return out;
}

const RISK = { baseStake: 1, markupPercent: 10, maxStake: 500, stopLoss: 5 };

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT VOCABULARY — one side, never both
// ═══════════════════════════════════════════════════════════════════════════

test("contract vocabulary covers exactly the five one-sided choices", () => {
  assert.deepEqual(Object.keys(KILLSHOT_CONTRACT_TYPE).sort(),
    ["even", "match", "odd", "over", "under"]);
  assert.equal(KILLSHOT_CONTRACT_TYPE.over, "DIGITOVER");
  assert.equal(KILLSHOT_CONTRACT_TYPE.under, "DIGITUNDER");
  assert.equal(KILLSHOT_CONTRACT_TYPE.match, "DIGITMATCH");
  assert.equal(KILLSHOT_CONTRACT_TYPE.even, "DIGITEVEN");
  assert.equal(KILLSHOT_CONTRACT_TYPE.odd, "DIGITODD");
});

test("win sets are disjoint between the two sides of every pair", () => {
  const over = shotWinSet({ kind: "over", digit: 4 });
  const under = shotWinSet({ kind: "under", digit: 5 });
  // Over 4 = {5..9}, Under 5 = {0..4} — no digit can be in both. A session that
  // held both sides would be a guaranteed net loss on the spread.
  assert.deepEqual([...over], [5, 6, 7, 8, 9]);
  assert.deepEqual([...under], [0, 1, 2, 3, 4]);
  assert.equal([...over].filter(d => under.has(d)).length, 0);

  const even = shotWinSet({ kind: "even" });
  const odd = shotWinSet({ kind: "odd" });
  assert.deepEqual([...even].sort((a, b) => a - b), [0, 2, 4, 6, 8]);
  assert.deepEqual([...odd].sort((a, b) => a - b), [1, 3, 5, 7, 9]);
  assert.equal([...even].filter(d => odd.has(d)).length, 0);

  assert.deepEqual([...shotWinSet({ kind: "match", digit: 3 })], [3]);
});

test("impossible and malformed contracts are rejected at the door", () => {
  assert.equal(validateShotContract({ kind: "over", digit: 9 }).ok, false);   // can never win
  assert.equal(validateShotContract({ kind: "under", digit: 0 }).ok, false);  // can never win
  assert.equal(validateShotContract({ kind: "over" }).ok, false);             // needs a digit
  assert.equal(validateShotContract({ kind: "sideways" }).ok, false);
  assert.equal(validateShotContract(null).ok, false);
  assert.equal(validateShotContract({ kind: "over", digit: 2.5 }).ok, false);

  assert.equal(validateShotContract({ kind: "over", digit: 8 }).ok, true);
  assert.equal(validateShotContract({ kind: "under", digit: 1 }).ok, true);
  assert.equal(validateShotContract({ kind: "even" }).ok, true);
  // Matches with no digit is legal — the AI resolves it during the scan.
  const m = validateShotContract({ kind: "match" });
  assert.equal(m.ok, true);
  if (m.ok) assert.equal(m.contract.digit, undefined);
});

test("payouts and break-evens follow the live payout table", () => {
  assert.ok(Math.abs(shotPayout({ kind: "over", digit: 0 }) - 1.09) < 1e-9);
  assert.ok(Math.abs(shotPayout({ kind: "under", digit: 9 }) - 1.09) < 1e-9);
  assert.ok(Math.abs(shotPayout({ kind: "even" }) - 1.95) < 1e-9);
  assert.ok(Math.abs(shotPayout({ kind: "match", digit: 4 }) - 8.93) < 1e-9);
  // Break-even is 1/payout, and for every digit contract it sits ABOVE the fair
  // rate. That gap is the whole reason conditional structure is mandatory.
  for (const c of [
    { kind: "over", digit: 0 }, { kind: "over", digit: 4 }, { kind: "under", digit: 1 },
    { kind: "even" }, { kind: "match", digit: 7 },
  ] as ShotContract[]) {
    const be = shotBreakEven(c);
    const fair = shotWinSet(c).size / 10;
    assert.ok(be > fair, `${shotLabel(c)}: break-even ${be} must exceed fair ${fair}`);
    assert.ok(Math.abs(be - 1 / shotPayout(c)) < 1e-9);
  }
});

test("detectability ranks Over 0 as the easiest and Even as the hardest", () => {
  const o0 = detectability({ kind: "over", digit: 0 });
  const o4 = detectability({ kind: "over", digit: 4 });
  const even = detectability({ kind: "even" });
  assert.ok(o0.snrPerShot > o4.snrPerShot);
  assert.ok(o0.snrPerShot > even.snrPerShot);
  assert.ok(o0.shotsToCertify < even.shotsToCertify);
  // Every contract needs a finite, quotable number of shots.
  for (const d of [o0, o4, even]) {
    assert.ok(Number.isFinite(d.shotsToCertify) && d.shotsToCertify > 0);
    assert.ok(d.hurdlePP > 0);
    assert.ok(d.note.length > 0);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICAL PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════

test("Wilson lower bound is conservative, bounded and monotone in n", () => {
  assert.equal(wilsonLower(0, 0), 0);
  const small = wilsonLower(8, 10);
  const large = wilsonLower(800, 1000);
  assert.ok(small < 0.8 && small > 0);
  assert.ok(large < 0.8 && large > small, "more evidence must tighten the bound");
  assert.ok(wilsonLower(10, 10) <= 1);
});

test("effective sample size discounts an autocorrelated series", () => {
  const iid = uniform(600).map(d => (d > 4 ? 1 : 0));
  const sticky: number[] = [];
  const r = rng(5);
  let v = 1;
  for (let i = 0; i < 600; i++) { if (r() < 0.15) v = 1 - v; sticky.push(v); }
  assert.ok(effectiveSampleSize(iid) > effectiveSampleSize(sticky));
  assert.ok(effectiveSampleSize(sticky) < sticky.length);
});

test("loss chain separates a clustered stream from a fair one", () => {
  const fair = uniform(1500).map(d => (d > 1 ? 1 : 0));
  const clus = clustered(1500).map(d => (d > 1 ? 1 : 0));
  const f = lossChain(fair);
  const c = lossChain(clus);
  assert.ok(f.xi < 1.3, `fair xi ${f.xi}`);
  assert.ok(c.xi > 1.6, `clustered xi ${c.xi}`);
  assert.ok(c.pTwoInARow > f.pTwoInARow);
  assert.ok(c.maxLossRun >= f.maxLossRun);
});

test("Page–Hinkley fires on a regime break and stays quiet on a stable stream", () => {
  const stable = uniform(900).map(d => (d > 1 ? 1 : 0));
  const broken = [
    ...uniform(500, 21).map(d => (d > 1 ? 1 : 0)),
    ...uniform(500, 22).map(d => (d > 6 ? 1 : 0)),
  ];
  assert.equal(pageHinkley(stable).fired, false);
  assert.equal(pageHinkley(broken).fired, true);
});

test("stationarity z detects a drifting rate", () => {
  const stable = uniform(1200).map(d => (d > 1 ? 1 : 0));
  const drift = Array.from({ length: 1200 }, (_, i) => (Math.random() < 0.5 + i / 4000 ? 1 : 0));
  assert.ok(Math.abs(stationarity(stable).z) < 3.5);
  assert.ok(Math.abs(stationarity(drift).z) > 1.5);
});

test("concordance reports every horizon it could measure", () => {
  const digits = uniform(1500);
  const c = concordance(digits, shotWinSet({ kind: "over", digit: 1 }), 0.83);
  assert.ok(c.rates.length > 0);
  assert.equal(c.total, c.rates.length);
  assert.ok(c.agreeing >= 0 && c.agreeing <= c.total);
  assert.ok(c.spread >= 0);
  // A fair stream sits at 80% for Over 1 and must not agree with an 83% bar.
  assert.ok(c.agreeing < c.total);
});

test("e-value behaves like an e-value: bounded under the null, explosive under a real edge", () => {
  // Under the null the optional-stopping guarantee is P(sup E ≥ 1/α) ≤ α, so a
  // fair stream must not manufacture large evidence.
  const nullShots = uniform(2000, 41).map(d => (d > 1 ? 1 : 0));
  const nullE = evidenceValue(nullShots, 0.8);
  assert.ok(nullE.peak < 20, `null peak e-value ${nullE.peak} should stay small`);

  const edged = Array.from({ length: 2000 }, (_, i) => ((i * 2654435761) % 100 < 92 ? 1 : 0));
  const realE = evidenceValue(edged, 0.8);
  assert.ok(realE.e > 1e3, `real edge should accumulate evidence, got ${realE.e}`);
  assert.ok(realE.pValue < 0.01);
});

test("Platt calibration improves on the raw score and never reports fake skill", () => {
  const r = rng(17);
  const scores: number[] = [];
  const outcomes: number[] = [];
  for (let i = 0; i < 800; i++) {
    const p = 0.3 + 0.4 * r();
    scores.push(p);
    outcomes.push(r() < p * 0.9 + 0.05 ? 1 : 0);
  }
  const fitted = fitPlatt(scores, outcomes);
  assert.equal(fitted.n, 800);
  assert.ok(Number.isFinite(fitted.a) && Number.isFinite(fitted.b));
  // Pure noise must not be rewarded with skill.
  const noise = fitPlatt(Array.from({ length: 400 }, () => r()), Array.from({ length: 400 }, () => (r() < 0.5 ? 1 : 0)));
  assert.ok(noise.brierSkill < 0.05, `noise brier skill ${noise.brierSkill}`);
});

test("regime HMM separates hot and cold states on a two-regime stream", () => {
  const hotCold = [
    ...Array.from({ length: 400 }, (_, i) => (i % 10 < 9 ? 1 : 0)),
    ...Array.from({ length: 400 }, (_, i) => (i % 10 < 5 ? 1 : 0)),
  ];
  const hmm = fitRegimeHmm(hotCold);
  assert.ok(hmm.pHot > hmm.pCold, `${hmm.pHot} should exceed ${hmm.pCold}`);
  assert.ok(hmm.stay > 0.5 && hmm.stay < 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// LADDER — must mirror the shared recovery formula
// ═══════════════════════════════════════════════════════════════════════════

test("ladder depth follows debt(k) = stake·(1+a)^(k−1) with a = (1+markup)/(payout−1)", () => {
  const payout = 1.95;
  const d = ladderDepthLimit({ baseStake: 1, payout, markupPercent: 10, maxStake: 500, stopLoss: 5 });
  const a = 1.1 / (payout - 1);
  assert.ok(Math.abs(d.growthFactor - a) < 1e-4, `growth factor ${d.growthFactor} ≠ a ${a}`);
  // debt(limit) = stake·(1+a)^(limit−1), and it must not have passed the stop loss.
  assert.ok(Math.abs(d.debtAtLimit - Math.pow(1 + a, d.limit - 1)) < 0.02);
  assert.ok(d.debtAtLimit <= 5 + 1e-9 || d.limit === 1);
  assert.ok(d.limit >= 1);
  assert.equal(d.limit, Math.min(d.byStakeCap, d.byStopLoss));
  // A bigger stop loss and a bigger cap can only buy more depth, never less.
  const deeper = ladderDepthLimit({ baseStake: 1, payout, markupPercent: 10, maxStake: 5000, stopLoss: 500 });
  assert.ok(deeper.limit >= d.limit);
  // A high-payout contract recovers in fewer steps, so the ladder goes deeper.
  const rich = ladderDepthLimit({ baseStake: 1, payout: 8.93, markupPercent: 10, maxStake: 500, stopLoss: 5 });
  assert.ok(rich.limit >= d.limit);
});

test("ladder break probability rises with clustering and falls with depth", () => {
  const p = 0.12;
  const indep = ladderAbsorption(p, p, 3, 200);
  const sticky = ladderAbsorption(p, 0.4, 3, 200);
  const deeper = ladderAbsorption(p, p, 5, 200);
  assert.ok(sticky > indep, `clustered losses must be more dangerous: ${sticky} vs ${indep}`);
  assert.ok(deeper < indep, `a deeper ladder must be safer: ${deeper} vs ${indep}`);
  for (const v of [indep, sticky, deeper]) assert.ok(v >= 0 && v <= 1);
  // More shots taken = more chances to hit the run. Safety is not a constant.
  assert.ok(ladderAbsorption(p, p, 3, 1000) > indep);
  assert.ok(expectedShotsToLadderBreak(p, p, 3) > expectedShotsToLadderBreak(p, 0.5, 3));
});

// ═══════════════════════════════════════════════════════════════════════════
// NO LOOK-AHEAD — the load-bearing test
// ═══════════════════════════════════════════════════════════════════════════

test("the live rule is causal: replaying a prefix reproduces the recorded shot exactly", () => {
  const digits = conditional(2400, 3);
  const contract: ShotContract = { kind: "over", digit: 4 };
  const winSet = shotWinSet(contract);
  const spec = certaintySpec("balanced");
  const walk = walkForward(digits, winSet, {
    breakEven: shotBreakEven(contract), payout: shotPayout(contract), spec, ...RISK,
  });

  assert.ok(walk.test.nShots > 0, "the measured rule must actually fire out of sample");

  const card: ModelCard = {
    tau: walk.tau,
    platt: walk.platt,
    hmm: walk.hmm,
    breakEven: shotBreakEven(contract),
    payout: shotPayout(contract),
    targetShotRate: spec.targetShotRate,
    minSpacing: spec.minSpacing,
    postLossTightening: spec.postLossTightening,
    postLossCoolTicks: spec.postLossCoolTicks,
    fittedOn: walk.trainTicks,
  };

  // Take shots spread across the out-of-sample half and re-derive each decision
  // from ONLY the digits that existed at that moment. Any leak — a future tick
  // in a feature, a threshold fitted on the test half — breaks this.
  const sample = walk.test.shots.filter((_, i) => i % Math.max(1, Math.floor(walk.test.shots.length / 6)) === 0).slice(0, 6);
  assert.ok(sample.length > 0);

  for (const shot of sample) {
    const prefix = digits.slice(0, shot.index + 1);
    const live = evaluateLiveEntry(prefix, winSet, card, { barBoost: 0, ticksSinceLoss: Number.POSITIVE_INFINITY });
    assert.ok(Math.abs(live.z - shot.zGate) < 1e-9,
      `tick ${shot.index}: replayed decision statistic ${live.z} ≠ recorded ${shot.zGate}`);
    assert.ok(Math.abs(live.edgeZ - shot.z) < 1e-9,
      `tick ${shot.index}: replayed edge z ${live.edgeZ} ≠ recorded ${shot.z}`);
    assert.ok(Math.abs(live.p - shot.p) < 1e-9,
      `tick ${shot.index}: replayed p ${live.p} ≠ recorded ${shot.p}`);
    assert.equal(live.leader, shot.leader);
    assert.equal(live.contextOrder, shot.contextOrder);
    assert.equal(live.ready, true, `tick ${shot.index}: the recorded shot must still clear the bar`);
    // The outcome is the tick being predicted — the model observes it only after
    // the decision has been recorded.
    assert.equal(shot.won, winSet.has(digits[shot.index]!));
  }
});

test("the ensemble never consumes the tick it is predicting", () => {
  const digits = conditional(1200, 9);
  const winSet = shotWinSet({ kind: "over", digit: 4 });
  const ens = new ShotEnsemble(winSet, shotBreakEven({ kind: "over", digit: 4 }), fitRegimeHmm([]));
  for (let i = 0; i < 600; i++) ens.observe(digits[i]!);
  const before = ens.predict();
  const again = ens.predict();
  assert.ok(Math.abs(before.p - again.p) < 1e-12, "predict() must be side-effect free");
  assert.ok(Math.abs(before.zRel - again.zRel) < 1e-12);
  assert.ok(Math.abs(before.zGate - again.zGate) < 1e-12);
  ens.observe(digits[600]!);
  const after = ens.predict();
  assert.ok(Number.isFinite(after.p));
});

// ═══════════════════════════════════════════════════════════════════════════
// WALK-FORWARD BEHAVIOUR — the bug the user reported
// ═══════════════════════════════════════════════════════════════════════════

test("the entry rule FIRES on ordinary data — the 'found nothing' bug cannot recur", () => {
  // The old bot's rule fired 2× in 180 ticks and demanded 24. Because tau is now
  // a QUANTILE of the model's own edge distribution, the realised shot rate must
  // land near the target rate on any stream, fair or not.
  for (const [name, digits] of [["fair", uniform(3000, 77)], ["structured", conditional(3000, 5)]] as const) {
    for (const certainty of ["elite", "strict", "balanced"] as const) {
      const spec = certaintySpec(certainty);
      const contract: ShotContract = { kind: "over", digit: 1 };
      const walk = walkForward(digits, shotWinSet(contract), {
        breakEven: shotBreakEven(contract), payout: shotPayout(contract), spec, ...RISK,
      });
      assert.ok(walk.test.nShots > 0,
        `${name}/${certainty}: rule produced no out-of-sample shots at all`);
      // Enough shots to actually judge the market — the old bot demanded 24 and
      // delivered 2. The floor inside walkForward makes that impossible now.
      assert.ok(walk.test.nShots >= spec.minShots * 0.5,
        `${name}/${certainty}: only ${walk.test.nShots} shots for a ${spec.minShots}-shot bar`);
      const rate = walk.test.fireRate;
      assert.ok(rate < Math.max(spec.targetShotRate, 0.02) * 4,
        `${name}/${certainty}: shot rate ${rate} is far looser than the ${spec.targetShotRate} target`);
    }
  }
});

test("selectivity matches each bar's design rate, and the loosest bar fires most", () => {
  // Elite is not simply "fires least". Its bar is the stricter of two things —
  // the target quantile AND the floor that guarantees enough shots to reach its
  // own 26-shot evidence requirement — so when the floor binds, Elite fires a
  // little more often than Strict and pays for it with a far higher proof bar.
  // That is the deliberate trade: an unreachable specification is not rigour.
  const digits = conditional(3000, 13);
  const contract: ShotContract = { kind: "over", digit: 2 };
  const measured = (["elite", "strict", "balanced"] as const).map(c => {
    const spec = certaintySpec(c);
    const walk = walkForward(digits, shotWinSet(contract), {
      breakEven: shotBreakEven(contract), payout: shotPayout(contract), spec, ...RISK,
    });
    const designRate = Math.max(spec.targetShotRate, (spec.minShots * 1.6) / Math.max(1, walk.trainTicks));
    return { c, spec, walk, designRate };
  });

  for (const m of measured) {
    assert.ok(m.walk.test.fireRate <= m.designRate * 2.5,
      `${m.c}: fired ${m.walk.test.fireRate} against a design rate of ${m.designRate}`);
    assert.ok(m.walk.test.nShots >= m.spec.minShots * 0.5,
      `${m.c}: ${m.walk.test.nShots} shots is not enough to judge a ${m.spec.minShots}-shot bar`);
  }
  const [elite, strict, balanced] = measured;
  assert.ok(balanced!.walk.test.fireRate >= elite!.walk.test.fireRate,
    "the loosest bar must not be the most selective");
  assert.ok(balanced!.walk.test.fireRate >= strict!.walk.test.fireRate);
  // Whatever the rates, the PROOF required is strictly ordered.
  assert.ok(elite!.spec.accuracyMargin > strict!.spec.accuracyMargin);
  assert.ok(elite!.spec.minEvidenceE > strict!.spec.minEvidenceE);
});

test("the tau threshold is fitted on the train half only", () => {
  // Two series that share an identical training half but differ completely in
  // their test half must produce an IDENTICAL threshold and calibration. If any
  // part of the fit could see the test data, these two would diverge.
  // (The head is longer than the train half so the split lands inside it.)
  const head = conditional(3000, 31);
  const tailA = uniform(1000, 61);
  const tailB = uniform(1000, 62);
  const contract: ShotContract = { kind: "over", digit: 3 };
  const spec = certaintySpec("strict");
  const args = { breakEven: shotBreakEven(contract), payout: shotPayout(contract), spec, ...RISK };
  const a = walkForward([...head, ...tailA], shotWinSet(contract), args);
  const b = walkForward([...head, ...tailB], shotWinSet(contract), args);
  assert.ok(Math.abs(a.tau - b.tau) < 1e-9, `tau leaked from the test half: ${a.tau} vs ${b.tau}`);
  assert.equal(a.trainTicks, b.trainTicks);
  assert.ok(Math.abs(a.platt.a - b.platt.a) < 1e-9, "calibration leaked from the test half");
});

test("the post-loss shield reduces consecutive-loss pairs it was asked to reduce", () => {
  const digits = clustered(3000, 19);
  const contract: ShotContract = { kind: "over", digit: 1 };
  const walk = walkForward(digits, shotWinSet(contract), {
    breakEven: shotBreakEven(contract), payout: shotPayout(contract), spec: certaintySpec("balanced"), ...RISK,
  });
  assert.ok(walk.shield.pairsAfter <= walk.shield.pairsBefore,
    `shield increased loss pairs: ${walk.shield.pairsBefore} → ${walk.shield.pairsAfter}`);
  assert.ok(walk.shield.longestRunAfter <= Math.max(1, walk.test.longestLossRun));
});

test("the post-loss shield actually raises the live bar and holds fire during cool-down", () => {
  const digits = conditional(1500, 23);
  const contract: ShotContract = { kind: "over", digit: 4 };
  const winSet = shotWinSet(contract);
  const spec = certaintySpec("strict");
  const walk = walkForward(digits, winSet, {
    breakEven: shotBreakEven(contract), payout: shotPayout(contract), spec, ...RISK,
  });
  const card: ModelCard = {
    tau: walk.tau, platt: walk.platt, hmm: walk.hmm,
    breakEven: shotBreakEven(contract), payout: shotPayout(contract),
    targetShotRate: spec.targetShotRate,
    minSpacing: spec.minSpacing, postLossTightening: spec.postLossTightening,
    postLossCoolTicks: spec.postLossCoolTicks, fittedOn: walk.trainTicks,
  };
  const calm = evaluateLiveEntry(digits, winSet, card, { ticksSinceLoss: Number.POSITIVE_INFINITY });
  const shielded = evaluateLiveEntry(digits, winSet, card, { barBoost: 1.5, ticksSinceLoss: Number.POSITIVE_INFINITY });
  assert.ok(shielded.bar > calm.bar, "the shield must raise the bar");
  assert.ok(Math.abs(shielded.z - calm.z) < 1e-12, "the shield must not change the read, only the bar");

  const cooling = evaluateLiveEntry(digits, winSet, card, { ticksSinceLoss: 0 });
  assert.equal(cooling.ready, false, "no shot during the post-loss cool-down");
  assert.match(cooling.reason, /cool-down/);
});

test("a short history is refused rather than guessed at", () => {
  const short = uniform(400);
  const contract: ShotContract = { kind: "over", digit: 1 };
  assert.equal(evaluateCandidate("R_10", "Volatility 10", short, contract), null);
  const walk = walkForward(short, shotWinSet(contract), {
    breakEven: shotBreakEven(contract), payout: shotPayout(contract), spec: certaintySpec("balanced"), ...RISK,
  });
  assert.equal(walk.test.nShots, 0);
  assert.equal(walk.testTicks, 0);
  assert.ok(MIN_HISTORY >= 900 && SCAN_WINDOW === 4999);
});

// ═══════════════════════════════════════════════════════════════════════════
// CANDIDATE VERDICTS
// ═══════════════════════════════════════════════════════════════════════════

test("a fair market is never certified, but it is always explained", () => {
  const digits = uniform(3200, 99);
  const c = evaluateCandidate("R_50", "Volatility 50", digits, { kind: "over", digit: 4 }, { certainty: "strict", ...RISK });
  assert.ok(c, "a judgeable market must always produce a candidate, never null");
  assert.notEqual(c!.verdict, "certified");
  assert.equal(c!.deployable, false);
  assert.ok(c!.blockers.length > 0, "a refusal must always say why");
  // The scan is still allowed to rank it — the console shows the best available.
  assert.ok(c!.confidence >= 0 && c!.confidence <= 100);
  assert.ok(Number.isFinite(c!.edgePerDollar));
  assert.ok(c!.walk.test.nShots > 0, "even a refused market must show measured shots");
});

test("a market with genuine conditional structure scores above a fair one", () => {
  const contract: ShotContract = { kind: "over", digit: 4 };
  const fair = evaluateCandidate("R_10", "Volatility 10", uniform(3200, 5), contract, { certainty: "balanced", ...RISK });
  const real = evaluateCandidate("R_25", "Volatility 25", conditional(3200, 3), contract, { certainty: "balanced", ...RISK });
  assert.ok(fair && real);
  assert.ok(real!.walk.test.winRate > fair!.walk.test.winRate,
    `structured ${real!.walk.test.winRate} should beat fair ${fair!.walk.test.winRate}`);
  assert.ok(real!.edgePerDollar > fair!.edgePerDollar);
  assert.ok(real!.confidence > fair!.confidence);
});

test("the headline number is the out-of-sample one, and both halves are reported", () => {
  const c = evaluateCandidate("R_25", "Volatility 25", conditional(3200, 3), { kind: "over", digit: 4 },
    { certainty: "balanced", ...RISK })!;
  assert.ok(c.walk.trainTicks > 0 && c.walk.testTicks > 0);
  assert.ok(c.walk.train.nShots > 0 && c.walk.test.nShots > 0);
  // edgePerDollar must be derived from the TEST ledger, not the train one.
  const fromTest = c.walk.test.evPerDollar;
  assert.ok(Math.abs(c.edgePerDollar - fromTest) < 1e-9,
    `headline edge ${c.edgePerDollar} must equal the OOS ledger ${fromTest}`);
  assert.equal(c.card.tau, c.walk.tau);
  assert.equal(c.card.fittedOn, c.walk.trainTicks);
});

test("every candidate carries a deployable model card", () => {
  const c = evaluateCandidate("R_25", "Volatility 25", conditional(3200, 3), { kind: "over", digit: 4 },
    { certainty: "strict", ...RISK })!;
  for (const k of ["tau", "breakEven", "payout", "minSpacing", "postLossTightening", "postLossCoolTicks", "fittedOn"] as const) {
    assert.ok(Number.isFinite(c.card[k] as number), `card.${k} must be a finite number`);
  }
  assert.ok(Number.isFinite(c.card.platt.a) && Number.isFinite(c.card.platt.b));
  assert.ok(Number.isFinite(c.card.hmm.pHot) && Number.isFinite(c.card.hmm.stay));
});

test("certainty specs are ordered from strictest to loosest on every axis", () => {
  const e = KILLSHOT_CERTAINTY.elite, s = KILLSHOT_CERTAINTY.strict, b = KILLSHOT_CERTAINTY.balanced;
  assert.ok(e.targetShotRate < s.targetShotRate && s.targetShotRate < b.targetShotRate);
  assert.ok(e.minShots > s.minShots && s.minShots > b.minShots);
  assert.ok(e.accuracyMargin > s.accuracyMargin && s.accuracyMargin > b.accuracyMargin);
  assert.ok(e.minEvidenceE > s.minEvidenceE && s.minEvidenceE > b.minEvidenceE);
  assert.ok(e.minLadderSafety > s.minLadderSafety && s.minLadderSafety > b.minLadderSafety);
  assert.ok(e.minConfidence > s.minConfidence && s.minConfidence > b.minConfidence);
  assert.equal(e.fdrRequired, true);
  assert.equal(certaintySpec("nonsense").id, "strict");
});

test("harder certainty can only shrink the deployable set", () => {
  const digits = conditional(3200, 3);
  const contract: ShotContract = { kind: "over", digit: 4 };
  const bal = evaluateCandidate("R_25", "V25", digits, contract, { certainty: "balanced", ...RISK })!;
  const eli = evaluateCandidate("R_25", "V25", digits, contract, { certainty: "elite", ...RISK })!;
  if (eli.deployable) assert.ok(bal.deployable, "elite passing while balanced fails is incoherent");
  assert.ok(eli.blockers.length >= bal.blockers.length - 1);
});

test("multiplicity control demotes certified candidates when the family is large", () => {
  const contract: ShotContract = { kind: "over", digit: 4 };
  const family = Array.from({ length: 8 }, (_, i) =>
    evaluateCandidate(`R_${i}`, `Market ${i}`, uniform(2200, 100 + i), contract, { certainty: "elite", ...RISK }),
  ).filter((c): c is NonNullable<typeof c> => c !== null);
  assert.ok(family.length >= 6);
  const screened = screenCandidates(family, 0.1);
  // Twelve fair markets must not yield a certified winner just because one of
  // them looked good — that is the multiple-comparisons trap.
  assert.equal(screened.filter(c => c.verdict === "certified").length, 0);
  // Ranking is still total and stable.
  for (let i = 1; i < screened.length; i++) {
    const prev = screened[i - 1]!, cur = screened[i]!;
    const rank = (v: string) => (v === "certified" ? 0 : v === "qualified" ? 1 : v === "watch" ? 2 : 3);
    assert.ok(rank(prev.verdict) <= rank(cur.verdict), "verdict ordering broken");
  }
});

test("Matches candidates across all ten digits are all judgeable", () => {
  const digits = conditional(2400, 47);
  for (let d = 0; d <= 9; d++) {
    const c = evaluateCandidate("R_75", "Volatility 75", digits, { kind: "match", digit: d },
      { certainty: "balanced", ...RISK });
    assert.ok(c, `Matches ${d} produced no candidate`);
    assert.equal(c!.label, shotLabel({ kind: "match", digit: d }));
    assert.ok(Math.abs(c!.payout - 8.93) < 1e-9);
    assert.ok(c!.walk.test.nShots >= 0);
  }
});
