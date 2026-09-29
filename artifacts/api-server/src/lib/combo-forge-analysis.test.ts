/**
 * Combo Forge analysis tests.
 *
 * The evidence maths exists twice on purpose: the vendored builder's plain-JS
 * module (what the running bot executes) and this typed port (what the forge
 * uses to tell the user, before building, what the gate can and cannot do).
 * These tests pin the two together on identical seeded tapes, then check the
 * statistical behaviour the console promises.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyseCombo,
  analyseComboGate,
  bernoulliKl,
  comboLabel,
  expandComboContracts,
  fairTape,
  mulberry32,
  parseComboContracts,
  recoveryAttempt,
  COMBO_FORGE_LIMITS,
  type ComboTape,
} from "./combo-forge-analysis";

const here = path.dirname(fileURLToPath(import.meta.url));
const JS_PATH = path.resolve(
  here,
  "../../../dbot-builder/src/external/bot-skeleton/services/tradeEngine/trade/combo-forge-analysis.js",
);
// The builder file is plain ESM JS inside a CJS-typed package: under tsx its
// exports surface on `.default` or on the namespace itself.
const loadJs = async (): Promise<any> => {
  const mod: any = await import(JS_PATH);
  return mod.default ?? mod;
};

function plantedDigits(n: number, rate: number, win: number, lose: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += rate;
    if (acc >= 1) { acc -= 1; out.push(win); } else out.push(lose);
  }
  return out;
}
function trendQuotes(n: number, upRate: number): number[] {
  const q: number[] = [];
  let x = 1000;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += upRate;
    if (acc >= 1) { acc -= 1; x += 0.01; } else x -= 0.01;
    q.push(Math.round(x * 100) / 100);
  }
  return q;
}

const close = (a: unknown, b: unknown, path_: string): void => {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    if (a === b) return;
    assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)), `${path_}: ${a} vs ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, `${path_}.length`);
    a.forEach((x, i) => close(x, b[i], `${path_}[${i}]`));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) close((a as any)[k], (b as any)[k], `${path_}.${k}`);
    return;
  }
  assert.equal(a, b, path_);
};

describe("combo-forge wire format", () => {
  it("parses TYPE:digit:payout entries, drops unknown types and caps at 12", () => {
    const specs = parseComboContracts("DIGITOVER:1:1.23, CALL:-1:1.92,BOGUS:1:2,DIGITDIFF:-1:1.09");
    assert.deepEqual(specs.map((s) => [s.type, s.digit, s.payout]), [
      ["DIGITOVER", 1, 1.23],
      ["CALL", -1, 1.92],
      ["DIGITDIFF", -1, 1.09],
    ]);
    assert.equal(parseComboContracts(Array.from({ length: 20 }, () => "DIGITEVEN:-1:1.95").join(",")).length, 12);
    assert.deepEqual(parseComboContracts(""), []);
  });
  it("falls back to a sane payout when the CSV payout is missing or ≤ 1", () => {
    const [a, b] = parseComboContracts("CALL:-1,DIGITEVEN:-1:0.5");
    assert.ok(a!.payout > 1 && b!.payout > 1);
  });
  it("expands auto Matches/Differs into ten concrete digits and leaves the rest alone", () => {
    const expanded = expandComboContracts(parseComboContracts("DIGITMATCH:-1:8.93,DIGITOVER:4:1.95,DIGITDIFF:3:1.09"));
    assert.equal(expanded.length, 12);
    assert.ok(expanded.filter((e) => e.type === "DIGITMATCH").every((e) => e.digit >= 0 && e.digit <= 9 && e.auto));
  });
  it("labels specs the way the console shows them", () => {
    assert.equal(comboLabel({ type: "CALL", digit: -1 }), "Rise");
    assert.equal(comboLabel({ type: "PUT", digit: -1 }), "Fall");
    assert.equal(comboLabel({ type: "DIGITOVER", digit: 4 }), "Over 4");
    assert.equal(comboLabel({ type: "DIGITMATCH", digit: -1 }), "Matches auto");
  });
});

describe("combo-forge shared recovery stake", () => {
  it("is debt×(1+markup)/(payout−1), floored at 0.35, capped, rounded UP to the cent, never above balance", () => {
    const base = { markupPercent: 10, maxStake: 500, balance: 1000, pWin: 0.5 };
    assert.equal(recoveryAttempt({ ...base, debt: 0.5, payout: 1.92 }).stake, 0.6); // 0.5978 → 0.60
    assert.equal(recoveryAttempt({ ...base, debt: 1.1, payout: 1.92 }).stake, 1.32); // 1.315 → 1.32
    assert.equal(recoveryAttempt({ ...base, debt: 0.01, payout: 1.95 }).stake, 0.35); // floor
    assert.equal(recoveryAttempt({ ...base, debt: 10000, payout: 1.95, balance: 100000 }).stake, 500); // cap
    const capped = recoveryAttempt({ ...base, debt: 300, payout: 1.23, maxStake: 10000, balance: 50 });
    assert.ok(capped.stake <= 50);
    assert.equal(capped.feasible, false); // staking ~all of the balance is not a recovery plan
  });
  it("divides by the payout of the contract PICKED — a 1.23× leg stakes far more than a 1.95× leg", () => {
    const base = { markupPercent: 10, maxStake: 500, balance: 1000, pWin: 0.8, debt: 2 };
    assert.ok(recoveryAttempt({ ...base, payout: 1.23 }).stake > 3 * recoveryAttempt({ ...base, payout: 1.95 }).stake);
  });
});

describe("combo-forge typed port ≡ vendored runtime module", () => {
  const scenarios: Array<{ name: string; tapes: ComboTape[]; contracts: string; mode: "NORMAL" | "RECOVERY"; strictness: string; debt: number }> = [];
  const fair = (seed: number, symbol: string) => fairTape(symbol, 500, mulberry32(seed));
  scenarios.push({
    name: "fair tapes, strict normal, digits + Rise/Fall",
    tapes: [fair(1, "R_10"), fair(2, "R_50")],
    contracts: "DIGITOVER:1:1.23,DIGITUNDER:8:1.23,CALL:-1:1.92,PUT:-1:1.92",
    mode: "NORMAL", strictness: "strict", debt: 0,
  });
  const planted = fair(3, "R_25");
  planted.digits = plantedDigits(500, 0.92, 9, 0);
  scenarios.push({
    name: "planted Over-1 edge, strict normal",
    tapes: [fair(4, "R_10"), planted],
    contracts: "DIGITOVER:1:1.23,DIGITEVEN:-1:1.95,DIGITMATCH:-1:8.93",
    mode: "NORMAL", strictness: "strict", debt: 0,
  });
  const trending = fair(5, "R_75");
  trending.quotes = trendQuotes(500, 0.75);
  scenarios.push({
    name: "uptrend Rise/Fall, balanced normal",
    tapes: [trending, fair(6, "R_50")],
    contracts: "CALL:-1:1.92,PUT:-1:1.92",
    mode: "NORMAL", strictness: "balanced", debt: 0,
  });
  scenarios.push({
    name: "recovery with debt, strict",
    tapes: [fair(7, "R_10"), fair(8, "R_50")],
    contracts: "DIGITEVEN:-1:1.95,DIGITOVER:4:1.95,PUT:-1:1.92",
    mode: "RECOVERY", strictness: "strict", debt: 3.5,
  });
  scenarios.push({
    name: "always mode, auto Differs",
    tapes: [fair(9, "R_10")],
    contracts: "DIGITDIFF:-1:1.09",
    mode: "NORMAL", strictness: "always", debt: 0,
  });

  for (const sc of scenarios) {
    it(`agrees on ${sc.name}`, async () => {
      const js = await loadJs();
      const args = {
        mode: sc.mode,
        strictness: sc.strictness,
        window: 500,
        rho: 0.15,
        debt: sc.debt,
        markupPercent: 10,
        maxStake: 500,
        balance: 1000,
        currentSymbol: sc.tapes[0]!.symbol,
      };
      const a = analyseCombo({ ...args, tapes: sc.tapes, contracts: parseComboContracts(sc.contracts) } as any);
      const b = js.analyseCombo({ ...args, tapes: sc.tapes, contracts: js.parseComboContracts(sc.contracts) });
      assert.ok(a.decision && b.decision);
      close(a.decision, b.decision, "decision");
      close(a.rows.map((r: any) => [r.symbol, r.contract, r.barrier, r.logE, r.score, r.eligible]),
            b.rows.map((r: any) => [r.symbol, r.contract, r.barrier, r.logE, r.score, r.eligible]), "rows");
      close(a.threshold, b.threshold, "threshold");
    });
  }
});

describe("combo-forge statistical behaviour", () => {
  it("holds on a fair tape (strict) and fires on a planted edge", () => {
    const contracts = parseComboContracts("DIGITOVER:1:1.23,DIGITUNDER:8:1.23,DIGITEVEN:-1:1.95,CALL:-1:1.92,PUT:-1:1.92");
    let fires = 0;
    const runs = 60;
    for (let i = 0; i < runs; i++) {
      const tape = fairTape("R_50", 500, mulberry32(1000 + i));
      const r = analyseCombo({ mode: "NORMAL", strictness: "strict", tapes: [tape], contracts, currentSymbol: "R_50", window: 500, rho: 0, debt: 0, markupPercent: 10, maxStake: 500, balance: 1000 });
      if (r.decision?.eligible) fires += 1;
    }
    assert.ok(fires <= 2, `strict fired on ${fires}/${runs} fair tapes`);

    const edge = fairTape("R_50", 500, mulberry32(77));
    edge.digits = plantedDigits(500, 0.92, 9, 0);
    const hit = analyseCombo({ mode: "NORMAL", strictness: "strict", tapes: [edge], contracts, currentSymbol: "R_50", window: 500, rho: 0, debt: 0, markupPercent: 10, maxStake: 500, balance: 1000 });
    assert.equal(hit.decision?.eligible, true);
    assert.equal(hit.decision?.contract, "DIGITOVER");
  });

  it("the evidence threshold rises with the number of candidates scanned (multiple-testing correction)", () => {
    const tape = fairTape("R_50", 500, mulberry32(5));
    const run = (contracts: string, tapes: ComboTape[]) =>
      analyseCombo({ mode: "NORMAL", strictness: "strict", tapes, contracts: parseComboContracts(contracts), currentSymbol: "R_50", window: 500, rho: 0, debt: 0, markupPercent: 10, maxStake: 500, balance: 1000 }).threshold;
    const few = run("DIGITOVER:1:1.23", [tape]);
    const many = run("DIGITOVER:1:1.23,DIGITEVEN:-1:1.95,DIGITMATCH:-1:8.93,CALL:-1:1.92", [tape, fairTape("R_10", 500, mulberry32(6))]);
    assert.ok(many > few + 1, `${many} vs ${few}`);
  });

  it("returns no decision — never a crash — when no tape is scoreable", () => {
    const r = analyseCombo({ mode: "NORMAL", strictness: "strict", tapes: [{ symbol: "R_10", digits: [1, 2, 3], quotes: [1, 2, 3] }], contracts: parseComboContracts("DIGITOVER:1:1.23"), currentSymbol: "R_10", window: 500, rho: 0, debt: 0, markupPercent: 10, maxStake: 500, balance: 100 });
    assert.equal(r.decision, null);
  });

  it("switch hysteresis: a near-equal tape elsewhere does not pull the bot off its market", () => {
    const a = fairTape("R_10", 500, mulberry32(21));
    const b = fairTape("R_50", 500, mulberry32(21)); // identical numbers, different symbol
    const r = analyseCombo({ mode: "NORMAL", strictness: "always", tapes: [b, a], contracts: parseComboContracts("DIGITEVEN:-1:1.95"), currentSymbol: "R_10", window: 500, rho: 0, debt: 0, markupPercent: 10, maxStake: 500, balance: 1000 });
    assert.equal(r.decision?.symbol, "R_10");
    assert.equal(r.decision?.changedMarket, false);
  });
});

describe("combo-forge forge-time gate diagnostics", () => {
  it("KL and detection time behave: a bigger edge is detected faster; Rise/Fall (4% margin) is slower than Over 1 at the same edge", () => {
    const [over1, rise] = analyseComboGate(
      parseComboContracts("DIGITOVER:1:1.23,CALL:-1:1.92"),
      { window: 500, strictness: "strict", candidates: 12, tapes: 20 },
    );
    const t = (r: typeof over1, edge: number) => r!.ticksToDetect.find((x) => x.edge === edge)!.ticks ?? Infinity;
    const ideal = (r: typeof over1, edge: number) => r!.ticksToDetect.find((x) => x.edge === edge)!.idealTicks!;
    assert.ok(t(over1, 0.03) >= t(over1, 0.06) && t(over1, 0.06) > t(over1, 0.1));
    assert.ok(t(rise!, 0.06) >= t(over1!, 0.06));
    // The real gate pays a learning cost over the known-rate floor — never better than it.
    for (const r of [over1!, rise!]) for (const edge of [0.06, 0.1]) assert.ok(t(r, edge) >= ideal(r, edge) * 0.9, `${r.label} +${edge}`);
    assert.ok(Math.abs(over1!.margin - 0.016) < 1e-9);
    assert.ok(Math.abs(rise!.margin - 0.04) < 1e-9);
  });
  it("strict fair-tape false fire is ≈ 0, always is ≈ 1 (by construction)", () => {
    const [strict] = analyseComboGate(parseComboContracts("DIGITEVEN:-1:1.95"), { window: 300, strictness: "strict", candidates: 4, tapes: 60 });
    const [always] = analyseComboGate(parseComboContracts("DIGITEVEN:-1:1.95"), { window: 300, strictness: "always", candidates: 4, tapes: 60 });
    assert.ok(strict!.fairFalseFire <= 0.05);
    assert.equal(always!.fairFalseFire, 1);
  });
  it("is deterministic", () => {
    const run = () => analyseComboGate(parseComboContracts("DIGITOVER:2:1.35"), { window: 200, strictness: "balanced", candidates: 6, tapes: 30 });
    assert.deepEqual(run(), run());
  });
  it("bernoulliKl is zero at equality and positive otherwise", () => {
    assert.ok(Math.abs(bernoulliKl(0.4, 0.4)) < 1e-12);
    assert.ok(bernoulliKl(0.6, 0.4) > 0);
    assert.ok(COMBO_FORGE_LIMITS.alpha.strict < COMBO_FORGE_LIMITS.alpha.balanced);
  });
});
