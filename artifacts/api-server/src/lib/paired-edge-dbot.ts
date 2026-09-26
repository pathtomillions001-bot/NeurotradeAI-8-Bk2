/** Paired Edge → executable XML for NeuroTrade's embedded Deriv Bot builder. */
import { XmlBuilder, type Stmt, marketPathForSymbol } from "./overunder-turbo-dbot";

export interface PairedEdgeDbotInput {
  symbol: string;
  displayName: string;
  stake: number; // per rail
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStake: number; // per rail
  currency: string;
  normalOverPayout: number;
  normalUnderPayout: number;
  recoveryOverPayout: number;
  recoveryUnderPayout: number;
}

const esc = (v: string | number) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
function ensure(ok: boolean, message: string) { if (!ok) throw new Error(message); }

/** The only custom block used by this strategy; it is shipped by our embedded builder. */
export const PAIRED_EDGE_CUSTOM_BLOCKS = ["purchase_pair"] as const;

export function buildPairedEdgeDbot(input: PairedEdgeDbotInput) {
  ensure(/^[A-Za-z0-9_]+$/.test(input.symbol), "invalid Deriv symbol");
  ensure(Number.isFinite(input.stake) && input.stake >= 0.35, "stake must be at least 0.35 per rail");
  ensure(input.takeProfit > 0 && input.stopLoss > 0, "TP and SL must be positive");
  for (const [name, payout] of Object.entries({
    normalOverPayout: input.normalOverPayout, normalUnderPayout: input.normalUnderPayout,
    recoveryOverPayout: input.recoveryOverPayout, recoveryUnderPayout: input.recoveryUnderPayout,
  })) ensure(Number.isFinite(payout) && payout > 1, `${name} must be > 1`);

  // A recovery pair has one winner only outside digits 4/5. Its conservative
  // net return per $1 on EACH rail is min(total-return payout) - 2.
  const recoveryNetFactor = Math.min(input.recoveryOverPayout, input.recoveryUnderPayout) - 2;
  ensure(recoveryNetFactor > 0.01, "recovery pair quote cannot repay debt: winning payout must exceed 2x");

  const x = new XmlBuilder();
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency) ? input.currency.toUpperCase() : "USD";
  const maxSteps = Math.max(1, Math.min(10, Math.round(input.maxRecoverySteps)));
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const markup = Math.max(0, input.markupPercent);
  const V = {
    base: "Base Stake Per Rail", stake: "Stake Per Rail", debt: "Recovery Debt",
    recovering: "In Recovery", step: "Recovery Step", profit: "Pair Net Profit",
  } as const;

  const pair = (overBarrier: number, underBarrier: number): Stmt => ({
    type: "purchase_pair",
    inner:
      `<field name="OVER_TYPE">DIGITOVER</field><field name="UNDER_TYPE">DIGITUNDER</field>` +
      `<value name="OVER_BARRIER">${x.num(overBarrier)}</value>` +
      `<value name="UNDER_BARRIER">${x.num(underBarrier)}</value>` +
      `<value name="STAKE">${x.get(V.stake)}</value>`,
  });

  const size = (): Stmt[] => [
    x.set(V.stake, x.arith("DIVIDE", x.arith("MULTIPLY", x.get(V.debt), x.num(1 + markup / 100)), x.num(recoveryNetFactor))),
    x.set(V.stake, x.constrain(x.get(V.stake), x.num(0.35), x.num(maxStake))),
    x.set(V.stake, x.arith("DIVIDE", x.round("ROUNDUP", x.arith("MULTIPLY", x.arith("MINUS", x.get(V.stake), x.num(1e-9)), x.num(100))), x.num(100))),
    // Two rails are bought; each may consume at most half the available balance.
    x.ifElse([{ cond: x.compare("GT", x.arith("MULTIPLY", x.get(V.stake), x.num(2)), x.balance()), then: [
      x.set(V.stake, x.arith("DIVIDE", x.round("ROUNDDOWN", x.arith("MULTIPLY", x.balance(), x.num(50))), x.num(100))),
    ] }]),
  ];

  const init = x.chain([
    x.set(V.base, x.num(input.stake)), x.set(V.stake, x.get(V.base)),
    x.set(V.debt, x.num(0)), x.set(V.recovering, x.bool(false)), x.set(V.step, x.num(0)),
    x.notify("info", x.text(`Paired Edge · ${input.displayName} · normal Over 4 + Under 5 · recovery Over 5 + Under 4 · ${money(input.stake)} ${currency} per rail. Pair P&L is accounted only after both contracts settle on one exit tick.`)),
  ]);

  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="pe_opts"><mutation has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field><field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="pe_dur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="pe_amt"><field name="NUM">${input.stake}</field></shadow>${x.get(V.stake)}</value>` +
    `<value name="PREDICTION"><shadow type="math_number_positive" id="pe_pred"><field name="NUM">4</field></shadow></value></block>`;

  const definition = x.topLevel("trade_definition",
    `<statement name="TRADE_OPTIONS"><block type="trade_definition_market" id="pe_mkt" deletable="false" movable="false">` +
    `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
    `<next><block type="trade_definition_tradetype" id="pe_tt" deletable="false" movable="false"><field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">overunder</field>` +
    `<next><block type="trade_definition_contracttype" id="pe_ct" deletable="false" movable="false"><field name="TYPE_LIST">both</field>` +
    `<next><block type="trade_definition_candleinterval" id="pe_ci" deletable="false" movable="false"><field name="CANDLEINTERVAL_LIST">60</field>` +
    `<next><block type="trade_definition_restartbuysell" id="pe_rb" deletable="false" movable="false"><field name="TIME_MACHINE_ENABLED">FALSE</field>` +
    `<next><block type="trade_definition_restartonerror" id="pe_re" deletable="false" movable="false"><field name="RESTARTONERROR">FALSE</field></block></next></block></next></block></next></block></next></block></next></block></statement>` +
    `<statement name="INITIALIZATION">${init}</statement><statement name="SUBMARKET">${tradeOptions}</statement>`, 0, 0);

  const before = x.topLevel("before_purchase", `<statement name="BEFOREPURCHASE_STACK">${x.chain([
    x.ifElse([{ cond: x.compare("EQ", x.get(V.recovering), x.bool(true)), then: [pair(5, 4)] }], [pair(4, 5)]),
  ])}</statement>`, 0, 850);

  const enterOrDeepen: Stmt[] = [
    x.set(V.debt, x.arith("ADD", x.get(V.debt), x.arith("MINUS", x.num(0), x.get(V.profit)))),
    x.set(V.recovering, x.bool(true)),
    x.set(V.step, x.arith("ADD", x.get(V.step), x.num(1))),
    ...size(),
    x.notify("warn", x.text("Pair closed at a net loss. Recovery debt uses the exact combined realised loss from BOTH rails.")),
  ];
  const recoveryProfit: Stmt[] = [
    x.set(V.debt, x.arith("MINUS", x.get(V.debt), x.get(V.profit))),
    x.ifElse([{ cond: x.compare("LTE", x.get(V.debt), x.num(0.005)), then: [
      x.set(V.debt, x.num(0)), x.set(V.recovering, x.bool(false)), x.set(V.step, x.num(0)), x.set(V.stake, x.get(V.base)),
      x.notify("success", x.text("Recovery debt cleared; returning to Over 4 + Under 5 at base stake.")),
    ] }], size()),
  ];
  const settle = x.ifElse([
    { cond: x.compare("LT", x.get(V.profit), x.num(0)), then: enterOrDeepen },
    { cond: x.compare("EQ", x.get(V.recovering), x.bool(true)), then: recoveryProfit },
  ]);
  const limits = x.ifElse([
    { cond: x.compare("GTE", x.totalProfit(), x.num(input.takeProfit)), then: [x.notify("success", x.text(`Take profit ${money(input.takeProfit)} ${currency} reached.`), "job-done")] },
    { cond: x.compare("LTE", x.totalProfit(), x.num(-input.stopLoss)), then: [x.notify("error", x.text(`Stop loss ${money(input.stopLoss)} ${currency} reached.`), "error")] },
    { cond: x.compare("GTE", x.get(V.step), x.num(maxSteps)), then: [x.notify("error", x.text(`Maximum recovery depth ${maxSteps} reached; debt is preserved and trading is halted.`), "severe-error")] },
  ], [x.tradeAgain()]);
  const after = x.topLevel("after_purchase", `<statement name="AFTERPURCHASE_STACK">${x.chain([
    x.set(V.profit, x.readDetails(4)), settle, limits,
  ])}</statement>`, 1000, 0);

  const xml = `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">${x.variablesXml()}${definition}${before}${after}</xml>`;
  return {
    name: `NeuroTrade Paired Edge ${input.symbol}`,
    xml,
    summary: { ...input, market, submarket, currency, recoveryNetFactor, normalPair: "Over 4 + Under 5", recoveryPair: "Over 5 + Under 4" },
  };
}
