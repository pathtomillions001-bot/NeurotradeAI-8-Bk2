/**
 * Digit Forge → Deriv DBot strategy generator.
 *
 * Pins the contract the "Create DBot" button relies on: the generated workspace
 * is stock Deriv-Bot Blockly XML that (a) trades the chosen market and barriers,
 * (b) carries the session's stake / TP / SL, (c) implements the shared bot
 * recovery maths, (d) computes its OWN entry gate in-workspace, and (e) uses
 * only block types the vendored builder registers — `load()` rejects the whole
 * workspace when it meets one unknown type.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DIGIT_FORGE_BLOCK_TYPES,
  DIGIT_FORGE_NORMAL_CONTRACTS,
  DIGIT_FORGE_RECOVERY_CONTRACTS,
  buildDigitForgeStrategy,
  expectedMaxRun,
  fairWinRate,
  ladderRisk,
  type DigitForgeInput,
} from "./digit-forge-dbot.ts";

// The standalone builder is a CommonJS package; tsx exposes its JS module as default.
import digitForgeRuntimePolicy from "../../../dbot-builder/src/external/bot-skeleton/services/tradeEngine/trade/digit-forge-contracts.js";
const { DIGIT_FORGE_CONTRACTS, isDigitForgeContract } = digitForgeRuntimePolicy;

function baseInput(overrides: Partial<DigitForgeInput> = {}): DigitForgeInput {
  return {
    symbol: "R_50",
    displayName: "Volatility 50 Index",
    normal: { side: "DIGITOVER", barrier: 2 },
    recovery: { side: "DIGITOVER", barrier: 5 },
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    markupPercent: 10,
    maxStake: 500,
    normalPayout: 1.4,
    recoveryPayout: 2.43,
    breakerDepth: 6,
    currency: "USD",
    ...overrides,
  };
}

function blockTypes(xml: string): string[] {
  return [...xml.matchAll(/<block type="([^"]+)"/g)].map((m) => m[1]!);
}

function shadowTypes(xml: string): string[] {
  return [...xml.matchAll(/<shadow type="([^"]+)"/g)].map((m) => m[1]!);
}

function attr(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map(
    (m) => m[1]!,
  );
}

/** Field values of the first block of `type`. */
function fieldsOf(xml: string, type: string): Record<string, string> {
  const open = xml.indexOf(`<block type="${type}"`);
  assert.ok(open >= 0, `missing block ${type}`);
  const slice = xml.slice(open, xml.indexOf("<block", open + 1));
  return Object.fromEntries(
    [...slice.matchAll(/<field name="([^"]+)">([^<]*)<\/field>/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );
}

describe("Digit Forge contract policy parity", () => {
  it("has exactly the same strict normal/recovery pairs in the API and the runtime purchase guard", () => {
    for (const [mode, contracts] of [
      ["NORMAL", DIGIT_FORGE_NORMAL_CONTRACTS],
      ["RECOVERY", DIGIT_FORGE_RECOVERY_CONTRACTS],
    ] as const) {
      assert.deepEqual(
        DIGIT_FORGE_CONTRACTS[mode].map((c: { contract: string; barrier: number }) => ({ side: c.contract, barrier: c.barrier })),
        contracts,
      );
      for (const side of ["DIGITOVER", "DIGITUNDER"]) {
        for (let barrier = 0; barrier <= 9; barrier++) {
          const allowed = contracts.some(c => c.side === side && c.barrier === barrier);
          assert.equal(isDigitForgeContract(mode, side, barrier), allowed);
          const input = baseInput(mode === "NORMAL"
            ? { normal: { side: side as "DIGITOVER" | "DIGITUNDER", barrier } }
            : { recovery: { side: side as "DIGITOVER" | "DIGITUNDER", barrier } });
          if (allowed) assert.doesNotThrow(() => buildDigitForgeStrategy(input));
          else assert.throws(() => buildDigitForgeStrategy(input), /must be one of/);
        }
      }
    }
  });
});

describe("buildDigitForgeStrategy", () => {
  it("emits a workspace whose every block and shadow is a stock builder block", () => {
    const { xml } = buildDigitForgeStrategy(baseInput());
    assert.ok(xml.startsWith("<xml "), "root must be <xml>");
    assert.match(xml, /is_dbot="true"/);

    const allowed = new Set<string>(DIGIT_FORGE_BLOCK_TYPES);
    for (const type of new Set([...blockTypes(xml), ...shadowTypes(xml)])) {
      assert.ok(allowed.has(type), `unexpected block type ${type}`);
    }
  });

  it("emits each Deriv root scope exactly once", () => {
    const { xml } = buildDigitForgeStrategy(baseInput());
    const types = blockTypes(xml);
    for (const root of [
      "trade_definition",
      "before_purchase",
      "after_purchase",
    ]) {
      assert.equal(types.filter((t) => t === root).length, 1, root);
    }
    // Two procedures: the gate and the recovery ladder.
    assert.equal(types.filter((t) => t === "procedures_defnoreturn").length, 2);
  });

  it("produces well-formed XML with unique block ids and declared variables", () => {
    const { xml } = buildDigitForgeStrategy(baseInput());
    assert.equal(
      (xml.match(/<block /g) ?? []).length,
      (xml.match(/<\/block>/g) ?? []).length,
    );
    assert.equal(
      (xml.match(/<statement /g) ?? []).length,
      (xml.match(/<\/statement>/g) ?? []).length,
    );
    assert.equal(
      (xml.match(/<value /g) ?? []).length,
      (xml.match(/<\/value>/g) ?? []).length,
    );

    const ids = attr(xml, "id").filter((id) => !id.startsWith("ntv"));
    assert.equal(new Set(ids).size, ids.length, "block ids must be unique");

    // Every variable referenced by a get/set is declared in <variables>.
    const declared = new Set(
      [...xml.matchAll(/<variable id="([^"]+)">([^<]+)<\/variable>/g)].map(
        (m) => m[2]!,
      ),
    );
    const used = new Set(
      [...xml.matchAll(/<field name="VAR" id="[^"]+">([^<]+)<\/field>/g)].map(
        (m) => m[1]!,
      ),
    );
    for (const name of used)
      assert.ok(declared.has(name), `undeclared variable ${name}`);
  });

  it("pins the trade definition Deriv requires (order, market path, both contract types)", () => {
    const { xml } = buildDigitForgeStrategy(baseInput({ symbol: "R_100" }));
    const order = blockTypes(xml).filter((t) =>
      t.startsWith("trade_definition"),
    );
    assert.deepEqual(order, [
      "trade_definition",
      "trade_definition_market",
      "trade_definition_tradetype",
      "trade_definition_contracttype",
      "trade_definition_candleinterval",
      "trade_definition_restartbuysell",
      "trade_definition_restartonerror",
      "trade_definition_tradeoptions",
    ]);
    assert.deepEqual(fieldsOf(xml, "trade_definition_market"), {
      MARKET_LIST: "synthetic_index",
      SUBMARKET_LIST: "random_index",
      SYMBOL_LIST: "R_100",
    });
    assert.deepEqual(fieldsOf(xml, "trade_definition_tradetype"), {
      TRADETYPECAT_LIST: "digits",
      TRADETYPE_LIST: "overunder",
    });
    // "both" is mandatory: one bot buys DIGITOVER normally and DIGITUNDER in
    // recovery, and `purchase` may only name a declared contract type.
    assert.equal(
      fieldsOf(xml, "trade_definition_contracttype").TYPE_LIST,
      "both",
    );
    assert.equal(fieldsOf(xml, "trade_definition_restartonerror").RESTARTONERROR, "FALSE",
      "an ambiguous buy error must not automatically restart/replay the trade");
    // The six children may not be dragged out or deleted by the user.
    assert.equal(
      (xml.match(/deletable="false" movable="false"/g) ?? []).length,
      6,
    );
  });

  it("keeps the trade options UNCONDITIONAL (else the interpreter spins forever)", () => {
    const { xml } = buildDigitForgeStrategy(baseInput());
    const submarket = xml.slice(xml.indexOf('<statement name="SUBMARKET">'));
    const optionsAt = submarket.indexOf(
      '<block type="trade_definition_tradeoptions"',
    );
    const ifAt = submarket.indexOf('<block type="controls_if"');
    assert.ok(optionsAt >= 0, "trade options must be emitted");
    assert.ok(
      ifAt === -1 || optionsAt < ifAt,
      "trade options must not sit inside a conditional — BinaryBotPrivateHasCalledTradeOptions would stay false",
    );
  });

  it("binds the whole decision and current stake instead of issuing a side-only stock purchase", () => {
    const { xml } = buildDigitForgeStrategy(
      baseInput({
        normal: { side: "DIGITOVER", barrier: 2 },
        recovery: { side: "DIGITUNDER", barrier: 4 },
      }),
    );
    assert.doesNotMatch(xml, /<block type="purchase"/);
    const before = xml.slice(xml.indexOf('<block type="before_purchase"'), xml.indexOf('<block type="after_purchase"'));
    const quote = before.indexOf('<block type="nt_prepare_digit_trade"');
    const size = before.indexOf('<mutation name="Size recovery stake">');
    const buy = before.indexOf('<block type="nt_purchase_digit_trade"');
    assert.ok(quote >= 0 && size > quote && buy > size, "quote the selected tuple BEFORE sizing and buying");
    for (const value of ["IN_RECOVERY", "SYMBOL", "CONTRACT", "BARRIER", "AMOUNT", "MAX_STAKE"]) {
      assert.ok(before.slice(buy).includes(`<value name="${value}">`), `missing execution input ${value}`);
    }
    // Stake and barrier are variables, with legal positive-number shadows.
    assert.match(
      xml,
      /<value name="AMOUNT"><shadow type="math_number_positive"[^>]*>.*?<field name="VAR"[^>]*>Stake<\/field>/s,
    );
    assert.match(
      xml,
      /<value name="PREDICTION"><shadow type="math_number_positive"[^>]*>.*?<field name="VAR"[^>]*>Barrier<\/field>/s,
    );
  });

  it("emits the Agresti–Coull lower bound and compares it to break-even", () => {
    const { xml, summary } = buildDigitForgeStrategy(
      baseInput({ confidenceZ: 1.645, window: 120 }),
    );
    // z² and z²/2 constants.
    assert.match(xml, /<field name="NUM">2\.706025<\/field>/);
    assert.match(xml, /<field name="NUM">1\.353013<\/field>/);
    // A square root is taken (the standard error term).
    assert.match(xml, /<field name="OP">ROOT<\/field>/);
    // The window is the requested size.
    assert.match(xml, /<field name="NUM">120<\/field>/);
    assert.equal(summary.window, 120);
    assert.equal(summary.breakEven, Math.round((1 / 1.4) * 10000) / 10000);
  });

  it("emits the Markov G² test against the χ²(1) 5 % critical value, and can be turned off", () => {
    const on = buildDigitForgeStrategy(baseInput({ useMarkov: true })).xml;
    assert.match(on, /<field name="OP">LN<\/field>/);
    assert.match(on, /<field name="NUM">3\.84<\/field>/);
    // Four transition counters exist.
    for (const v of [
      "Loss to Loss",
      "Loss to Win",
      "Win to Loss",
      "Win to Win",
    ]) {
      assert.ok(on.includes(`>${v}</field>`), `missing counter ${v}`);
    }

    const off = buildDigitForgeStrategy(baseInput({ useMarkov: false })).xml;
    assert.doesNotMatch(off, /<field name="NUM">3\.84<\/field>/);
    assert.doesNotMatch(off, /<field name="OP">LN<\/field>/);
  });

  it("caps the adverse streak at the window's expected maximum", () => {
    const { xml, summary } = buildDigitForgeStrategy(
      baseInput({ window: 120 }),
    );
    // Over 2 → q = 0.3 → ceil(ln(120·0.7)/ln(10/3) + 2·1.2825/ln(10/3)) = 6
    assert.equal(summary.runLimit, 6);
    assert.ok(xml.includes(`<field name="NUM">6</field>`));

    const off = buildDigitForgeStrategy(
      baseInput({ useStreakCooldown: false }),
    ).xml;
    assert.ok(
      !off.includes("Adverse Run</field></block><block"),
      "cooldown clause should be gone",
    );
  });

  it("never forces an entry unless the user asks for it", () => {
    const patient = buildDigitForgeStrategy(baseInput()).xml;
    assert.doesNotMatch(patient, /Patience limit/);
    assert.equal(
      buildDigitForgeStrategy(baseInput()).summary.forceEntryAfter,
      0,
    );

    const forced = buildDigitForgeStrategy(baseInput({ forceEntryAfter: 90 }));
    assert.match(forced.xml, /Patience limit 90/);
    assert.equal(forced.summary.forceEntryAfter, 90);
  });

  it("independently ranks recovery candidates instead of reusing the normal decision", () => {
    const { xml } = buildDigitForgeStrategy(baseInput());
    const before = xml.slice(
      xml.indexOf('<block type="before_purchase"'),
      xml.indexOf('<block type="after_purchase"'),
    );
    assert.match(before, /<field name="MODE">NORMAL<\/field>/);
    assert.match(before, /<field name="MODE">RECOVERY<\/field>/);
    assert.match(before, /nt_digit_decision/);
  });

  it("implements the shared recovery ladder: debt × (1+markup) / (payout−1), floored, capped, rounded up", () => {
    const { xml } = buildDigitForgeStrategy(
      baseInput({ markupPercent: 10, maxStake: 250 }),
    );
    assert.match(xml, /<field name="NUM">1\.1<\/field>/); // 1 + 10/100
    assert.match(xml, /<field name="OP">ROUNDUP<\/field>/);
    assert.match(xml, /<field name="NUM">0\.35<\/field>/); // Deriv's minimum
    assert.match(xml, /<field name="NUM">250<\/field>/); // max stake cap
    // Literal 1e-9 is rejected by the real builder's number validator.
    assert.match(xml, /<field name="NUM">1000000000<\/field>/);
    assert.doesNotMatch(xml, /<field name="NUM">1e-9<\/field>/);
    assert.match(xml, /<block type="balance"/); // never stake more than the balance
    assert.equal(
      (xml.match(/<mutation name="Size recovery stake">/g) ?? []).length,
      1,
    ); // only after the selected contract's live payout is available
  });

  it("ends the run on TP, SL or the circuit breaker, and otherwise trades again", () => {
    const { xml } = buildDigitForgeStrategy(
      baseInput({ takeProfit: 12, stopLoss: 7, breakerDepth: 5 }),
    );
    assert.match(xml, /<field name="NUM">12<\/field>/);
    assert.match(xml, /<field name="NUM">-7<\/field>/);
    assert.match(xml, /<field name="NUM">5<\/field>/);
    assert.equal((xml.match(/<block type="trade_again"/g) ?? []).length, 1);
    assert.equal((xml.match(/<block type="total_profit"/g) ?? []).length, 2);
  });

  it("re-arms the gate after recovery completes", () => {
    const { xml } = buildDigitForgeStrategy(baseInput());
    assert.match(xml, /back to normal barriers at base stake behind the gate/);
  });

  it("escapes text so a market name can never break the XML", () => {
    const { xml } = buildDigitForgeStrategy(
      baseInput({ displayName: 'Vol "50" & <friends>' }),
    );
    assert.doesNotMatch(xml, /<friends>/);
    assert.match(xml, /&amp;/);
    assert.match(xml, /&quot;50&quot;/);
  });

  it("rejects inputs Deriv would reject at runtime", () => {
    assert.throws(
      () =>
        buildDigitForgeStrategy(
          baseInput({ normal: { side: "DIGITOVER", barrier: 4 } }),
        ),
      /normal must be/,
    );
    assert.throws(
      () =>
        buildDigitForgeStrategy(
          baseInput({ recovery: { side: "DIGITOVER", barrier: 1 } }),
        ),
      /recovery must be/,
    );
    assert.throws(
      () => buildDigitForgeStrategy(baseInput({ stake: 0.2 })),
      /stake must be/,
    );
    assert.throws(
      () => buildDigitForgeStrategy(baseInput({ takeProfit: 0 })),
      /takeProfit/,
    );
    assert.throws(
      () => buildDigitForgeStrategy(baseInput({ stopLoss: 0 })),
      /stopLoss/,
    );
    assert.throws(
      () => buildDigitForgeStrategy(baseInput({ normalPayout: 1 })),
      /normalPayout/,
    );
    assert.throws(
      () => buildDigitForgeStrategy(baseInput({ symbol: "R 100; DROP" })),
      /symbol/,
    );
  });

  it("clamps the analysis window so the interpreter cannot be starved", () => {
    assert.equal(
      buildDigitForgeStrategy(baseInput({ window: 5000 })).summary.window,
      300,
    );
    assert.equal(
      buildDigitForgeStrategy(baseInput({ window: 1 })).summary.window,
      20,
    );
    // minSamples can never exceed the window it is measured over.
    assert.equal(
      buildDigitForgeStrategy(baseInput({ window: 40, minSamples: 900 }))
        .summary.minSamples,
      40,
    );
  });

  it("emits the validated rotator watch list and safe market-switch block", () => {
    const { xml, summary } = buildDigitForgeStrategy(
      baseInput({ watchMarkets: ["R_10", "R_25", "bad symbol", "R_75"] }),
    );
    assert.deepEqual(summary.watchMarkets, ["R_50", "R_10", "R_25", "R_75"]);
    assert.match(xml, /nt_analyse_digit_markets/);
    assert.match(xml, /nt_switch_market/);
    assert.match(xml, /R_50,R_10,R_25,R_75/);
  });
});

describe("forge-time maths", () => {
  it("fairWinRate matches the digit partition", () => {
    assert.equal(fairWinRate({ side: "DIGITOVER", barrier: 1 }), 0.8);
    assert.equal(fairWinRate({ side: "DIGITOVER", barrier: 4 }), 0.5);
    assert.equal(fairWinRate({ side: "DIGITUNDER", barrier: 7 }), 0.7);
    assert.equal(fairWinRate({ side: "DIGITUNDER", barrier: 4 }), 0.4);
  });

  it("expectedMaxRun grows with the window and with the loss rate", () => {
    assert.ok(expectedMaxRun(500, 0.3) > expectedMaxRun(60, 0.3));
    assert.ok(expectedMaxRun(120, 0.5) > expectedMaxRun(120, 0.2));
    assert.ok(expectedMaxRun(20, 0.05) >= 3, "never below the floor");
  });

  it("ladderRisk reproduces the recovery ladder shapes from the design doc", () => {
    // payout 1.95, markup 10 % → stake = 1.1579·debt, debt ×2.158 per failed step
    const r = ladderRisk(1.95, 10, 4, 0.5);
    assert.equal(r.debtGrowthPerStep, 2.158);
    assert.ok(
      Math.abs(r.capitalAtRisk - 20.7) < 0.15,
      `capital ${r.capitalAtRisk}`,
    );
    assert.equal(r.failureProbability, 0.0625);

    // payout 2.43, markup 10 % → ×1.769 per step, but a 40 % win rate
    const s = ladderRisk(2.43, 10, 4, 0.4);
    assert.equal(s.debtGrowthPerStep, 1.769);
    assert.ok(
      Math.abs(s.capitalAtRisk - 8.8) < 0.15,
      `capital ${s.capitalAtRisk}`,
    );
    assert.equal(s.failureProbability, 0.1296);
  });
});

describe("committed builder fixtures", () => {
  it("match the current generator output (regenerate with `tsx src/lib/digit-forge-dbot.fixtures.ts --write`)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { DIGIT_FORGE_FIXTURES, fixturesDir, renderFixture } =
      await import("./digit-forge-dbot.fixtures.ts");
    for (const name of Object.keys(DIGIT_FORGE_FIXTURES)) {
      const file = path.join(fixturesDir(), `${name}.xml`);
      assert.ok(fs.existsSync(file), `${file} is missing`);
      assert.equal(
        fs.readFileSync(file, "utf8"),
        renderFixture(name),
        `${name}.xml is stale`,
      );
    }
  });
});
