/**
 * The auto-trader settings: what the owner may set, what the desk does with it.
 *
 * The bar these tests hold is the one in the report — "every setting must be
 * respected". So they do not merely check that the model round-trips: they
 * check that a setting REACHES EXECUTION.
 *
 *   S1–S8   the model: defaults, presets per mode, sanitising, clamps
 *   S9–S13  resolution: risk per trade, fingerprints, style honesty
 *   S14–S20 the plan the EA receives: every management field is the owner's
 *   S21–S24 the 1R guarantees: a blocked ladder still de-risks, structure has
 *           a deadline, nothing at 1R is left to chance
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_TRADE_SETTINGS_VERSION,
  MANAGEMENT_PRESETS,
  RANGES,
  TRADE_MODES_ALL,
  defaultAutoTradeSettings,
  managementFingerprint,
  matchesPreset,
  presetFor,
  resolveModePolicy,
  riskPolicyFromSettings,
  sanitiseAutoTradeSettings,
} from "./desk-settings";
import { buildManagementPlan } from "./agent";
import { BREAKEVEN_STRUCTURE_FALLBACK_R, managePosition } from "./position-manager";
import type { Bar, Side, SymbolSpec, Timeframe, TradeMode } from "./types";

const SPEC: SymbolSpec = {
  symbol: "EURUSD",
  assetClass: "forex",
  point: 0.00001,
  digits: 5,
  tickSize: 0.00001,
  tickValue: 1,
  contractSize: 100_000,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  marginInitial: 0,
  swapLong: 0,
  swapShort: 0,
  commissionPerLot: 0,
  spreadPoints: 10,
};

// ── S1: defaults are a complete, valid policy ───────────────────────────────

test("S1 defaults are complete: every mode, every knob, and they validate against themselves", () => {
  const settings = defaultAutoTradeSettings();
  assert.equal(settings.version, AUTO_TRADE_SETTINGS_VERSION);
  for (const mode of TRADE_MODES_ALL) {
    const entry = settings.perMode[mode];
    assert.ok(entry, `${mode} has a policy`);
    assert.equal(entry.style, "balanced");
    assert.ok(entry.riskPerTradePct > 0);
    assert.ok(entry.management.breakeven.triggerR > 0);
    assert.ok(entry.management.trail.mult > 0);
    assert.ok(entry.management.timeStop.noProgressBars > 0);
  }
  // Round-tripping the defaults through the sanitiser changes nothing: if it
  // did, the factory policy would not survive its own validation.
  const again = sanitiseAutoTradeSettings(settings, settings, settings.updatedAt);
  assert.deepEqual(again.perMode, settings.perMode);
  assert.deepEqual(again.risk, settings.risk);
});

// ── S2: the presets are mode-specific ───────────────────────────────────────

test("S2 every mode has all three styles, and they are genuinely different policies", () => {
  for (const mode of TRADE_MODES_ALL) {
    const { conservative, balanced, aggressive } = MANAGEMENT_PRESETS[mode];
    assert.ok(conservative && balanced && aggressive, `${mode} has all three styles`);
    // Aggressive de-risks strictly earlier than conservative — that is what the
    // word means, and it is the property an owner is choosing between.
    assert.ok(
      aggressive.breakeven.triggerR < conservative.breakeven.triggerR,
      `${mode}: aggressive break-even (${aggressive.breakeven.triggerR}R) before conservative (${conservative.breakeven.triggerR}R)`,
    );
    assert.ok(
      aggressive.partials.rungs[0].atR <= conservative.partials.rungs[0].atR,
      `${mode}: aggressive banks its first partial no later than conservative`,
    );
    assert.ok(
      aggressive.trail.activateAtR <= conservative.trail.activateAtR,
      `${mode}: aggressive trails no later than conservative`,
    );
    assert.ok(
      aggressive.trail.mult <= conservative.trail.mult,
      `${mode}: aggressive trails tighter than conservative`,
    );
  }
});

test("S3 the SAME style differs per mode — a scalp aggressive is not an intraday aggressive", () => {
  const scalpAggressive = MANAGEMENT_PRESETS.scalp.aggressive;
  const intradayAggressive = MANAGEMENT_PRESETS.intraday.aggressive;
  const swingAggressive = MANAGEMENT_PRESETS.swing.aggressive;
  assert.notDeepEqual(scalpAggressive, intradayAggressive);
  assert.notDeepEqual(intradayAggressive, swingAggressive);
  // A scalp must bank earlier than a swing, in every style: the horizon differs.
  assert.ok(scalpAggressive.partials.rungs[0].atR < swingAggressive.partials.rungs[0].atR);
  // And a swing is allowed to hold: no time stop by default on either policy.
  assert.equal(swingAggressive.timeStop.enabled, false);
  assert.equal(MANAGEMENT_PRESETS.swing.conservative.timeStop.enabled, false);
  assert.equal(scalpAggressive.timeStop.enabled, true);
});

// ── S4–S7: sanitising ───────────────────────────────────────────────────────

test("S4 a preset chosen without edits is adopted wholesale", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    perMode: { scalp: { style: "aggressive" } },
  });
  assert.equal(settings.perMode.scalp.style, "aggressive");
  assert.deepEqual(settings.perMode.scalp.management, presetFor("scalp", "aggressive"));
  // Untouched modes keep their own policy.
  assert.equal(settings.perMode.intraday.style, "balanced");
});

test("S5 an edited policy is recorded as custom, never mislabelled as a preset", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    perMode: { intraday: { style: "balanced", management: { breakeven: { triggerR: 0.4 } } } },
  });
  assert.equal(settings.perMode.intraday.style, "custom");
  assert.equal(settings.perMode.intraday.management.breakeven.triggerR, 0.4);
  assert.equal(matchesPreset("intraday", "balanced", settings.perMode.intraday.management), false);
});

test("S6 every number is clamped to its documented range, and nonsense is ignored", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    risk: {
      riskPerTradePct: 999,
      maxDailyLossPct: -5,
      maxOpenPositions: 10_000,
      sizingMode: "quadruple",
      liveTradingEnabled: "yes",
    },
    perMode: {
      scalp: {
        management: {
          breakeven: { triggerR: 500, structureFallbackR: -3 },
          trail: { mult: 0, activateAtR: "abc", minStepAtr: 99 },
          timeStop: { noProgressBars: 0, timeframe: "M7" },
          guards: { newsBlackoutMin: 100_000 },
        },
      },
    },
  });
  assert.equal(settings.risk.riskPerTradePct, RANGES.riskPerTradePct[1]);
  assert.equal(settings.risk.maxDailyLossPct, RANGES.maxDailyLossPct[0]);
  assert.equal(settings.risk.maxOpenPositions, RANGES.maxOpenPositions[1]);
  assert.equal(settings.risk.sizingMode, "percent");
  assert.equal(settings.risk.liveTradingEnabled, true);

  const scalp = settings.perMode.scalp.management;
  assert.equal(scalp.breakeven.triggerR, RANGES.triggerR[1]);
  assert.equal(scalp.breakeven.structureFallbackR, RANGES.structureFallbackR[0]);
  assert.equal(scalp.trail.mult, RANGES.trailMult[0]);
  assert.equal(scalp.trail.activateAtR, MANAGEMENT_PRESETS.scalp.balanced.trail.activateAtR); // kept
  assert.equal(scalp.trail.minStepAtr, RANGES.trailMinStepAtr[1]);
  assert.equal(scalp.timeStop.noProgressBars, RANGES.timeStopBars[0]);
  // An unknown timeframe keeps the previous one rather than inventing a frame.
  assert.equal(scalp.timeStop.timeframe, null);
  assert.equal(scalp.guards.newsBlackoutMin, RANGES.newsBlackoutMin[1]);
});

test("S7 unknown keys and wrong types are dropped, never thrown on", () => {
  const before = defaultAutoTradeSettings();
  for (const payload of [null, "nonsense", 42, [], { perMode: [] }, { perMode: { scalp: 7 } }]) {
    const after = sanitiseAutoTradeSettings(before, payload, before.updatedAt);
    assert.deepEqual(after.perMode, before.perMode);
    assert.deepEqual(after.risk, before.risk);
  }
  const withJunk = sanitiseAutoTradeSettings(before, {
    perMode: { scalp: { management: { pyramid: { maxAdds: 2, nonsense: 1 }, unknown: true } } },
  });
  assert.equal(withJunk.perMode.scalp.management.pyramid.maxAdds, 2);
  assert.equal(
    Object.prototype.hasOwnProperty.call(withJunk.perMode.scalp.management.pyramid, "nonsense"),
    false,
  );
});

test("S8 a partial ladder is ordered, capped at four rungs and never banks more than 100%", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    perMode: {
      swing: {
        management: {
          partials: {
            enabled: true,
            rungs: [
              { atR: 2.5, closePct: 40 },
              { atR: 1.0, closePct: 60 },
              { atR: 3.0, closePct: 50 },
              { atR: 4.0, closePct: 50 },
              { atR: 5.0, closePct: 50 },
            ],
          },
        },
      },
    },
  });
  const rungs = settings.perMode.swing.management.partials.rungs;
  // Sorted by R (not by the order they arrived in), and the ladder stops as
  // soon as it has banked the whole position: 60% at 1R + 40% at 2.5R is
  // already the entire position, so the later rungs are dropped rather than
  // trimmed into percentages nobody asked for.
  assert.deepEqual(rungs, [
    { atR: 1.0, closePct: 60 },
    { atR: 2.5, closePct: 40 },
  ]);
  const total = rungs.reduce((sum, r) => sum + r.closePct, 0);
  assert.equal(total, 100);

  // Four rungs that DO fit are all kept, in R order.
  const four = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    perMode: {
      swing: {
        management: {
          partials: {
            enabled: true,
            rungs: [
              { atR: 4.0, closePct: 10 },
              { atR: 1.0, closePct: 25 },
              { atR: 3.0, closePct: 20 },
              { atR: 2.0, closePct: 25 },
            ],
          },
        },
      },
    },
  });
  assert.deepEqual(four.perMode.swing.management.partials.rungs.map((r) => r.atR), [1, 2, 3, 4]);
});

// ── S9–S13: resolution ──────────────────────────────────────────────────────

test("S9 the per-mode risk budget is what sizing gets, capped by the global ceiling", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    risk: { maxRiskPct: 0.6 },
    perMode: { scalp: { riskPerTradePct: 0.4 }, swing: { riskPerTradePct: 1.5 } },
  });
  // scalp: 0.4 requested, ceiling 0.6 → 0.4
  assert.equal(resolveModePolicy(settings, "scalp").riskPct, 0.4);
  // swing: 1.5 requested, ceiling 0.6 → 0.6 (the ceiling wins, always)
  assert.equal(resolveModePolicy(settings, "swing").riskPct, 0.6);
});

test("S10 the desk's own risk gates are DERIVED from the settings, not kept beside them", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    risk: { riskPerTradePct: 0.25, maxDailyLossPct: 1.5, maxOpenPositions: 4 },
  });
  const policy = riskPolicyFromSettings(settings);
  assert.equal(policy.baseRiskPct, 0.25);
  assert.equal(policy.maxDailyLossPct, 1.5);
  assert.equal(policy.maxOpenPositions, 4);
});

test("S11 the fingerprint covers every field that changes execution", () => {
  const base = defaultAutoTradeSettings();
  const fingerprint = managementFingerprint(base, "intraday");
  const tweaks: Array<Record<string, unknown>> = [
    { perMode: { intraday: { riskPerTradePct: 0.9 } } },
    { perMode: { intraday: { management: { breakeven: { triggerR: 0.2 } } } } },
    { perMode: { intraday: { management: { partials: { rungs: [{ atR: 0.5, closePct: 25 }] } } } } },
    { perMode: { intraday: { management: { trail: { activateAtR: 0.3 } } } } },
    { perMode: { intraday: { management: { trail: { mult: 9 } } } } },
    { perMode: { intraday: { management: { timeStop: { noProgressBars: 3 } } } } },
    { perMode: { intraday: { management: { pyramid: { maxAdds: 4 } } } } },
    { perMode: { intraday: { management: { guards: { newsBlackoutMin: 60 } } } } },
  ];
  for (const patch of tweaks) {
    const changed = sanitiseAutoTradeSettings(base, patch);
    assert.notEqual(
      managementFingerprint(changed, "intraday"),
      fingerprint,
      `fingerprint must change for ${JSON.stringify(patch)}`,
    );
  }
  // And a policy that did not change keeps the same fingerprint, so the
  // heartbeat does not re-send anything.
  assert.equal(managementFingerprint(sanitiseAutoTradeSettings(base, { perMode: { scalp: { style: "aggressive" } } }), "intraday"), fingerprint);
});

// ── S14–S20: the owner's policy is the plan the EA receives ────────────────

function planWith(settings: ReturnType<typeof defaultAutoTradeSettings>, mode: TradeMode, lots = 1) {
  return buildManagementPlan({
    spec: SPEC,
    mode,
    lots,
    regimeKind: "trend_up",
    atrPoints: 150,
    retraceProbability: 0.2,
    settings: resolveModePolicy(settings, mode).management,
  });
}

test("S14 every management field of the plan is the owner's value", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    perMode: {
      intraday: {
        management: {
          breakeven: { enabled: true, triggerR: 1.7, offsetR: 0.4, requireStructure: false, structureFallbackR: 0.2 },
          partials: { enabled: true, rungs: [{ atR: 1.1, closePct: 40 }, { atR: 2.2, closePct: 30 }] },
          trail: { enabled: true, mode: "structure", period: 21, mult: 3.3, activateAtR: 2.4, stepPoints: 7, minStepAtr: 0.2 },
          pyramid: { enabled: true, maxAdds: 3, addAtR: 2.0, sizeRatio: 0.75, requireBaseAtBreakeven: false, portfolioRiskCapR: 2.5 },
          timeStop: { enabled: true, noProgressBars: 42, timeframe: "M30" },
          guards: { maxSpreadPoints: 33, newsBlackoutMin: 25, flatBeforeSessionClose: false },
        },
      },
    },
  });
  const plan = planWith(settings, "intraday");
  assert.deepEqual(plan.breakeven, {
    triggerR: 1.7,
    offsetR: 0.4,
    structureBuffer: false,
    structureFallbackR: 0.2,
  });
  assert.deepEqual(plan.partials, [{ atR: 1.1, closePct: 40 }, { atR: 2.2, closePct: 30 }]);
  assert.deepEqual(plan.trail, { mode: "structure", period: 21, mult: 3.3, activateAtR: 2.4, stepPoints: 7 });
  assert.deepEqual(plan.pyramid, {
    maxAdds: 3,
    addAtR: 2.0,
    sizeRatio: 0.75,
    requireBaseAtBreakeven: false,
    portfolioRiskCapR: 2.5,
  });
  assert.deepEqual(plan.timeStop, { noProgressBars: 42, timeframe: "M30" });
  assert.equal(plan.guards.maxSpreadPoints, 33);
  assert.equal(plan.guards.newsBlackoutMin, 25);
  assert.equal(plan.guards.flatBeforeSessionClose, false);
});

test("S15 switching a rule OFF removes it from the plan", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    perMode: {
      swing: {
        management: {
          breakeven: { enabled: false },
          partials: { enabled: false },
          trail: { enabled: false },
          pyramid: { enabled: false },
          timeStop: { enabled: false },
        },
      },
    },
  });
  const plan = planWith(settings, "swing");
  assert.equal(plan.breakeven, null);
  assert.deepEqual(plan.partials, []);
  assert.equal(plan.trail, null);
  assert.equal(plan.pyramid, null);
  assert.equal(plan.timeStop, null);
});

test("S16 'auto' spread guard means the desk's own number, not no guard", () => {
  const settings = defaultAutoTradeSettings();
  const auto = planWith(settings, "scalp");
  assert.ok((auto.guards.maxSpreadPoints ?? 0) > 0);
  const pinned = sanitiseAutoTradeSettings(settings, { perMode: { scalp: { management: { guards: { maxSpreadPoints: 12 } } } } });
  assert.equal(planWith(pinned, "scalp").guards.maxSpreadPoints, 12);
});

test("S17 the legacy path is unchanged when no settings are supplied", () => {
  const legacy = buildManagementPlan({
    spec: SPEC,
    mode: "intraday",
    lots: 1,
    regimeKind: "trend_up",
    atrPoints: 150,
    retraceProbability: 0.2,
  });
  assert.equal(legacy.breakeven?.triggerR, 1.2);
  assert.deepEqual(legacy.partials, [{ atR: 1.5, closePct: 35 }, { atR: 3.0, closePct: 25 }]);
  assert.equal(legacy.trail?.mult, 2.5);
  assert.equal(legacy.partialsDeferredToBreakeven, false);
  // The structure deadline is present on the legacy path too: it is the fix for
  // "1R in profit and nothing happened", and it must not depend on the owner
  // having opened the settings screen.
  assert.equal(legacy.breakeven?.structureFallbackR, BREAKEVEN_STRUCTURE_FALLBACK_R);
});

test("S18 a ladder the broker cannot express becomes a break-even at the same R", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), {
    perMode: {
      intraday: {
        management: {
          breakeven: { enabled: true, triggerR: 1.6, offsetR: 0.2, requireStructure: true },
          partials: { enabled: true, rungs: [{ atR: 1.0, closePct: 50 }, { atR: 2.0, closePct: 25 }] },
        },
      },
    },
  });
  // 0.01 lots cannot be halved at a 0.01 step.
  const plan = planWith(settings, "intraday", 0.01);
  assert.deepEqual(plan.partials, []);
  assert.equal(plan.partialsDeferredToBreakeven, true);
  assert.equal(plan.breakeven?.triggerR, 1.0, "break-even takes over the first rung's R");
  assert.equal(plan.breakeven?.structureBuffer, false, "nothing is left waiting on structure when the ladder is blocked");
  // The same policy on a size that CAN be split keeps both rungs.
  const split = planWith(settings, "intraday", 1);
  assert.deepEqual(split.partials, [{ atR: 1.0, closePct: 50 }, { atR: 2.0, closePct: 25 }]);
  assert.equal(split.partialsDeferredToBreakeven, false);
  assert.equal(split.breakeven?.triggerR, 1.6);
});

// ── S19–S24: the 1R guarantees, in the state machine ────────────────────────

function barsFlat(count: number, price: number): Bar[] {
  return Array.from({ length: count }, (_, index) => [1_700_000_000_000 + index * 60_000, price, price, price, price, 1] as Bar);
}

test("S19 break-even fires on the R trigger alone once the structure deadline passes", () => {
  // A flat, rising series that never prints a confirmed fractal pivot below the
  // entry — exactly the case that used to leave the stop untouched forever.
  const bars = barsFlat(30, 1.1000);
  const side: Side = "buy";
  const entry = 1.1000;
  const state = {
    ticket: 1,
    planId: "p",
    symbol: "EURUSD",
    side,
    mode: "intraday" as TradeMode,
    entryTimeframe: "M15" as Timeframe,
    entry,
    initialSl: 1.0950,
    sl: 1.0950,
    tp: null,
    riskPrice: 0.005,
    volume: 1,
    initialVolume: 1,
    openedAt: 1_700_000_000_000,
    barsSinceEntry: 1,
    progressR: 0,
    mfeR: 0,
    bestPrice: entry,
    stage: "OPEN_RISK" as const,
    partialsDone: 0,
    beDone: false,
    trailArmed: false,
    pyramidAdds: 0,
    closedVolume: 0,
    costPrice: 0.0001,
    atrEntry: 0.0015,
    lastModifyAt: 0,
    lastModifyR: 0,
  };

  const policy = {
    breakeven: { triggerR: 1.0, offsetR: 0.2, structureBuffer: true },
    partials: [],
    trail: null,
    pyramid: null,
    timeStop: null,
    guards: { maxSpreadPoints: 30, newsBlackoutMin: 15, flatBeforeSessionClose: false },
    requireStructure: true,
    structureFallbackR: BREAKEVEN_STRUCTURE_FALLBACK_R,
  };

  // At the trigger, with structure unconfirmed, nothing moves yet.
  const atTrigger = managePosition({
    state: { ...state, progressR: 1.0, mfeR: 1.0 },
    quote: { bid: entry + 0.005, ask: entry + 0.0051, ts: Date.now() },
    bars,
    spec: { point: SPEC.point, digits: SPEC.digits, volumeMin: 0.01, volumeStep: 0.01, stopsLevel: 0, freezeLevel: 0 },
    atrEntry: 0.0015,
    policy,
    now: Date.now(),
  });
  assert.equal(atTrigger.actions.some((a) => a.kind === "modify_sl"), false);
  assert.ok(atTrigger.notes.some((note) => note.includes("structure")), "the deferral is recorded, not silent");

  // Past the deadline, the stop moves anyway and the reason says why.
  const pastDeadline = managePosition({
    state: { ...state, progressR: 1.0 + BREAKEVEN_STRUCTURE_FALLBACK_R + 0.01, mfeR: 1.5 },
    quote: { bid: entry + 0.008, ask: entry + 0.0081, ts: Date.now() },
    bars,
    spec: { point: SPEC.point, digits: SPEC.digits, volumeMin: 0.01, volumeStep: 0.01, stopsLevel: 0, freezeLevel: 0 },
    atrEntry: 0.0015,
    policy,
    now: Date.now(),
  });
  const modify = pastDeadline.actions.find((a) => a.kind === "modify_sl");
  assert.ok(modify, "the stop moves once the structure deadline passes");
  assert.ok(modify.reason.includes("deadline"));
  assert.ok(pastDeadline.state.beDone);
});

test("S20 `structureFallbackR: 0` means wait for structure, exactly as before", () => {
  const bars = barsFlat(30, 1.1000);
  const entry = 1.1000;
  const result = managePosition({
    state: {
      ticket: 2, planId: "p2", symbol: "EURUSD", side: "buy" as Side, mode: "intraday" as TradeMode,
      entryTimeframe: "M15" as Timeframe, entry, initialSl: 1.0950, sl: 1.0950, tp: null,
      riskPrice: 0.005, volume: 1, initialVolume: 1, openedAt: 1_700_000_000_000, barsSinceEntry: 1,
      progressR: 5, mfeR: 5, bestPrice: entry + 0.025, stage: "OPEN_RISK" as const, partialsDone: 0,
      beDone: false, trailArmed: false, pyramidAdds: 0, closedVolume: 0, costPrice: 0.0001,
      atrEntry: 0.0015, lastModifyAt: 0, lastModifyR: 0,
    },
    quote: { bid: entry + 0.025, ask: entry + 0.0251, ts: Date.now() },
    bars,
    spec: { point: SPEC.point, digits: SPEC.digits, volumeMin: 0.01, volumeStep: 0.01, stopsLevel: 0, freezeLevel: 0 },
    atrEntry: 0.0015,
    policy: {
      breakeven: { triggerR: 1.0, offsetR: 0.2, structureBuffer: true },
      partials: [], trail: null, pyramid: null, timeStop: null,
      guards: { maxSpreadPoints: 30, newsBlackoutMin: 15, flatBeforeSessionClose: false },
      requireStructure: true,
      structureFallbackR: 0,
    },
    now: Date.now(),
  });
  assert.equal(result.actions.some((a) => a.kind === "modify_sl"), false);
});

test("S21 the settings version is on the value, so a shape change is detectable", () => {
  const settings = sanitiseAutoTradeSettings(defaultAutoTradeSettings(), { perMode: { scalp: { style: "aggressive" } } });
  assert.equal(settings.version, AUTO_TRADE_SETTINGS_VERSION);
  assert.ok(settings.updatedAt > 0);
});
