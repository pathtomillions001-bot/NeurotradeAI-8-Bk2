/**
 * Scanner → NeuroTrade's embedded Deriv Bot Builder. This strategy uses a
 * PAIR-purchase Blockly extension shipped with that builder. A stock Deriv
 * `purchase` block cannot buy two contracts (the engine discards a second buy),
 * so emitting two ordinary purchase blocks would be misleading and unsafe.
 *
 * No buys occur while constructing or loading this XML. The user must review
 * the blocks, connect an account and explicitly press Run in Bot Builder.
 */
import { XmlBuilder, marketPathForSymbol, type Stmt } from "./overunder-turbo-dbot";

export interface Digit45DbotInput {
  symbol: string;
  displayName: string;
  stake: number;          // EACH normal leg, not the total pair budget
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStake: number;       // per-leg cap, further capped by half the live balance
  currency: string;
}

function esc(value: string | number): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function assertAmount(value: number, name: string, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    throw new Error(`${name} must be a finite amount between ${min} and ${max} with at most 2 decimals`);
  }
}

export function buildDigit45DbotStrategy(input: Digit45DbotInput) {
  if (!/^[A-Za-z0-9_]+$/.test(input.symbol)) throw new Error("Invalid Deriv symbol");
  if (!["USD", "EUR", "GBP", "AUD"].includes(input.currency)) {
    throw new Error("Digit 4/5 pair recovery currently supports 2-decimal USD/EUR/GBP/AUD accounts only");
  }
  assertAmount(input.stake, "Stake per leg", 0.35, 500);
  assertAmount(input.maxStake, "Maximum stake per leg", input.stake, 500);
  assertAmount(input.takeProfit, "Take profit", 0.01, 100000);
  assertAmount(input.stopLoss, "Stop loss", 0.01, 100000);
  if (input.stopLoss < 2 * input.stake) throw new Error("Stop loss must cover both normal legs");
  if (!Number.isInteger(input.maxRecoverySteps) || input.maxRecoverySteps < 1 || input.maxRecoverySteps > 10) {
    throw new Error("Recovery steps must be an integer from 1 to 10");
  }
  if (!Number.isFinite(input.markupPercent) || input.markupPercent < 0 || input.markupPercent > 100) {
    throw new Error("Recovery markup must be from 0 to 100%");
  }

  const { market, submarket } = marketPathForSymbol(input.symbol);
  const x = new XmlBuilder();
  const v = {
    base: "Stake Per Leg", debt: "Pair Recovery Debt", step: "Recovery Pairs Used",
    pnl: "Last Pair PnL", session: "Session Pair PnL", message: "Pair Message",
  } as const;
  let pairResultId = 0;
  const result = (field: "profit" | "bothLost" | "partial" | "stake") =>
    `<block type="digit45_pair_result" id="nt45result${++pairResultId}"><field name="DETAIL">${field}</field></block>`;
  const purchasePair = (mode: "normal" | "recovery"): Stmt => ({
    type: "purchase_digit45_pair",
    inner: `<field name="MODE">${mode}</field>` +
      `<field name="EXPECTED_CURRENCY">${esc(input.currency)}</field>` +
      `<value name="BASE_STAKE">${x.get(v.base)}</value>` +
      `<value name="DEBT">${x.get(v.debt)}</value>` +
      `<value name="MARKUP">${x.num(input.markupPercent)}</value>` +
      `<value name="MAX_STAKE">${x.num(input.maxStake)}</value>` +
      `<value name="STOP_LOSS">${x.num(input.stopLoss)}</value>` +
      `<value name="SESSION_PROFIT">${x.get(v.session)}</value>`,
  });

  const init = x.chain([
    x.set(v.base, x.num(input.stake)),
    x.set(v.debt, x.num(0)),
    x.set(v.step, x.num(0)),
    x.set(v.pnl, x.num(0)),
    x.set(v.session, x.num(0)),
    x.notify("info", x.text(
      `Digit 4/5 pair · ${input.displayName} · NORMAL: Over 4 + Under 5 · RECOVERY: Over 5 + Under 4. ` +
      `Both legs buy on Run only; ${input.stake.toFixed(2)} ${input.currency} PER LEG. ` +
      `Pairs are not atomic and may settle on different ticks.`,
    )),
  ]);

  // The ordinary trade-options block supplies market, currency and 1-tick
  // duration to Deriv's existing engine. Its prediction value is a required
  // display field; each paired buy sends its OWN fixed barrier from the custom
  // pair block, never this display value.
  const options =
    `<block type="trade_definition_tradeoptions" id="nt45opts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field><field name="CURRENCY_LIST">${esc(input.currency)}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="nt45dur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="nt45amt"><field name="NUM">${input.stake}</field></shadow>${x.get(v.base)}</value>` +
    `<value name="PREDICTION"><shadow type="math_number_positive" id="nt45prd"><field name="NUM">4</field></shadow></value>` +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="nt45mkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="nt45tt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">overunder</field>` +
      `<next><block type="trade_definition_contracttype" id="nt45ct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">both</field>` +
      `<next><block type="trade_definition_candleinterval" id="nt45ci" deletable="false" movable="false">` +
      `<field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="nt45rb" deletable="false" movable="false">` +
      `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="nt45re" deletable="false" movable="false">` +
      // A retry after an uncertain first buy could double the exposure. Fail closed.
      `<field name="RESTARTONERROR">FALSE</field>` +
      `</block></next></block></next></block></next></block></next></block></next></block>` +
      `</statement><statement name="INITIALIZATION">${init}</statement>` +
      `<statement name="SUBMARKET">${options}</statement>`,
    0, 0,
  );

  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      x.ifElse([{ cond: x.compare("GT", x.get(v.debt), x.num(0)), then: [purchasePair("recovery")] }],
        [purchasePair("normal")]),
    ])}</statement>`,
    0, 850,
  );

  const updateDebt: Stmt[] = [
    // A recovery pair counts as one attempt even when its result is positive
    // but too small to clear the entire debt. Normal losses begin at step zero.
    x.ifElse([{ cond: x.compare("GT", x.get(v.debt), x.num(0)), then: [
      x.set(v.step, x.arith("ADD", x.get(v.step), x.num(1))),
    ] }]),
    x.ifElse([
      { cond: x.compare("LT", x.get(v.pnl), x.num(0)), then: [
        x.set(v.debt, x.arith("MINUS", x.get(v.debt), x.get(v.pnl))),
        x.ifElse([{ cond: x.compare("EQ", result("bothLost"), x.bool(true)), then: [
          x.notify("warn", x.text("Both legs lost: recovery debt includes BOTH stakes.")),
        ] }]),
      ] },
      { cond: x.compare("GT", x.get(v.debt), x.num(0)), then: [
        x.set(v.debt, x.arith("MINUS", x.get(v.debt), x.get(v.pnl))),
        x.ifElse([{ cond: x.compare("LTE", x.get(v.debt), x.num(0.005)), then: [
          x.set(v.debt, x.num(0)), x.set(v.step, x.num(0)),
          x.notify("success", x.text("Pair recovery complete: combined debt cleared.")),
        ] }]),
      ] },
    ]),
    x.joinInto(v.message, [x.text("Pair P/L"), x.get(v.pnl), x.text(input.currency),
      x.text("| outstanding debt"), x.get(v.debt), x.text(input.currency)]),
    x.notify("info", x.get(v.message)),
    x.ifElse([
      { cond: x.compare("GTE", x.get(v.session), x.num(input.takeProfit)), then: [
        x.notify("success", x.text(`Take profit ${input.takeProfit.toFixed(2)} ${input.currency} reached. Session stopped.`)),
      ] },
      { cond: x.compare("LTE", x.get(v.session), x.num(-input.stopLoss)), then: [
        x.notify("error", x.text(`Stop loss ${input.stopLoss.toFixed(2)} ${input.currency} reached. Session stopped.`)),
      ] },
      { cond: x.logic("AND", x.compare("GT", x.get(v.debt), x.num(0)),
        x.compare("GTE", x.get(v.step), x.num(input.maxRecoverySteps))), then: [
        x.notify("error", x.text("Recovery attempt limit reached with debt outstanding. Stop and re-scan.")),
      ] },
    ], [x.tradeAgain()]),
  ];

  const afterPurchase = x.topLevel(
    "after_purchase",
    `<statement name="AFTERPURCHASE_STACK">${x.chain([
      x.set(v.pnl, result("profit")),
      x.set(v.session, x.arith("ADD", x.get(v.session), x.get(v.pnl))),
      x.ifElse([{ cond: x.compare("EQ", result("partial"), x.bool(true)), then: [
        x.notify("error", x.text("One paired order failed or only one contract settled. No more buys: inspect the Deriv account.")),
      ] }], updateDebt),
    ])}</statement>`,
    1000, 0,
  );

  return {
    name: `NeuroTrade Digit 4-5 Pair ${input.symbol}`,
    xml: `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">` +
      x.variablesXml() + tradeDefinition + beforePurchase + afterPurchase + `</xml>`,
    summary: {
      symbol: input.symbol, displayName: input.displayName,
      normal: ["Over 4", "Under 5"], recovery: ["Over 5", "Under 4"],
      stakePerLeg: input.stake, pairExposure: input.stake * 2,
      takeProfit: input.takeProfit, stopLoss: input.stopLoss,
      maxRecoverySteps: input.maxRecoverySteps, markupPercent: input.markupPercent,
      maxStakePerLeg: input.maxStake, currency: input.currency,
      execution: "Two concurrent buy requests; not an atomic/same-tick guarantee",
    },
  };
}
