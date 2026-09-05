/**
 * Unit tests for the Apex One-Shot Sniper analysis core.
 *
 * The two probabilistic centrepieces — the exact Markov-chain-imbedded ladder
 * ruin probability and the closed-form mean waiting time — are checked against
 * Monte Carlo on the same chain, because a formula that is merely plausible is
 * not good enough for a number the user is asked to trust before deploying.
 */

import { test } from "node:test";
import assert from "node:assert";
import {
  apexBreakEven, apexLabel, apexPayout, apexWinSet, validateApexContract,
  ladderAbsorption, ladderDepthLimit, expectedShotsToLadderBreak,
  lossChain, replayEntryRule, contextEstimate, anytimeLowerBound, sprt,
  stationarity, pageHinkley, concordance,
  evaluateApexCandidate, evaluateApexEntry, screenApexCandidates,
  APEX_CERTAINTY, certaintySpec,
} from "./apex-analysis";
import { evaluateApexTiming, APEX_TIMING } from "./apex-timing";

// ── Deterministic generators ──────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Uniform digits — the null model. Nothing here should be +EV on it. */
function uniform(n: number, seed = 7): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => Math.floor(r() * 10));
}

/**
 * A stream BIASED toward high digits: Over 1 wins ~92 % of the time, which is
 * genuinely above its 81.3 % break-even. This is the "planted edge" stream.
 */
function hotHigh(n: number, seed = 21, hotP = 0.92): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => (r() < hotP ? 2 + Math.floor(r() * 8) : Math.floor(r() * 2)));
}

/** Losses that CLUSTER: low digits arrive in runs, so Over 1's losses pair up. */
function clustered(n: number, seed = 11): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let low = false;
  for (let i = 0; i < n; i++) {
    low = r() < (low ? 0.78 : 0.10);
    out.push(low ? Math.floor(r() * 2) : 2 + Math.floor(r() * 8));
  }
  return out;
}

/**
 * High win rate WITH clustered losses: mostly high digits, punctuated by short
 * cold bursts. This is the case the clustering gate exists for — a win rate that
 * looks excellent and a loss sequence that arrives in runs.
 */
function clusteredHot(n: number, seed = 13, burstP = 0.02, burstLen = 4): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let burst = 0;
  for (let i = 0; i < n; i++) {
    if (burst > 0) { burst--; out.push(Math.floor(r() * 2)); continue; }
    if (r() < burstP) { burst = burstLen - 1; out.push(Math.floor(r() * 2)); continue; }
    out.push(2 + Math.floor(r() * 8));
  }
  return out;
}

/** A stream that wins Over 0 (i.e. avoids the digit 0) ~95.5 % of the time. */
function hotLowOnly(n: number, seed = 21, p = 0.955): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => (r() < p ? 1 + Math.floor(r() * 9) : 0));
}

/** Monte Carlo: P(a run of >limit consecutive losses occurs within nShots). */
function mcLadderAbsorption(p0: number, q: number, limit: number, nShots: number, paths = 40000, seed = 99) {
  const r = rng(seed);
  let broke = 0;
  for (let p = 0; p < paths; p++) {
    let run = 0;
    let hit = false;
    for (let s = 0; s < nShots; s++) {
      const pL = run === 0 ? p0 : q;
      if (r() < pL) { run++; if (run > limit) { hit = true; break; } } else run = 0;
    }
    if (hit) broke++;
  }
  return broke / paths;
}

/** Monte Carlo: mean shots until `k` consecutive losses, 2-state chain. */
function mcWaitingTime(r_: number, q: number, k: number, paths = 40000, seed = 555) {
  const rand = rng(seed);
  let total = 0;
  for (let p = 0; p < paths; p++) {
    let run = 0;
    let shots = 0;
    while (run < k) {
      shots++;
      const pL = run === 0 ? r_ : q;
      if (rand() < pL) run++; else run = 0;
      if (shots > 2_000_000) break;
    }
    total += shots;
  }
  return total / paths;
}

// ── Contract vocabulary ───────────────────────────────────────────────────────

test("contract validation enforces exactly one side", () => {
  assert.equal(validateApexContract({ kind: "over", digit: 7 }).ok, true);
  assert.equal(validateApexContract({ kind: "under", digit: 2 }).ok, true);
  assert.equal(validateApexContract({ kind: "even" }).ok, true);
  assert.equal(validateApexContract({ kind: "odd" }).ok, true);
  assert.equal(validateApexContract({ kind: "match" }).ok, true, "Matches may delegate the digit");
  assert.equal(validateApexContract({ kind: "match", digit: 5 }).contract.digit, 5);
  // Impossible contracts are refused.
  assert.equal(validateApexContract({ kind: "over", digit: 9 }).ok, false, "Over 9 can never win");
  assert.equal(validateApexContract({ kind: "under", digit: 0 }).ok, false, "Under 0 can never win");
  assert.equal(validateApexContract({ kind: "both" }).ok, false, "there is no both");
  assert.equal(validateApexContract({ kind: "over" }).ok, false, "over needs a digit");
});

test("win sets, payouts and break-evens are the Deriv ones", () => {
  assert.deepEqual([...apexWinSet({ kind: "over", digit: 7 })], [8, 9]);
  assert.deepEqual([...apexWinSet({ kind: "under", digit: 2 })], [0, 1]);
  assert.deepEqual([...apexWinSet({ kind: "even" })], [0, 2, 4, 6, 8]);
  assert.deepEqual([...apexWinSet({ kind: "match", digit: 3 })], [3]);
  assert.equal(apexPayout({ kind: "over", digit: 7 }), 4.72);
  assert.equal(apexPayout({ kind: "even" }), 1.95);
  assert.ok(Math.abs(apexBreakEven({ kind: "over", digit: 1 }) - 1 / 1.23) < 1e-9);
  assert.equal(apexLabel({ kind: "match" }), "Matches (AI picks the digit)");
  // The house margin the whole design is built around: every digit contract pays
  // below its fair rate, so an unbiased stream is always −EV.
  assert.ok(apexBreakEven({ kind: "over", digit: 1 }) > 0.8, "Over 1 break-even must exceed its 80% fair rate");
  assert.ok(apexBreakEven({ kind: "match", digit: 4 }) > 0.1, "Matches break-even must exceed its 10% fair rate");
});

// ── The ladder ────────────────────────────────────────────────────────────────

test("ladderDepthLimit solves the debt geometry in closed form", () => {
  // $1 base, 1.95× payout (net 0.95), 10 % markup, $500 cap, $5 stop loss.
  //   a = 1.10/0.95 = 1.1579
  //   debt(k) = 1·(1+a)^(k−1) = 2.1579^(k−1) → 1, 2.16, 4.66, 10.05
  //   stake(k) = a·(1+a)^(k−2)               → reaches the $500 cap at k ≈ 8
  // So the STOP LOSS binds first: three consecutive losses leave $4.66 of debt,
  // still inside the $5 stop; a fourth takes the session to −$10.05 and out.
  const l = ladderDepthLimit({ baseStake: 1, payout: 1.95, markupPercent: 10, maxStake: 500, stopLoss: 5 });
  assert.ok(Math.abs(l.growthFactor - 1.1579) < 0.001, `growth ${l.growthFactor}`);
  assert.equal(l.byStopLoss, 3, `stop-loss depth ${l.byStopLoss}`);
  assert.ok(l.byStakeCap >= 7, `cap depth ${l.byStakeCap}`);
  assert.equal(l.limit, 3, "the binding limit is the tighter of the two");
  assert.ok(l.debtAtLimit <= 5, `debt at the limit ${l.debtAtLimit} must still be inside the stop loss`);
  // A bigger stop loss and a higher cap let the ladder run deeper.
  const wide = ladderDepthLimit({ baseStake: 1, payout: 1.95, markupPercent: 10, maxStake: 100000, stopLoss: 100000 });
  assert.ok(wide.limit > l.limit, "a wider stop loss must admit a deeper ladder");
  // A low-payout contract compounds faster, so it absorbs FEWER losses.
  const lowPay = ladderDepthLimit({ baseStake: 1, payout: 1.09, markupPercent: 10, maxStake: 100000, stopLoss: 1000 });
  assert.ok(lowPay.limit < wide.limit, "a 1.09× ladder must break sooner than a 1.95× one");
});

test("exact ladder-ruin probability matches Monte Carlo on the same chain", () => {
  for (const [pLoss, q, limit, nShots] of [
    [0.2, 0.2, 3, 60],
    [0.3, 0.45, 2, 40],
    [0.15, 0.05, 4, 100],
  ] as Array<[number, number, number, number]>) {
    const exact = ladderAbsorption(pLoss, q, limit, nShots);
    const mc = mcLadderAbsorption(pLoss, q, limit, nShots);
    assert.ok(
      Math.abs(exact - mc) < 0.02,
      `p=${pLoss} q=${q} k=${limit} n=${nShots}: exact ${exact.toFixed(4)} vs MC ${mc.toFixed(4)}`,
    );
  }
});

test("ladder ruin rises with clustering and with the horizon, and respects its edges", () => {
  const clean = ladderAbsorption(0.25, 0.15, 3, 60);
  const clusteredChain = ladderAbsorption(0.25, 0.45, 3, 60);
  assert.ok(clusteredChain > clean * 2, `clustering must multiply ruin: ${clean} vs ${clusteredChain}`);
  assert.ok(ladderAbsorption(0.25, 0.15, 3, 400) > clean, "a longer session must be more dangerous");
  assert.equal(ladderAbsorption(0.3, 0.3, 2, 0), 0, "no shots ⇒ no ruin");
  assert.ok(ladderAbsorption(0.9, 0.9, 1, 50) > 0.99, "a near-certain loss stream must ruin");
  assert.ok(ladderAbsorption(0.02, 0.02, 5, 50) < 0.01, "a near-certain win stream must be safe");
});

test("closed-form mean waiting time matches Monte Carlo", () => {
  // pLoss 0.25 with q 0.25 is an independent stream, so r = q = p.
  const p = 0.25, q = 0.25, limit = 3;
  const exact = expectedShotsToLadderBreak(p, q, limit);
  const r = (p * (1 - q)) / (1 - p);
  const mc = mcWaitingTime(r, q, limit + 1);
  assert.ok(
    Math.abs(exact - mc) / mc < 0.08,
    `independent stream: closed form ${exact} vs MC ${mc.toFixed(1)}`,
  );
  // Clustering shortens the wait dramatically.
  const clusteredWait = expectedShotsToLadderBreak(0.25, 0.6, limit);
  assert.ok(clusteredWait < exact * 0.4, `clustering must shorten the wait: ${clusteredWait} vs ${exact}`);
  // Reduces to the classical (1 − p^k)/((1−p)p^k) on an independent stream.
  const k = limit + 1;
  const classical = (1 - Math.pow(p, k)) / ((1 - p) * Math.pow(p, k));
  assert.ok(Math.abs(exact - classical) / classical < 0.02, `${exact} vs classical ${classical.toFixed(1)}`);
});

// ── Loss chain ────────────────────────────────────────────────────────────────

test("lossChain separates a clustered stream from an independent one", () => {
  const indep = lossChain(uniform(1200).map(d => (d > 1 ? 1 : 0)));
  const clus = lossChain(clustered(1200).map(d => (d > 1 ? 1 : 0)));
  // A fair Over-1 stream loses only 20 % of the time, so q is estimated from few
  // transitions and ξ_upper is wide from sampling noise alone (~1.2). That is
  // exactly why the gate uses the z, not an absolute ceiling on ξ.
  assert.ok(indep.clusterZ < 1.645, `independent clusterZ ${indep.clusterZ} must not look significant`);
  assert.ok(indep.xiUpper > 1.1, `ξ_upper on a fair high-win-rate stream is wide by construction: ${indep.xiUpper}`);
  assert.ok(clus.clusterZ > 3, `clustered clusterZ ${clus.clusterZ}`);
  assert.ok(clus.xi > 1.6, `clustered ξ ${clus.xi}`);
  assert.ok(clus.clusterGapPP > 5, `clustered gap ${clus.clusterGapPP}pp`);
  // P(two in a row) is reported against its independence baseline, not gated on.
  assert.ok(clus.pTwoInARow > clus.pairBaseline * 1.5);
  assert.ok(indep.runsZ > -1.5, `independent runs z ${indep.runsZ}`);
  assert.ok(clus.runsZ < -2, `clustered runs z ${clus.runsZ}`);
});

// ── Estimators ────────────────────────────────────────────────────────────────

test("the KT context model recovers a planted conditional bias", () => {
  // Digits after a 9 are forced high; the rest is uniform. The order-1 context
  // ending in 9 must read far hotter than the marginal.
  const r = rng(31);
  const digits: number[] = [];
  for (let i = 0; i < 2400; i++) {
    const prev = digits[digits.length - 1];
    digits.push(prev === 9 && r() < 0.85 ? 7 + Math.floor(r() * 3) : Math.floor(r() * 10));
  }
  const winSet = apexWinSet({ kind: "over", digit: 6 });
  const wins = digits.map(d => (winSet.has(d) ? 1 : 0));
  const ctx = contextEstimate(digits, wins, 2);
  assert.ok(ctx.byOrder.length >= 2, "at least the marginal and order-1 must be estimated");
  const order1 = ctx.byOrder.find(o => o.order === 1)!;
  assert.ok(order1.p > wins.reduce((a, b) => a + b, 0) / wins.length, "order-1 must see the conditional bias");
  assert.ok(ctx.lower < ctx.p, "the conservative floor must sit under the point estimate");
});

test("anytime-valid bound is conservative and tightens with n", () => {
  const wins = hotHigh(300).map(d => (d > 1 ? 1 : 0));
  const small = anytimeLowerBound(wins.slice(0, 60), 0.01);
  const large = anytimeLowerBound(wins, 0.01);
  assert.ok(small.lower < small.mean, "the bound must sit under the mean");
  assert.ok(large.lower > small.lower, `more data must tighten: ${small.lower} → ${large.lower}`);
  assert.ok(large.lower <= large.mean + 1e-9);
});

test("SPRT fires on a genuine edge and refuses a fair stream, with δ absolute", () => {
  const be = apexBreakEven({ kind: "over", digit: 1 });
  const hot = sprt(hotHigh(600).map(d => (d > 1 ? 1 : 0)), be, be + 0.02, 0.05, 0.2);
  const fair = sprt(uniform(600).map(d => (d > 1 ? 1 : 0)), be, be + 0.02, 0.05, 0.2);
  assert.equal(hot.decision, "fire", `hot logLR ${hot.logLR}/${hot.upper}`);
  assert.notEqual(fair.decision, "fire", "a fair stream must not fire");
  // A selection surcharge raises the bar.
  const surcharged = sprt(hotHigh(600).map(d => (d > 1 ? 1 : 0)), be, be + 0.02, 0.05, 0.2, Math.log(200));
  assert.ok(surcharged.upper > hot.upper, "log(#candidates) must raise the threshold");
});

test("stationarity and Page–Hinkley both catch a decaying rate", () => {
  const stable = uniform(800).map(d => (d > 1 ? 1 : 0));
  const decay = [...hotHigh(400).map(d => (d > 1 ? 1 : 0)), ...uniform(400).map(d => (d > 1 ? 1 : 0))];
  assert.ok(Math.abs(stationarity(stable).z) < 3, `stable z ${stationarity(stable).z}`);
  assert.ok(Math.abs(stationarity(decay).z) > 3, `decay z ${stationarity(decay).z}`);
  assert.ok(!pageHinkley(stable).fired, "a stable stream must not trip the drift guard");
  assert.ok(pageHinkley(decay).fired, "a decaying stream must trip the drift guard");
});

test("concordance counts horizons above the hurdle", () => {
  const winSet = apexWinSet({ kind: "over", digit: 1 });
  const hot = concordance(hotHigh(600), winSet, apexBreakEven({ kind: "over", digit: 1 }), 0.005);
  const fair = concordance(uniform(600), winSet, apexBreakEven({ kind: "over", digit: 1 }), 0.005);
  assert.equal(hot.total, 4);
  assert.equal(hot.agreeing, 4, "a planted edge must show at every horizon");
  assert.ok(fair.agreeing <= 1, "a fair stream must not clear the hurdle");
});

// ── The replay ────────────────────────────────────────────────────────────────

test("the replay fires on a planted edge and stays silent on a fair stream", () => {
  const contract = { kind: "over" as const, digit: 1 };
  const be = apexBreakEven(contract);
  const base = {
    breakEven: be, payout: apexPayout(contract), baseStake: 1,
    markupPercent: 10, maxStake: 500, stopLoss: 5, spec: certaintySpec("strict"),
  };
  const hot = replayEntryRule(hotHigh(1200), apexWinSet(contract), base);
  const fair = replayEntryRule(uniform(1200), apexWinSet(contract), base);

  assert.ok(hot.nShots >= base.spec.minShots, `hot stream fired ${hot.nShots}×`);
  assert.ok(hot.winRate > be, `replayed accuracy ${(hot.winRate * 100).toFixed(1)}% must beat break-even ${(be * 100).toFixed(1)}%`);
  assert.ok(hot.evPerDollar > 0, `EV ${hot.evPerDollar}`);
  assert.ok(fair.nShots < base.spec.minShots, `a fair stream must not produce ${fair.nShots} qualifying shots`);
  assert.ok(hot.fireRate < 0.5, "a sniper does not fire on half the ticks");
});

test("the replay does not look ahead", () => {
  // Prefix test: the decision at index i must be identical whether or not the
  // future exists. Replay a prefix and the full stream and compare every shot
  // that the prefix produced.
  const contract = { kind: "over" as const, digit: 1 };
  const stream = hotHigh(1200);
  const params = {
    breakEven: apexBreakEven(contract), payout: apexPayout(contract), baseStake: 1,
    markupPercent: 10, maxStake: 500, stopLoss: 5, spec: certaintySpec("strict"),
  };
  const full = replayEntryRule(stream, apexWinSet(contract), params);
  const cut = 900;
  const prefix = replayEntryRule(stream.slice(0, cut), apexWinSet(contract), params);
  assert.ok(prefix.nShots > 5, "the prefix must itself produce shots for this to be a real test");
  const fullPrefixShots = full.shots.filter(s => s.index < cut);
  assert.deepEqual(
    prefix.shots.map(s => ({ i: s.index, w: s.won, p: s.condP })),
    fullPrefixShots.map(s => ({ i: s.index, w: s.won, p: s.condP })),
    "shots decided before the cut must be identical with and without the future",
  );
});

test("the replayed ladder tracks the shared debt arithmetic", () => {
  const contract = { kind: "even" as const };
  const r = rng(77);
  // ~48 % win rate with mild clustering: the ladder must go deep.
  const digits = Array.from({ length: 1200 }, () => (r() < 0.48 ? 2 * Math.floor(r() * 5) : 1 + 2 * Math.floor(r() * 5)));
  const replay = replayEntryRule(digits, apexWinSet(contract), {
    breakEven: apexBreakEven(contract), payout: apexPayout(contract), baseStake: 1,
    markupPercent: 10, maxStake: 500, stopLoss: 5000,
    spec: certaintySpec("balanced"),
  });
  if (replay.longestLossRun >= 2) {
    const ladder = ladderDepthLimit({ baseStake: 1, payout: apexPayout(contract), markupPercent: 10, maxStake: 500, stopLoss: 5000 });
    const expectedDebt = 1 * Math.pow(1 + ladder.growthFactor, replay.longestLossRun - 1);
    assert.ok(Math.abs(replay.maxDebt - expectedDebt) < 0.02, `debt ${replay.maxDebt} vs ${expectedDebt.toFixed(2)}`);
    assert.ok(replay.maxStake > 1, "a deep ladder must demand more than the base stake");
  }
});

// ── Candidate evaluation ──────────────────────────────────────────────────────

test("a planted edge is deployable at balanced and a fair stream never is", () => {
  const contract = { kind: "over" as const, digit: 1 };
  const hot = evaluateApexCandidate("HOT", "Hot", hotHigh(1200, 21, 0.93), contract, {
    certainty: "balanced", baseStake: 1, markupPercent: 10, maxStake: 500, stopLoss: 50,
  })!;
  const fair = evaluateApexCandidate("FAIR", "Fair", uniform(1200), contract, {
    certainty: "balanced", baseStake: 1, markupPercent: 10, maxStake: 500, stopLoss: 50,
  })!;

  assert.ok(hot, "the hot market must be scored");
  assert.ok(hot.replay.winRate > hot.breakEven, "the replay must see the planted edge");
  assert.ok(hot.ladder.safety > 0 && hot.ladder.safety <= 1);
  assert.ok(hot.confidence > fair.confidence, `${hot.confidence} vs ${fair.confidence}`);
  assert.equal(fair.deployable, false, `a fair stream must never be deployable: ${fair.blockers[0]}`);
  assert.ok(fair.blockers.length > 0);
  // The structural headroom must be reported, not hidden.
  assert.ok(fair.headroomPP < 0, "Over 1 must be reported as structurally −EV on a fair stream");
  assert.ok(fair.signals.some(s => s.includes("STRUCTURAL HEADROOM")));
});

test("the conditional entry rule filters clustered losses out of the shots it takes", () => {
  // The raw market is violently clustered: its losses arrive in 4-tick bursts.
  const stream = clusteredHot(1400);
  const raw = lossChain(stream.map(d => (d > 1 ? 1 : 0)));
  assert.ok(raw.clusterZ > 5, `raw stream clusterZ ${raw.clusterZ}`);
  assert.ok(raw.xi > 3, `raw stream ξ ${raw.xi}`);
  // Left to itself, that stream would break a 3-deep ladder three sessions in four.
  const rawSafety = 1 - ladderAbsorption(raw.pLoss, raw.q, 3, 60);
  assert.ok(rawSafety < 0.5, `raw ladder safety ${rawSafety.toFixed(3)}`);

  // But the bot does not trade every tick — it trades where the conditional read
  // clears break-even, and a cold burst collapses that read. The shots it
  // actually takes inherit almost none of the raw clustering.
  const cand = evaluateApexCandidate("CLUS", "Clustered", stream, { kind: "over", digit: 1 }, {
    certainty: "balanced", baseStake: 1, markupPercent: 10, maxStake: 500, stopLoss: 50,
  })!;
  assert.ok(cand.replay.nShots >= 20, `the replay must produce shots, got ${cand.replay.nShots}`);
  assert.ok(cand.replay.chain.clusterZ < raw.clusterZ, "the shots must be less clustered than the stream");
  assert.ok(cand.ladder.safety > 0.95, `replayed ladder safety ${cand.ladder.safety}`);
  assert.ok(cand.ladder.safety > rawSafety + 0.4,
    `the entry rule must buy real safety: ${(cand.ladder.safety * 100).toFixed(1)}% vs raw ${(rawSafety * 100).toFixed(1)}%`);
});

test("a ladder that can only absorb one loss is gated, not merely reported", () => {
  // Over 0 pays 1.09×, so a = 1.10/0.09 = 12.2: the debt multiplies 13.2× per
  // step and a $5 stop loss is gone after a SINGLE consecutive loss.
  const depth = ladderDepthLimit({ baseStake: 1, payout: 1.09, markupPercent: 10, maxStake: 500, stopLoss: 5 });
  assert.equal(depth.limit, 1, `limit ${depth.limit}`);
  assert.ok(depth.byStakeCap > depth.byStopLoss, "the stop loss, not the stake cap, is what binds here");

  const gated = [21, 33, 45].map(seed =>
    evaluateApexCandidate("O0", "Over 0", hotLowOnly(1400, seed), { kind: "over", digit: 0 }, {
      certainty: "strict", baseStake: 1, markupPercent: 10, maxStake: 500, stopLoss: 5,
    })!);
  for (const c of gated) {
    assert.equal(c.deployable, false, "a one-loss ladder must not be deployable at strict");
    assert.ok(
      c.blockers.some(b => b.includes("ladder safety")),
      `the ladder gate must be the one that says so, got: ${c.blockers.join(" | ")}`,
    );
  }
});

test("higher certainty is strictly harder to satisfy", () => {
  const contract = { kind: "over" as const, digit: 1 };
  const stream = hotHigh(1200, 21, 0.90);
  const opts = { baseStake: 1, markupPercent: 10, maxStake: 500, stopLoss: 50 };
  const balanced = evaluateApexCandidate("M", "M", stream, contract, { ...opts, certainty: "balanced" })!;
  const elite = evaluateApexCandidate("M", "M", stream, contract, { ...opts, certainty: "elite" })!;
  assert.ok(elite.blockers.length >= balanced.blockers.length,
    `elite must be at least as strict: ${elite.blockers.length} vs ${balanced.blockers.length}`);
  assert.ok(APEX_CERTAINTY.elite.minConfidence > APEX_CERTAINTY.balanced.minConfidence);
  assert.ok(APEX_CERTAINTY.elite.minLadderSafety > APEX_CERTAINTY.balanced.minLadderSafety);
  assert.ok(APEX_CERTAINTY.elite.minShots > APEX_CERTAINTY.balanced.minShots);
});

test("insufficient history yields no candidate at all", () => {
  assert.equal(evaluateApexCandidate("X", "X", uniform(120), { kind: "even" }), null);
});

test("the FDR screen flags significance and ranks deployable candidates first", () => {
  const contract = { kind: "over" as const, digit: 1 };
  const opts = { baseStake: 1, markupPercent: 10, maxStake: 500, stopLoss: 50, certainty: "balanced" as const };
  const candidates = [
    evaluateApexCandidate("A", "A", uniform(900, 3), contract, opts)!,
    evaluateApexCandidate("B", "B", hotHigh(900, 21, 0.93), contract, opts)!,
    evaluateApexCandidate("C", "C", uniform(900, 5), contract, opts)!,
  ].filter(Boolean);
  const ranked = screenApexCandidates(candidates, 0.25);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0]!.symbol, "B", "the planted-edge market must rank first");
  assert.ok(ranked.some(c => c.significant), "at least one candidate must survive BH at q=0.25");
});

// ── The live entry gate ───────────────────────────────────────────────────────

test("the entry gate matches the rule the replay prices", () => {
  const contract = { kind: "over" as const, digit: 1 };
  const spec = certaintySpec("strict");
  const be = apexBreakEven(contract);
  const hot = evaluateApexEntry(hotHigh(900, 21, 0.93), apexWinSet(contract), be, spec);
  const fair = evaluateApexEntry(uniform(900), apexWinSet(contract), be, spec);
  assert.equal(hot.ready, true, `hot entry refused: ${hot.reason}`);
  assert.ok(hot.condLower >= hot.bar);
  assert.ok(hot.marginPP > 0);
  assert.equal(fair.ready, false, "a fair stream must not arm an entry");
  assert.ok(fair.reason.length > 0, "a refusal must explain itself");
  // Too little history is refused rather than guessed at.
  assert.equal(evaluateApexEntry(hotHigh(80), apexWinSet(contract), be, spec).ready, false);
});

// ── Timing ────────────────────────────────────────────────────────────────────

/**
 * A RANDOM stream in which digit 7 appears ~1/8 of the time and the last win was
 * exactly `trailing` ticks ago. Randomness matters: a periodic stream makes
 * P(win|loss) and P(win|win) differ by construction, which would arm the Markov
 * state gate and stop this being a test of the renewal clock.
 */
function matchStream(trailing: number, n = 480, seed = 42): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n - trailing; i++) out.push(r() < 0.125 ? 7 : (r() < 0.5 ? 3 : 5));
  for (let i = 0; i < trailing; i++) out.push(r() < 0.5 ? 3 : 5);
  return out;
}

test("timing accepts a due renewal clock and refuses a just-reset one", () => {
  const winSet = apexWinSet({ kind: "match", digit: 7 });
  // Mean gap ≈ 8 ticks; last win 8 ticks ago ⇒ ratio ≈ 1.0, exactly due.
  const due = evaluateApexTiming({
    digits: matchStream(8), winSet, secondsSinceLastTick: 1,
    medianTickGapSeconds: 2, ticksSinceLastShot: 50, waitedTicks: 0,
  });
  assert.equal(due.components.preferredState, "none", `random stream invented a preference: ${due.components.stateEdgePP}pp`);
  assert.ok(due.components.gapRatio > 0.6 && due.components.gapRatio < 2.2, `gap ratio ${due.components.gapRatio}`);
  assert.equal(due.ready, true, `a due entry was refused: ${due.reason}`);

  // The contract paid on the last tick, so the renewal clock has just reset.
  const reset = evaluateApexTiming({
    digits: [...matchStream(8), 7], winSet, secondsSinceLastTick: 1,
    medianTickGapSeconds: 2, ticksSinceLastShot: 50, waitedTicks: 0,
  });
  assert.equal(reset.components.gapTicks, 0);
  assert.equal(reset.ready, false, "firing the tick after a win must be refused on a narrow win set");
  assert.ok(reset.reason.includes("renewal"), reset.reason);
});

test("the patience valve takes a conclusive setup that has waited long enough", () => {
  const winSet = apexWinSet({ kind: "match", digit: 7 });
  const held = evaluateApexTiming({
    digits: [...matchStream(8), 7], winSet, secondsSinceLastTick: 1,
    medianTickGapSeconds: 2, ticksSinceLastShot: 50, waitedTicks: APEX_TIMING.maxWaitTicks,
  });
  assert.equal(held.ready, true, "the valve must fire");
  assert.ok(held.reason.includes("Taking the shot"), held.reason);
});

test("a stalled feed is refused", () => {
  const winSet = apexWinSet({ kind: "over", digit: 1 });
  const digits = hotHigh(400);
  const stale = evaluateApexTiming({
    digits, winSet, secondsSinceLastTick: 30, medianTickGapSeconds: 2, ticksSinceLastShot: 50, waitedTicks: 0,
  });
  assert.equal(stale.ready, false);
  assert.ok(stale.reason.includes("feed"), stale.reason);
});

test("the Markov state preference only applies when the chain supports it", () => {
  // Independent stream ⇒ no preference, so nothing is blocked on state.
  const neutral = evaluateApexTiming({
    digits: hotHigh(500, 21, 0.9),
    winSet: apexWinSet({ kind: "over", digit: 1 }),
    secondsSinceLastTick: 1, medianTickGapSeconds: 2, ticksSinceLastShot: 50, waitedTicks: 0,
  });
  assert.equal(neutral.components.preferredState, "none",
    `an independent stream must not invent a preference (edge ${neutral.components.stateEdgePP}pp)`);
  assert.equal(neutral.components.inPreferredState, true);
});
