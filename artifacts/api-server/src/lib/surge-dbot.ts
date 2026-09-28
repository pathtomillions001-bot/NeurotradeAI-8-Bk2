/** Vector Surge → adaptive multi-market Rise/Fall Deriv DBot generator. */
import { XmlBuilder, esc, money, type Stmt } from "./dbot-xml";
import { marketPathForSymbol } from "./overunder-turbo-dbot";

export interface SurgeDbotInput {
  symbol: string;
  displayName: string;
  watchMarkets: string[];
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStake: number;
  payout: number;
  breakerDepth: number;
  currency: string;
  window?: number;
  weights?: number[];
  tau?: number;
}

export const SURGE_DBOT_BLOCK_TYPES = Object.freeze([
  "trade_definition", "trade_definition_market", "trade_definition_tradetype",
  "trade_definition_contracttype", "trade_definition_candleinterval",
  "trade_definition_restartbuysell", "trade_definition_restartonerror",
  "trade_definition_tradeoptions", "before_purchase", "after_purchase", "purchase",
  "trade_again", "contract_check_result", "read_details", "total_profit", "balance",
  "nt_analyse_surge_markets", "nt_surge_decision", "nt_switch_market",
  "controls_if", "logic_compare", "logic_operation", "logic_boolean", "math_number", "math_number_positive",
  "math_arithmetic", "math_round", "math_constrain", "math_modulo", "variables_set",
  "variables_get", "text", "text_join", "text_statement", "notify",
  "procedures_defnoreturn", "procedures_callnoreturn",
] as const);

function ensure(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function buildSurgeDbotStrategy(input: SurgeDbotInput) {
  ensure(/^[A-Za-z0-9_]+$/.test(input.symbol), "symbol must be a Deriv symbol code");
  ensure(Number.isFinite(input.stake) && input.stake >= 0.35, "stake must be ≥ 0.35");
  ensure(input.takeProfit > 0, "takeProfit must be > 0");
  ensure(input.stopLoss > 0, "stopLoss must be > 0");
  ensure(input.payout > 1, "payout must be > 1");

  const watchMarkets = [input.symbol, ...(input.watchMarkets ?? [])]
    .filter((symbol, index, all) => /^[A-Za-z0-9_]+$/.test(symbol) && all.indexOf(symbol) === index)
    .slice(0, 8);
  const window = Math.max(100, Math.min(500, Math.round(input.window ?? 240)));
  const rawWeights = Array.isArray(input.weights) && input.weights.length === 4
    ? input.weights.map(value => Math.max(0.01, Number(value) || 0.01))
    : [0.3, 0.25, 0.2, 0.25];
  const weightSum = rawWeights.reduce((sum, value) => sum + value, 0);
  const weights = rawWeights.map(value => Math.round((value / weightSum) * 10000) / 10000);
  const tau = Math.max(0.5, Math.min(2.5, Number(input.tau) || 1));
  const payout = Math.round(input.payout * 1000) / 1000;
  const markupPercent = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const breakerDepth = Math.max(3, Math.round(input.breakerDepth));
  const maxRecoverySteps = Math.max(1, Math.min(10, Math.round(input.maxRecoverySteps)));
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency) ? input.currency.toUpperCase() : "USD";
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const x = new XmlBuilder();
  const V = {
    baseStake: "Base Stake", stake: "Stake", contract: "Contract",
    debt: "Recovery Debt", inRecovery: "In Recovery", step: "Recovery Step",
    lossRun: "Loss Run", normalPayout: "Normal Payout", recoveryPayout: "Recovery Payout",
    fire: "Fire", eligible: "Setup Eligible", checks: "Analysis Checks",
    activeSymbol: "Active Market", reason: "Analysis Reason", score: "Analysis Score",
    profit: "Profit", lastStake: "Last Stake", lastReturn: "Last Return", message: "Message",
  } as const;
  const RECOVERY_PROC = "Size recovery stake";

  const init: Stmt[] = [
    x.set(V.baseStake, x.num(input.stake)), x.set(V.stake, x.get(V.baseStake)),
    x.set(V.contract, x.text("CALL")), x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)), x.set(V.step, x.num(0)), x.set(V.lossRun, x.num(0)),
    x.set(V.normalPayout, x.num(payout)), x.set(V.recoveryPayout, x.num(payout)),
    x.set(V.fire, x.bool(false)), x.set(V.eligible, x.bool(false)), x.set(V.checks, x.num(0)),
    x.set(V.activeSymbol, x.text(input.symbol)), x.set(V.reason, x.text("surge analysis warming up")),
    x.set(V.score, x.num(0)),
    x.notify("info", x.text(
      `NeuroTrade Vector Surge DBot · ${input.displayName} · Rise/Fall normal + recovery · ` +
      `${window}-tick multi-lens timing across ${watchMarkets.length} markets · stake ${money(input.stake)} · ` +
      `TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · recovery markup ${markupPercent}%`,
    )),
  ];

  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="vsopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="false"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field><field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="vsdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="vsamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    `</block>`;
  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS"><block type="trade_definition_market" id="vsmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="vstt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">callput</field><field name="TRADETYPE_LIST">callput</field>` +
      `<next><block type="trade_definition_contracttype" id="vsct" deletable="false" movable="false"><field name="TYPE_LIST">both</field>` +
      `<next><block type="trade_definition_candleinterval" id="vsci" deletable="false" movable="false"><field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="vsrb" deletable="false" movable="false"><field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="vsre" deletable="false" movable="false"><field name="RESTARTONERROR">TRUE</field>` +
      `</block></next></block></next></block></next></block></next></block></next></block></statement>` +
      `<statement name="INITIALIZATION">${x.chain(init)}</statement>` +
      `<statement name="SUBMARKET">${tradeOptions}</statement>`,
    0, 0,
  );

  const entryReport = (): Stmt[] => [
    x.joinInto(V.message, [x.text("ENTRY ·"), x.get(V.activeSymbol), x.text("·"), x.get(V.contract), x.text("· evidence-confirmed setup")]),
    x.notify("success", x.get(V.message)),
  ];
  const waitingReport: Stmt[] = [
    x.joinInto(V.message, [x.text("ANALYSING"), x.get(V.activeSymbol), x.text("· Rise/Fall setup not yet qualified")]),
    x.notify("info", x.get(V.message)),
  ];
  const analyse = (mode: "NORMAL" | "RECOVERY", payoutVar: string): Stmt[] => [
    x.ntAnalyseSurge(mode, watchMarkets, window, weights, tau, x.get(payoutVar)),
    x.set(V.activeSymbol, x.ntSurgeDecision("symbol")),
    x.set(V.contract, x.ntSurgeDecision("contract")),
    x.set(V.reason, x.ntSurgeDecision("reason")),
    x.set(V.score, x.ntSurgeDecision("score")),
    x.set(V.eligible, x.ntSurgeDecision("eligible")),
    x.set(payoutVar, x.ntSurgeDecision("payout")),
  ];
  const purchaseCurrent = () => x.ifElse(
    [{ cond: x.compare("EQ", x.get(V.contract), x.text("CALL")), then: [x.purchase("CALL")] }],
    [x.purchase("PUT")],
  );
  const adaptiveEntry: Stmt[] = [
    x.set(V.checks, x.arith("ADD", x.get(V.checks), x.num(1))),
    x.ifElse(
      [{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: analyse("RECOVERY", V.recoveryPayout) }],
      analyse("NORMAL", V.normalPayout),
    ),
    x.ifElse([
      {
        cond: x.compare("EQ", x.ntSurgeDecision("changedMarket"), x.bool(true)),
        then: [x.ntSwitchMarket(x.get(V.activeSymbol)), x.joinInto(V.message, [x.text("SWITCHED MARKET · now analysing"), x.get(V.activeSymbol)]), x.notify("info", x.get(V.message))],
      },
      {
        cond: x.all("AND", [
          x.compare("EQ", x.get(V.eligible), x.bool(true)),
          x.compare("GTE", x.balance(), x.num(0.35)),
          x.compare("LTE", x.get(V.stake), x.balance()),
        ]),
        then: [...entryReport(), x.set(V.fire, x.bool(true))],
      },
      {
        cond: x.compare("EQ", x.mod(x.get(V.checks), x.num(10)), x.num(0)),
        then: waitingReport,
      },
    ]),
  ];
  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      x.set(V.fire, x.bool(false)), ...adaptiveEntry,
      x.ifElse([{ cond: x.compare("EQ", x.get(V.fire), x.bool(true)), then: [purchaseCurrent()] }]),
    ])}</statement>`,
    0, 900,
  );

  const sizeRecovery: Stmt[] = [
    x.set(V.stake, x.arith("DIVIDE", x.arith("MULTIPLY", x.get(V.debt), x.num(1 + markupPercent / 100)), x.arith("MINUS", x.get(V.recoveryPayout), x.num(1)))),
    x.set(V.stake, x.constrain(x.get(V.stake), x.num(0.35), x.num(maxStake))),
    x.set(V.stake, x.arith("DIVIDE", x.round("ROUNDUP", x.arith("MULTIPLY", x.arith("MINUS", x.get(V.stake), x.num(0.000000001)), x.num(100))), x.num(100))),
    x.ifElse([{ cond: x.compare("GT", x.get(V.stake), x.balance()), then: [x.set(V.stake, x.arith("DIVIDE", x.round("ROUNDDOWN", x.arith("MULTIPLY", x.balance(), x.num(100))), x.num(100)))] }]),
    x.ifElse([{ cond: x.compare("LT", x.get(V.stake), x.num(0.35)), then: [x.set(V.stake, x.num(0.35))] }]),
  ];
  const recoveryProc = x.topLevel("procedures_defnoreturn", `<field name="NAME">${RECOVERY_PROC}</field><statement name="STACK">${x.chain(sizeRecovery)}</statement>`, 1000, 900);

  const resetAnalysis = (): Stmt[] => [x.set(V.eligible, x.bool(false)), x.set(V.checks, x.num(0)), x.set(V.reason, x.text("surge analysis warming up"))];
  const enterRecovery: Stmt[] = [x.set(V.inRecovery, x.bool(true)), x.set(V.step, x.num(1)), x.set(V.debt, x.get(V.lastStake)), ...resetAnalysis()];
  const deepenRecovery: Stmt[] = [
    x.ifElse([{ cond: x.compare("LT", x.get(V.step), x.num(maxRecoverySteps)), then: [x.set(V.step, x.arith("ADD", x.get(V.step), x.num(1)))] }]),
    x.set(V.debt, x.arith("ADD", x.get(V.debt), x.get(V.lastStake))), ...resetAnalysis(),
  ];
  const exitRecovery: Stmt[] = [
    x.set(V.debt, x.num(0)), x.set(V.inRecovery, x.bool(false)), x.set(V.step, x.num(0)),
    x.set(V.stake, x.get(V.baseStake)), ...resetAnalysis(),
    x.notify("success", x.text("Recovery complete — debt cleared; returning to two-way Rise/Fall analysis at base stake")),
  ];
  const onPartial: Stmt[] = [
    ...resetAnalysis(), x.call(RECOVERY_PROC),
    x.joinInto(V.message, [x.text("Partial recovery · debt"), x.get(V.debt), x.text(`${currency} · next qualified stake`), x.get(V.stake)]),
    x.notify("warn", x.get(V.message)),
  ];
  const onLoss: Stmt[] = [
    x.set(V.lossRun, x.arith("ADD", x.get(V.lossRun), x.num(1))),
    x.ifElse([{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: deepenRecovery }], enterRecovery),
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [x.text("Recovery step"), x.get(V.step), x.text("· debt"), x.get(V.debt), x.text(`${currency} · waiting for best confirmed Rise/Fall market`)]),
    x.notify("warn", x.get(V.message)),
  ];
  const onWin: Stmt[] = [
    x.set(V.lossRun, x.num(0)),
    x.ifElse([{ cond: x.compare("GT", x.get(V.lastStake), x.num(0)), then: [
      x.ifElse([{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: [x.set(V.recoveryPayout, x.arith("DIVIDE", x.get(V.lastReturn), x.get(V.lastStake)))] }], [x.set(V.normalPayout, x.arith("DIVIDE", x.get(V.lastReturn), x.get(V.lastStake)))]),
    ] }]),
    x.ifElse([{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: [
      x.set(V.debt, x.arith("MINUS", x.get(V.debt), x.get(V.profit))),
      x.ifElse([{ cond: x.compare("LTE", x.get(V.debt), x.num(0.005)), then: exitRecovery }], onPartial),
    ] }]),
  ];
  const boundaries = x.ifElse([
    { cond: x.compare("GTE", x.totalProfit(), x.num(input.takeProfit)), then: [x.notify("success", x.text(`Take profit ${money(input.takeProfit)} ${currency} reached — session complete`), "job-done")] },
    { cond: x.compare("LTE", x.totalProfit(), x.num(-input.stopLoss)), then: [x.notify("error", x.text(`Stop loss ${money(input.stopLoss)} ${currency} hit — session stopped`), "error")] },
    { cond: x.compare("GTE", x.get(V.lossRun), x.num(breakerDepth)), then: [x.notify("error", x.text(`Circuit breaker: ${breakerDepth} consecutive losses — re-scan before another run`), "severe-error")] },
  ], [x.tradeAgain()]);
  const afterPurchase = x.topLevel("after_purchase", `<statement name="AFTERPURCHASE_STACK">${x.chain([
    x.set(V.profit, x.readDetails(4)), x.set(V.lastStake, x.readDetails(2)), x.set(V.lastReturn, x.readDetails(3)),
    x.ifElse([{ cond: x.checkResult("win"), then: onWin }], onLoss), boundaries,
  ])}</statement>`, 1000, 0);

  const xml = `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">${x.variablesXml()}${tradeDefinition}${recoveryProc}${beforePurchase}${afterPurchase}</xml>`;
  return {
    name: `NeuroTrade Vector Surge ${input.symbol} Adaptive Rise Fall`,
    xml,
    summary: {
      symbol: input.symbol, displayName: input.displayName, watchMarkets, stake: input.stake,
      takeProfit: input.takeProfit, stopLoss: input.stopLoss, maxRecoverySteps,
      markupPercent, maxStake, payout, breakerDepth, currency, window, weights, tau,
      normal: "Best of Rise / Fall", recovery: "Best of Rise / Fall",
    },
  };
}
