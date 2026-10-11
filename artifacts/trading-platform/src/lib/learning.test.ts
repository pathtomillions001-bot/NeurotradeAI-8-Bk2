/**
 * WP10 — the learning page's arithmetic.
 *
 * These are the functions that decide what a number LOOKS like, and a presentation
 * bug here is a claim bug: an e-value bar on a linear scale would show a halved
 * agent (e = 5.3 against a threshold of 20) as a quarter of the way to trouble, and
 * a Brier score printed without its coin-flip reference invites the reader to think
 * 0.24 is good. So the mapping is tested, not just the formatting.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentStatusTone,
  brierVerdict,
  calibrationVerdict,
  eBarFraction,
  eHalveFraction,
  formatEValue,
  formatPoints,
  formatProbability,
  formatR,
  journalKindLabel,
  killRuleStatus,
  refusalRows,
  regimeTone,
  weeklyHeadline,
} from "./learning";

test("L1 — the e-value bar is logarithmic, and the halve mark is where the threshold is", () => {
  assert.equal(eBarFraction(1), 0, "a fresh agent has no evidence against it");
  assert.equal(eBarFraction(0.4), 0, "an agent with evidence FOR it must not show a negative bar");
  assert.equal(eBarFraction(20), 1, "the disable threshold is a full bar");
  assert.ok(eBarFraction(50) === 1, "and it stays full past it");

  // The point of the log scale: e = 5 is a quarter of the way to e = 20, not a
  // quarter of a linear one — ln 5/ln 20 ≈ 0.537, and that is what the mark shows.
  const five = eBarFraction(5);
  assert.ok(Math.abs(five - 0.5372) < 0.001, `e=5 must sit at 53.7% of the bar, got ${five.toFixed(4)}`);
  assert.ok(Math.abs(eHalveFraction(5, 20) - five) < 1e-12, "the halve mark and the halve value must coincide");
  // Monotone, so a bigger e is always further along.
  assert.ok(eBarFraction(2) < eBarFraction(4) && eBarFraction(4) < eBarFraction(10));
});

test("L2 — statuses carry a label, a tone and an explanation", () => {
  for (const status of ["active", "halved", "disabled"] as const) {
    const tone = agentStatusTone(status);
    assert.ok(tone.label.length > 0);
    assert.ok(tone.className.includes("border-"));
    assert.ok(tone.blurb.length > 20, "each status must explain itself");
  }
  assert.equal(agentStatusTone("disabled").label, "disabled");
  assert.match(agentStatusTone("disabled").blurb, /disable threshold/);
  assert.notEqual(agentStatusTone("halved").className, agentStatusTone("active").className);
});

test("L3 — formatting keeps a sign, and an unknown stays an em dash", () => {
  assert.equal(formatR(0.4), "+0.40R");
  assert.equal(formatR(-0.4), "-0.40R");
  assert.equal(formatR(null), "—");
  assert.equal(formatProbability(0.5), "50.0%");
  assert.equal(formatProbability(null), "—");
  assert.equal(formatPoints(-9.5), "-9.5 pts");
  assert.equal(formatPoints(null), "—");
  assert.equal(formatEValue(1), "1.00");
  assert.equal(formatEValue(5.263), "5.26");
  assert.equal(formatEValue(0.0001), "<0.001");
  assert.equal(formatEValue(Number.NaN), "—");
});

test("L4 — calibration and Brier are judged against the brief's own bars", () => {
  assert.equal(calibrationVerdict(0).tone, "ok");
  assert.equal(calibrationVerdict(8).tone, "ok", "the bar is inclusive at 8 points");
  assert.equal(calibrationVerdict(8.1).tone, "warn");
  assert.match(calibrationVerdict(-12.4).label, /OVERCONFIDENT/);
  assert.match(calibrationVerdict(12.4).label, /UNDERCONFIDENT/);
  assert.equal(calibrationVerdict(null).tone, "unknown");

  // A Brier of exactly 0.25 is the coin-flip reference, so it is NOT good news.
  assert.equal(brierVerdict(0.24).tone, "ok");
  assert.equal(brierVerdict(0.25).tone, "warn");
  assert.equal(brierVerdict(0.31).tone, "warn");
  assert.equal(brierVerdict(null).tone, "unknown");
});

test("L5 — the refusal histogram is sorted, shared, and empty when nothing was refused", () => {
  const rows = refusalRows([
    { code: "PF_CVAR", count: 3 },
    { code: "GK_EV_LCB", count: 7 },
    { code: "GK_OK", count: 1 },
  ]);
  assert.deepEqual(
    rows.map((row) => row.code),
    ["GK_EV_LCB", "PF_CVAR", "GK_OK"],
  );
  const total = rows.reduce((a, row) => a + row.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-12, "the shares must be a distribution");
  assert.ok(Math.abs((rows[0]?.share ?? 0) - 7 / 11) < 1e-12);
  const empty = refusalRows([]);
  assert.deepEqual(empty, []);
  // Ties break alphabetically, so two runs of the same week cannot reorder.
  const tied = refusalRows([
    { code: "B", count: 2 },
    { code: "A", count: 2 },
  ]);
  assert.deepEqual(
    tied.map((row) => row.code),
    ["A", "B"],
  );
});

test("L6 — kill rules report an unknown as unknown, never as inside", () => {
  const unknown = killRuleStatus({ maxDrawdownPct: null, worstAgentE: null, meanSlippageR: null });
  assert.equal(unknown.length, 3);
  assert.ok(unknown.every((row) => row.breached === null));
  assert.match(unknown[0]?.detail ?? "", /has not reported/);

  const inside = killRuleStatus({ maxDrawdownPct: 4.2, worstAgentE: 3.1, meanSlippageR: 0.08 });
  assert.ok(inside.every((row) => row.breached === false));

  const breached = killRuleStatus({ maxDrawdownPct: 7.5, worstAgentE: 20.3, meanSlippageR: 0.21 });
  assert.ok(breached.every((row) => row.breached === true), "each of the brief's kill rules must fire on its own");
  // Boundary: exactly at the limit is inside, matching the brief's strict ">".
  const boundary = killRuleStatus({ maxDrawdownPct: 6, worstAgentE: 20, meanSlippageR: 0.15 });
  assert.deepEqual(
    boundary.map((row) => row.breached),
    [false, true, false],
  );
});

test("L7 — the headline and the kind labels never invent a number", () => {
  const headline = weeklyHeadline({
    trades: { closed: 4, measuredR: 3, unmeasured: 1, hitRate: 0.5, meanR: 0.33 },
    decisions: { evaluated: 40, armed: 9, refused: 31 },
  });
  assert.match(headline, /4 closed \(3 measured, 1 unmeasured\)/);
  assert.match(headline, /50\.0% hit/);
  assert.match(headline, /mean \+0\.33R/);
  assert.match(headline, /9\/40 decisions armed/);

  const unmeasuredOnly = weeklyHeadline({
    trades: { closed: 1, measuredR: 0, unmeasured: 1, hitRate: null, meanR: null },
    decisions: { evaluated: 2, armed: 0, refused: 2 },
  });
  assert.match(unmeasuredOnly, /no measured hit rate/);
  assert.match(unmeasuredOnly, /mean —/);

  assert.equal(journalKindLabel("no_trade"), "no trade");
  assert.equal(journalKindLabel("something_new"), "something_new", "an unknown kind is shown, not dropped");
  assert.ok(regimeTone("trend_up").includes("emerald"));
  assert.notEqual(regimeTone("trend_up"), regimeTone("trend_down"));
});
