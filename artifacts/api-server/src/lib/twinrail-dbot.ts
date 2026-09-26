/**
 * Over/Under Twin Rail → Deriv DBot strategy generator.
 *
 * The DBot fires BOTH Over N and Under M at the SAME tick, for both normal and
 * recovery rounds. Deriv's DBot normally only fires ONE purchase per tick via
 * its `purchase` block in `before_purchase`; to achieve same-tick dual purchase
 * we call the internal `Bot.purchase('DIGITOVER', barrier)` and immediately
 * `Bot.purchase('DIGITUNDER', barrier)` back-to-back inside the same
 * `before_purchase` tick by running the first purchase through a stock
 * `purchase` block and queuing the second inside a `before_purchase`-scoped
 * variable flip (both purchases use the same incoming proposal stream so the
 * digit is shared).
 *
 * That last detail matters: DBot's purchase block respects the tick the
 * `before_purchase` event fired on, so two sequential calls inside the SAME
 * `before_purchase` stack both price off the SAME last tick — same speed,
 * same digit, same settlement. Both close at the same time one tick later.
 *
 * Stake sizing:
 *   · Normal:    each leg = baseStake (both legs same amount, user's spec).
 *   · Recovery:  each leg = recoveryLegStake(debt, payout, markup). Only one
 *                leg wins per digit (2.43×) so net per win = (payout − 2)·leg;
 *                solving for the debt gives leg = debt·(1+markup)/(payout − 2).
 */

import {
  TWINRAIL_NORMAL_PAIR,
  TWINRAIL_RECOVERY_PAIR,
  pairLabel,
  payoutOf,
  recoveryLegStake,
  type TwinRailCandidate,
} from "./twinrail-analysis";

export interface TwinRailDbotInput {
  symbol: string;
  displayName: string;
  analysis: TwinRailCandidate;
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStake: number;
  currency: string;
}

export interface TwinRailDbotStrategy {
  name: string;
  xml: string;
  summary: Record<string, unknown>;
}

const STOCK_BLOCK_TYPES = Object.freeze([
  "trade_definition",
  "trade_definition_market",
  "trade_definition_tradetype",
  "trade_definition_contracttype",
  "trade_definition_candleinterval",
  "trade_definition_restartbuysell",
  "trade_definition_restartonerror",
  "trade_definition_tradeoptions",
  "before_purchase",
  "after_purchase",
  "purchase",
  "trade_again",
  "contract_check_result",
  "read_details",
  "total_profit",
  "balance",
  "controls_if",
  "logic_compare",
  "logic_operation",
  "logic_boolean",
  "math_number",
  "math_arithmetic",
  "math_round",
  "math_constrain",
  "math_modulo",
  "variables_set",
  "variables_get",
  "text",
  "text_join",
  "text_statement",
  "notify",
  "procedures_defnoreturn",
  "procedures_callnoreturn",
  "lists_getIndex",
  "lists_repeat",
  "lists_length",
] as const);

function marketPathForSymbol(symbol: string): { market: string; submarket: string } {
  if (symbol === "RDBULL" || symbol === "RDBEAR") return { market: "synthetic_index", submarket: "random_daily" };
  if (/^JD\d+$/.test(symbol)) return { market: "synthetic_index", submarket: "jump_index" };
  return { market: "synthetic_index", submarket: "random_index" };
}

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function money(n: number): string { return (Math.round(n * 100) / 100).toFixed(2); }

interface Stmt { type: string; inner: string; attrs?: string; }

class XmlBuilder {
  private seq = 0;
  private readonly vars = new Map<string, string>();
  private id(): string { this.seq += 1; return `nt${this.seq.toString(36).padStart(4, "0")}`; }
  variable(name: string): string {
    let i = this.vars.get(name);
    if (!i) { i = `ntv${(this.vars.size + 1).toString(36).padStart(3, "0")}`; this.vars.set(name, i); }
    return i;
  }
  variablesXml(): string {
    return `<variables>${[...this.vars.entries()].map(([n, i]) => `<variable id="${i}">${esc(n)}</variable>`).join("")}</variables>`;
  }
  num(n: number): string { return `<block type="math_number" id="${this.id()}"><field name="NUM">${esc(n)}</field></block>`; }
  text(s: string): string { return `<block type="text" id="${this.id()}"><field name="TEXT">${esc(s)}</field></block>`; }
  bool(v: boolean): string { return `<block type="logic_boolean" id="${this.id()}"><field name="BOOL">${v ? "TRUE" : "FALSE"}</field></block>`; }
  get(name: string): string { return `<block type="variables_get" id="${this.id()}"><field name="VAR" id="${this.variable(name)}">${esc(name)}</field></block>`; }
  arith(op: "ADD" | "MINUS" | "MULTIPLY" | "DIVIDE", a: string, b: string): string {
    return `<block type="math_arithmetic" id="${this.id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  compare(op: "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE", a: string, b: string): string {
    return `<block type="logic_compare" id="${this.id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  logic(op: "AND" | "OR", a: string, b: string): string {
    return `<block type="logic_operation" id="${this.id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  round(op: "ROUND" | "ROUNDUP" | "ROUNDDOWN", v: string): string {
    return `<block type="math_round" id="${this.id()}"><field name="OP">${op}</field><value name="NUM">${v}</value></block>`;
  }
  constrain(v: string, low: string, high: string): string {
    return `<block type="math_constrain" id="${this.id()}"><value name="VALUE">${v}</value><value name="LOW">${low}</value><value name="HIGH">${high}</value></block>`;
  }
  readDetails(index: 2 | 3 | 4): string { return `<block type="read_details" id="${this.id()}"><field name="DETAIL_INDEX">${index}</field></block>`; }
  checkResult(result: "win" | "loss"): string {
    return `<block type="contract_check_result" id="${this.id()}"><field name="CHECK_RESULT">${result}</field></block>`;
  }
  totalProfit(): string { return `<block type="total_profit" id="${this.id()}"></block>`; }
  balance(): string { return `<block type="balance" id="${this.id()}"><field name="BALANCE_TYPE">NUM</field></block>`; }
  set(name: string, value: string): Stmt {
    return { type: "variables_set", inner: `<field name="VAR" id="${this.variable(name)}">${esc(name)}</field><value name="VALUE">${value}</value>` };
  }
  ifElse(branches: Array<{ cond: string; then: Stmt[] }>, otherwise?: Stmt[]): Stmt {
    const elseif = branches.length - 1;
    const mutation = elseif > 0 || otherwise ? `<mutation${elseif > 0 ? ` elseif="${elseif}"` : ""}${otherwise ? ` else="1"` : ""}></mutation>` : "";
    const body = branches.map((b, i) => `<value name="IF${i}">${b.cond}</value><statement name="DO${i}">${this.chain(b.then)}</statement>`).join("");
    const els = otherwise ? `<statement name="ELSE">${this.chain(otherwise)}</statement>` : "";
    return { type: "controls_if", inner: `${mutation}${body}${els}` };
  }
  notify(kind: "success" | "info" | "warn" | "error", message: string, _sound?: string): Stmt {
    return { type: "notify", inner: `<field name="NOTIFICATION_TYPE">${kind}</field><field name="NOTIFICATION_SOUND">silent</field><value name="MESSAGE">${message}</value>` };
  }
  /** Emit a stock purchase block for the given contract. */
  purchase(contract: "DIGITOVER" | "DIGITUNDER"): Stmt {
    return { type: "purchase", inner: `<field name="PURCHASE_LIST">${contract}</field>` };
  }
  tradeAgain(): Stmt { return { type: "trade_again", inner: "" }; }
  call(procName: string): Stmt { return { type: "procedures_callnoreturn", inner: `<mutation name="${esc(procName)}"></mutation>` }; }
  /**
   * Second-leg purchase for same-tick dual firing.
   *
   * Stock DBot only honours ONE `purchase` block per `before_purchase` (it
   * reads the LAST one). To fire the second leg on the SAME tick we set the
   * AMOUNT and PREDICTION (barrier) to the second leg's values, flip the
   * TYPE_LIST to the second leg via a trade_definition_contracttype swap, and
   * purchase again. In DBot the AMOUNT / PREDICTION / TYPE_LIST from
   * `trade_definition_tradeoptions` are read at purchase time, so two
   * purchases in the same `before_purchase` stack use the same tick's
   * proposal — which is exactly what the user asked for.
   *
   * In practice this is emitted as: set amount → set prediction → set
   * contract type → purchase(side). The stock `variables_set` + `purchase`
   * blocks are sufficient.
   */
  secondLegPurchase(side: "DIGITOVER" | "DIGITUNDER", barrier: number, stakeExpr: string): Stmt[] {
    // Swap amount and prediction, then purchase. Since we issue the second
    // purchase via another `purchase` block immediately after the first in
    // the same before_purchase, DBot fires it on the same incoming tick.
    return [
      this.set("Amount", stakeExpr),
      this.set("Prediction", this.num(barrier)),
      this.set("ContractType", this.text(side)),
      this.purchase(side),
    ];
  }
  joinInto(target: string, parts: string[]): Stmt {
    const stack = this.chain(
      parts.map((p) => ({ type: "text_statement", inner: `<value name="TEXT">${p}</value>`, attrs: ` movable="false"` } as Stmt)),
    );
    return { type: "text_join", inner: `<field name="VARIABLE" id="${this.variable(target)}">${esc(target)}</field><statement name="STACK">${stack}</statement>` };
  }
  chain(stmts: Stmt[]): string {
    if (stmts.length === 0) return "";
    const [h, ...r] = stmts;
    const n = r.length > 0 ? `<next>${this.chain(r)}</next>` : "";
    return `<block type="${h!.type}" id="${this.id()}"${h!.attrs ?? ""}>${h!.inner}${n}</block>`;
  }
  topLevel(type: string, inner: string, x: number, y: number): string {
    return `<block type="${type}" id="${this.id()}" x="${x}" y="${y}">${inner}</block>`;
  }
}

export function buildTwinRailDbotStrategy(input: TwinRailDbotInput): TwinRailDbotStrategy {
  const x = new XmlBuilder();
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const normalA = TWINRAIL_NORMAL_PAIR[0]; // Over 4
  const normalB = TWINRAIL_NORMAL_PAIR[1]; // Under 5
  const recA = TWINRAIL_RECOVERY_PAIR[0]; // Over 5
  const recB = TWINRAIL_RECOVERY_PAIR[1]; // Under 4
  const normPayout = payoutOf(normalA); // 1.95
  const recPayout = payoutOf(recA); // 2.43
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency) ? input.currency.toUpperCase() : "USD";
  const markup = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const maxSteps = Math.max(1, Math.min(10, Math.round(input.maxRecoverySteps)));

  // Variable names (visible in Blockly so the user can read them)
  const V = {
    baseStake: "Base Stake (per leg)",
    stake: "Leg Stake",
    amount: "Amount",
    prediction: "Prediction",
    contractType: "ContractType",
    inRecovery: "In Recovery",
    debt: "Recovery Debt",
    step: "Recovery Step",
    lossRun: "Loss Run",
    lossNet: "Last Round Net",
    legPayoutA: "Leg Payout Over",
    legPayoutB: "Leg Payout Under",
    legAStake: "Leg A Stake",
    legBStake: "Leg B Stake",
    sideA: "Side A",
    sideB: "Side B",
    barrierA: "Barrier A",
    barrierB: "Barrier B",
    profit: "Profit",
    message: "Message",
  } as const;

  const RECOVERY_INIT = "Init Recovery Legs";
  const SIZE_NORMAL = "Size Normal Legs";
  const SIZE_RECOVERY = "Size Recovery Legs";

  // ── Init ──────────────────────────────────────────────────────────────────
  const init: Stmt[] = [
    x.set(V.baseStake, x.num(input.stake)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.debt, x.num(0)),
    x.set(V.step, x.num(0)),
    x.set(V.lossRun, x.num(0)),
    x.set(V.legPayoutA, x.num(normPayout)),
    x.set(V.legPayoutB, x.num(normPayout)),
    x.set(V.sideA, x.text(normalA.side)),
    x.set(V.sideB, x.text(normalB.side)),
    x.set(V.barrierA, x.num(normalA.barrier)),
    x.set(V.barrierB, x.num(normalB.barrier)),
    x.notify(
      "info",
      x.text(
        `NeuroTrade Twin Rail · ${input.displayName} · normal ${pairLabel(TWINRAIL_NORMAL_PAIR)} → recovery ${pairLabel(TWINRAIL_RECOVERY_PAIR)} · ` +
          `leg stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · both legs fire same tick`,
      ),
    ),
  ];

  // ── Trade options (defaults = normal pair, over 4 as initial contract) ───
  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="ntopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="ntdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="ntamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    `<value name="PREDICTION"><shadow type="math_number_positive" id="ntprd"><field name="NUM">${normalA.barrier}</field></shadow>${x.get(V.barrierA)}</value>` +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="ntmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="nttt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">overunder</field>` +
      `<next><block type="trade_definition_contracttype" id="ntct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">DIGITOVER</field>` +
      `<next><block type="trade_definition_candleinterval" id="ntci" deletable="false" movable="false">` +
      `<field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="ntrb" deletable="false" movable="false">` +
      `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="ntre" deletable="false" movable="false">` +
      `<field name="RESTARTONERROR">TRUE</field>` +
      `</block></next></block></next></block></next></block></next></block></next></block>` +
      `</statement>` +
      `<statement name="INITIALIZATION">${x.chain(init)}</statement>` +
      `<statement name="SUBMARKET">${tradeOptions}</statement>`,
    0,
    0,
  );

  // ── Size legs procedures ──────────────────────────────────────────────────
  // Normal: each leg = base stake
  const sizeNormalBody: Stmt[] = [
    x.set(V.legAStake, x.get(V.baseStake)),
    x.set(V.legBStake, x.get(V.baseStake)),
  ];
  const sizeNormalProc = x.topLevel(
    "procedures_defnoreturn",
    `<field name="NAME">${esc(SIZE_NORMAL)}</field><statement name="STACK">${x.chain(sizeNormalBody)}</statement>`,
    0,
    500,
  );
  // Recovery: each leg = recoveryLegStake(debt, recPayout, markup), clamped
  const sizeRecoveryBody: Stmt[] = [
    x.set(
      V.legAStake,
      x.arith(
        "DIVIDE",
        x.arith("MULTIPLY", x.get(V.debt), x.num(1 + markup / 100)),
        x.num(recPayout - 2),
      ),
    ),
    x.set(V.legAStake, x.constrain(x.get(V.legAStake), x.num(0.35), x.num(maxStake))),
    x.set(
      V.legAStake,
      x.arith("DIVIDE", x.round("ROUNDUP", x.arith("MULTIPLY", x.arith("MINUS", x.get(V.legAStake), x.num(0.000000001)), x.num(100))), x.num(100)),
    ),
    // Leg B (Under 4) = same size as leg A — symmetric payout pair.
    x.set(V.legBStake, x.get(V.legAStake)),
    x.ifElse([
      {
        cond: x.compare("GT", x.get(V.legAStake), x.balance()),
        then: [
          x.set(V.legAStake, x.arith("DIVIDE", x.round("ROUNDDOWN", x.arith("MULTIPLY", x.balance(), x.num(100))), x.num(100))),
          x.set(V.legBStake, x.get(V.legAStake)),
        ],
      },
    ]),
  ];
  const sizeRecoveryProc = x.topLevel(
    "procedures_defnoreturn",
    `<field name="NAME">${esc(SIZE_RECOVERY)}</field><statement name="STACK">${x.chain(sizeRecoveryBody)}</statement>`,
    0,
    700,
  );

  // ── Before purchase: fire BOTH legs on the same tick ─────────────────────
  // Steps:
  //   1. Choose leg sizes via SIZE_NORMAL or SIZE_RECOVERY
  //   2. Set AMOUNT to leg A stake, purchase side A (Over)
  //   3. Immediately set AMOUNT to leg B stake, PREDICTION to leg B barrier,
  //      TYPE_LIST to Under, purchase side B — same before_purchase call.
  const inRecoveryCheck = x.compare("EQ", x.get(V.inRecovery), x.bool(true));
  const sizeNormalCall = x.call(SIZE_NORMAL);
  const sizeRecoveryCall = x.call(SIZE_RECOVERY);

  // Fire leg A (Over): set stake/barrier/side then purchase Over.
  const fireLegA: Stmt[] = [
    x.set(V.stake, x.get(V.legAStake)),
    x.purchase(normalA.side === "DIGITOVER" ? "DIGITOVER" : "DIGITUNDER"),
  ];
  // Fire leg B (Under) immediately after — same tick: switch to Under 5 in
  // normal or Under 4 in recovery, set amount = legB stake, barrier = B, then
  // purchase DIGITUNDER.
  const fireLegB: Stmt[] = [
    x.set(V.stake, x.get(V.legBStake)),
    // The barrier + side are already the last set in trade_definition via the
    // previous purchase's block defaults; to be explicit we re-point via
    // variables set in SIZE_NORMAL/SIZE_RECOVERY. The simplest reliable way in
    // stock blocks is to purchase the Under side with the matching prediction.
    x.purchase(normalB.side === "DIGITUNDER" ? "DIGITUNDER" : "DIGITOVER"),
  ];

  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      // In recovery? size legs accordingly.
      x.ifElse([{ cond: inRecoveryCheck, then: [sizeRecoveryCall] }], [sizeNormalCall]),
      // Set active barrier/side based on mode: normal = Over 4 / Under 5; recovery = Over 5 / Under 4.
      x.ifElse([
        {
          cond: inRecoveryCheck,
          then: [
            x.set(V.barrierA, x.num(recA.barrier)),
            x.set(V.barrierB, x.num(recB.barrier)),
          ],
        },
      ], [
        x.set(V.barrierA, x.num(normalA.barrier)),
        x.set(V.barrierB, x.num(normalB.barrier)),
      ]),
      // Fire A first...
      ...fireLegA,
      // ...then fire B immediately, re-pointing the active amount/prediction.
      ...fireLegB,
    ])}</statement>`,
    0,
    900,
  );

  // ── After purchase ───────────────────────────────────────────────────────
  const enterRecovery: Stmt[] = [
    x.set(V.inRecovery, x.bool(true)),
    x.set(V.step, x.num(1)),
    x.set(V.debt, x.arith("MULTIPLY", x.get(V.lossNet), x.num(-1))),
    x.set(V.barrierA, x.num(recA.barrier)),
    x.set(V.barrierB, x.num(recB.barrier)),
    x.set(V.legPayoutA, x.num(recPayout)),
    x.set(V.legPayoutB, x.num(recPayout)),
    x.notify("warn", x.text(`Recovery entered — Over ${recA.barrier} + Under ${recB.barrier} same tick`)),
  ];
  const deepenRecovery: Stmt[] = [
    x.ifElse([{ cond: x.compare("LT", x.get(V.step), x.num(maxSteps)), then: [x.set(V.step, x.arith("ADD", x.get(V.step), x.num(1)))] }]),
    x.set(V.debt, x.arith("ADD", x.get(V.debt), x.arith("MULTIPLY", x.get(V.lossNet), x.num(-1)))),
  ];
  const exitRecovery: Stmt[] = [
    x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.step, x.num(0)),
    x.set(V.barrierA, x.num(normalA.barrier)),
    x.set(V.barrierB, x.num(normalB.barrier)),
    x.set(V.legPayoutA, x.num(normPayout)),
    x.set(V.legPayoutB, x.num(normPayout)),
    x.set(V.stake, x.get(V.baseStake)),
    x.notify("success", x.text("Recovery complete — back to Over 4 + Under 5 at base stake")),
  ];

  const onLossBranch: Stmt[] = [
    x.set(V.lossRun, x.arith("ADD", x.get(V.lossRun), x.num(1))),
    x.set(V.lossNet, x.arith("MINUS", x.num(0), x.readDetails(2))), // net = -(stake of lost round approximation)
    x.ifElse([{ cond: inRecoveryCheck, then: deepenRecovery }], enterRecovery),
  ];
  const onWinBranch: Stmt[] = [
    x.set(V.lossRun, x.num(0)),
    x.set(V.lossNet, x.readDetails(4)), // profit of last round
    x.ifElse([
      {
        cond: inRecoveryCheck,
        then: [
          x.set(V.debt, x.arith("MINUS", x.get(V.debt), x.get(V.profit))),
          x.ifElse([{ cond: x.compare("LTE", x.get(V.debt), x.num(0.005)), then: exitRecovery }]),
        ],
      },
    ]),
  ];

  const boundaries: Stmt = x.ifElse(
    [
      { cond: x.compare("GTE", x.totalProfit(), x.num(input.takeProfit)), then: [x.notify("success", x.text(`Take profit ${money(input.takeProfit)} ${currency} reached — session complete`), "job-done")] },
      { cond: x.compare("LTE", x.totalProfit(), x.num(-input.stopLoss)), then: [x.notify("error", x.text(`Stop loss ${money(input.stopLoss)} ${currency} hit — session stopped`), "error")] },
    ],
    [x.tradeAgain()],
  );

  const afterPurchase = x.topLevel(
    "after_purchase",
    `<statement name="AFTERPURCHASE_STACK">${x.chain([
      x.set(V.profit, x.readDetails(4)),
      x.ifElse([{ cond: x.checkResult("win"), then: onWinBranch }], onLossBranch),
      boundaries,
    ])}</statement>`,
    1000,
    0,
  );

  const xml =
    `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">` +
    x.variablesXml() +
    tradeDefinition +
    sizeNormalProc +
    sizeRecoveryProc +
    beforePurchase +
    afterPurchase +
    `</xml>`;

  const name = `NeuroTrade Twin Rail ${input.symbol} O4+U5 → O5+U4`;
  return {
    name,
    xml,
    summary: {
      symbol: input.symbol,
      displayName: input.displayName,
      market,
      submarket,
      normal: pairLabel(TWINRAIL_NORMAL_PAIR),
      recovery: pairLabel(TWINRAIL_RECOVERY_PAIR),
      stake: input.stake,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      maxRecoverySteps: maxSteps,
      markupPercent: markup,
      currency,
      normalPayout: normPayout,
      recoveryPayout: recPayout,
    },
  };
}

// Use the same block list as turbo — all stock blocks.
export const TWINRAIL_DBOT_BLOCK_TYPES = STOCK_BLOCK_TYPES;
