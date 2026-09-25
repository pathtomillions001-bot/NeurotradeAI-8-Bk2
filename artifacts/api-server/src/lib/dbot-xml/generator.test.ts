/**
 * DBot XML generator tests.
 *
 * Two guarantees are pinned here:
 *  1. STRUCTURE — the emitted Blockly XML carries exactly the blocks/fields
 *     the vendored builder's loader accepts for a digits over/under strategy
 *     (trade_definition chain, prediction barrier, purchase side, ladder).
 *  2. RECOVERY PARITY — the stake ladder embedded in the XML is byte-for-byte
 *     the number the account's own recovery engine would compute after the
 *     same sequence of losses (reduceRecoveryOutcome/getBotRecoveryStake),
 *     so a DBot run and a server-engine run recover identically.
 */
import { test } from "node:test";
import assert from "node:assert";
import { generateDbotXml } from "./generator";
import { computeRecoveryLadder } from "./ladder";
import type { DbotStrategyManifest } from "./manifest";
import {
  createRecoveryState,
  getBotRecoveryStake,
  recordOutcome,
  resetAll,
  seedState,
  setPersistenceSession,
} from "../agents/recovery-engine";

function manifest(over: Partial<DbotStrategyManifest> = {}): DbotStrategyManifest {
  return {
    source: "overunder-turbo",
    symbol: "R_10",
    displayName: "Volatility 10 Index",
    contract: { side: "DIGITOVER", barrier: 2 },
    recoveryContract: { side: "DIGITUNDER", barrier: 5 },
    duration: 1,
    durationUnit: "t",
    stake: 1,
    takeProfit: 25,
    stopLoss: 50,
    recovery: {
      baseStake: 1,
      payoutMultiplier: 1.95,
      markupPercent: 10,
      maxSteps: 3,
      maxTradeStake: 500,
    },
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** Minimal well-formedness check: every opened tag closes, in order. */
function assertWellFormed(xml: string): void {
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z_][\w:.-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, closing, tag, , selfClose] = m;
    if (tag === "xml") continue;
    if (selfClose) continue;
    if (closing) {
      const top = stack.pop();
      assert.strictEqual(top, tag, `mismatched close tag </${tag}> (open was <${top}>)`);
    } else {
      stack.push(tag);
    }
  }
  assert.strictEqual(stack.length, 0, `unclosed tags: ${stack.join(",")}`);
}

test("generated XML is well-formed and carries the digits over/under strategy", () => {
  const { xml } = generateDbotXml(manifest());
  assertWellFormed(xml);
  assert.match(xml, /is_dbot="true"/);
  assert.match(xml, /<field name="SYMBOL_LIST">R_10<\/field>/);
  assert.match(xml, /<field name="TRADETYPECAT_LIST">digits<\/field>/);
  assert.match(xml, /<field name="TRADETYPE_LIST">overunder<\/field>/);
  assert.match(xml, /has_prediction="true"/);
  assert.match(xml, /<value name="PREDICTION">[\s\S]*?<field name="NUM">2<\/field>/);
  assert.match(xml, /<field name="PURCHASE_LIST">DIGITOVER<\/field>/);
  assert.match(xml, /<field name="DURATIONTYPE_LIST">t<\/field>/);
  assert.match(xml, /procedures_defreturn/);
  assert.match(xml, /NeuroTrade Continue/);
  assert.match(xml, /trade_again/);
});

test("ladder stakes and TP/SL/breaker thresholds appear in the XML", () => {
  const { xml, ladder } = generateDbotXml(manifest());
  for (const stake of ladder.stakes) {
    assert.match(xml, new RegExp(`<field name="NUM">${stake}</field>`), `ladder stake ${stake} missing`);
  }
  assert.match(xml, /<field name="NUM">25<\/field>/); // take profit
  assert.match(xml, /<field name="NUM">-50<\/field>/); // stop loss (negated compare)
  assert.match(xml, /<field name="NUM">3<\/field>/); // breaker: streak > maxSteps
});

test("recovery ladder matches the recovery engine step-for-step", () => {
  const spec = manifest().recovery;
  const ladder = computeRecoveryLadder(spec);

  // Replay the same loss sequence through the account-global engine.
  setPersistenceSession("dbot-ladder-parity");
  resetAll();
  seedState(createRecoveryState());

  let debtStake = spec.baseStake;
  assert.strictEqual(ladder.stakes[0], debtStake, "step 0 is the normal stake");
  for (let step = 1; step <= spec.maxSteps; step++) {
    // Lose the previous stake…
    recordOutcome(false, -debtStake, debtStake, spec.maxSteps, "DIGITOVER", spec.payoutMultiplier);
    // …the engine's next bot stake must equal the ladder entry.
    const engineStake = getBotRecoveryStake(
      spec.baseStake,
      spec.maxTradeStake,
      Number.POSITIVE_INFINITY,
      spec.payoutMultiplier,
      spec.markupPercent,
    );
    assert.strictEqual(
      ladder.stakes[step],
      Math.round(engineStake * 100) / 100,
      `ladder step ${step} diverges from the recovery engine`,
    );
    debtStake = ladder.stakes[step];
  }
  resetAll();
});

test("ladder respects the max-stake ceiling and Deriv minimum", () => {
  const ladder = computeRecoveryLadder({
    baseStake: 100,
    payoutMultiplier: 1.5,
    markupPercent: 10,
    maxSteps: 4,
    maxTradeStake: 250,
  });
  for (const stake of ladder.stakes) {
    assert.ok(stake >= 0.35, "never below Deriv minimum");
    assert.ok(stake <= 250, "never above the configured max stake");
  }
});

test("DIGITUNDER manifests emit the under purchase side", () => {
  const { xml } = generateDbotXml(
    manifest({ contract: { side: "DIGITUNDER", barrier: 7 } } as Partial<DbotStrategyManifest>),
  );
  assert.match(xml, /<field name="PURCHASE_LIST">DIGITUNDER<\/field>/);
  assert.match(xml, /<field name="NUM">7<\/field>/);
});
