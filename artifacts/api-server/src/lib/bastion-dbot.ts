/**
 * Barrier Bastion → Deriv DBot strategy generator.
 *
 * This generator is intentionally standalone: it does not call the Dual-Lock
 * generator. The shape is similar because the product promise is similar — a
 * scan chooses a market plus a normal/recovery band pair, the generated DBot
 * times only the FIRST entry, then executes that lock back-to-back with the
 * shared recovery ledger until TP, SL, circuit breaker, or user stop.
 */

import {
  BASTION_NORMAL_CONTRACTS,
  BASTION_RECOVERY_CONTRACTS,
  type BastionContract,
} from "./bastion-analysis";
import { marketPathForSymbol } from "./overunder-turbo-dbot";
import { XmlBuilder, esc, money, type Stmt } from "./dbot-xml";

export interface BastionDbotContract {
  side: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
  label: string;
  payout: number;
}

export interface BastionDbotInput {
  symbol: string;
  displayName: string;
  normal: BastionDbotContract;
  recovery: BastionDbotContract;
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStake: number;
  normalPayout: number;
  recoveryPayout: number;
  breakerDepth: number;
  currency: string;
  entryWindow?: number;
  entryPatience?: number;
}

export interface BastionDbotStrategy {
  name: string;
  xml: string;
  summary: {
    symbol: string;
    displayName: string;
    market: string;
    submarket: string;
    normal: string;
    recovery: string;
    stake: number;
    takeProfit: number;
    stopLoss: number;
    maxRecoverySteps: number;
    markupPercent: number;
    maxStake: number;
    normalPayout: number;
    recoveryPayout: number;
    breakerDepth: number;
    currency: string;
    entryWindow: number;
    entryPatience: number;
  };
}

export const BASTION_DBOT_BLOCK_TYPES = Object.freeze([
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
  "nt_analyse_bastion_entry",
  "nt_bastion_entry_decision",
  "math_modulo",
  "contract_check_result",
  "read_details",
  "total_profit",
  "balance",
  "controls_if",
  "logic_compare",
  "logic_boolean",
  "math_number",
  "math_number_positive",
  "math_arithmetic",
  "math_round",
  "math_constrain",
  "variables_set",
  "variables_get",
  "text",
  "text_join",
  "text_statement",
  "notify",
  "procedures_defnoreturn",
  "procedures_callnoreturn",
] as const);

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function matches(
  c: BastionDbotContract,
  allowed: readonly BastionContract[],
): boolean {
  return allowed.some(
    (a) => a.contractType === c.side && a.barrier === c.barrier,
  );
}

export function bastionDbotContractFromBastion(
  contract: BastionContract,
  payout = contract.payout,
): BastionDbotContract {
  return {
    side: contract.contractType,
    barrier: contract.barrier,
    label: contract.label,
    payout,
  };
}

function normalLabel(c: BastionDbotContract): string {
  if (c.label) return c.label;
  return `${c.side === "DIGITOVER" ? "Over" : "Under"} ${c.barrier}`;
}

export function buildBastionDbotStrategy(
  input: BastionDbotInput,
): BastionDbotStrategy {
  ensure(
    matches(input.normal, BASTION_NORMAL_CONTRACTS),
    "normal must be Bastion Over 1 or Under 8",
  );
  ensure(
    matches(input.recovery, BASTION_RECOVERY_CONTRACTS),
    "recovery must be Bastion Over 3 or Under 6",
  );
  ensure(
    Number.isFinite(input.stake) && input.stake >= 0.35,
    "stake must be ≥ 0.35",
  );
  ensure(input.takeProfit > 0, "takeProfit must be > 0");
  ensure(input.stopLoss > 0, "stopLoss must be > 0");
  ensure(
    input.normalPayout > 1,
    "normalPayout must be a total-return multiplier > 1",
  );
  ensure(
    input.recoveryPayout > 1,
    "recoveryPayout must be a total-return multiplier > 1",
  );
  ensure(
    /^[A-Za-z0-9_]+$/.test(input.symbol),
    "symbol must be a Deriv symbol code",
  );

  const breakerDepth = Math.max(3, Math.round(input.breakerDepth));
  const maxRecoverySteps = Math.max(
    1,
    Math.min(10, Math.round(input.maxRecoverySteps)),
  );
  const markupPercent = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const entryWindow = Math.max(
    40,
    Math.min(300, Math.round(input.entryWindow ?? 120)),
  );
  const entryPatience = Math.max(
    3,
    Math.min(40, Math.round(input.entryPatience ?? 12)),
  );
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const nLabel = normalLabel(input.normal);
  const rLabel = normalLabel(input.recovery);
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency)
    ? input.currency.toUpperCase()
    : "USD";

  const x = new XmlBuilder();
  const V = {
    baseStake: "Base Stake",
    stake: "Stake",
    barrier: "Barrier",
    contract: "Contract",
    debt: "Recovery Debt",
    inRecovery: "In Recovery",
    step: "Recovery Step",
    lossRun: "Loss Run",
    recPayout: "Recovery Payout",
    normPayout: "Normal Payout",
    profit: "Profit",
    lastStake: "Last Stake",
    lastReturn: "Last Return",
    message: "Message",
    entryTimed: "First Entry Timed",
    entryWaits: "Entry Ticks Waited",
  } as const;

  const RECOVERY_PROC = "Size recovery stake";

  const init: Stmt[] = [
    x.set(V.baseStake, x.num(input.stake)),
    x.set(V.stake, x.get(V.baseStake)),
    x.set(V.contract, x.text(input.normal.side)),
    x.set(V.barrier, x.num(input.normal.barrier)),
    x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.step, x.num(0)),
    x.set(V.lossRun, x.num(0)),
    x.set(V.normPayout, x.num(Math.round(input.normalPayout * 1000) / 1000)),
    x.set(V.recPayout, x.num(Math.round(input.recoveryPayout * 1000) / 1000)),
    x.set(V.entryTimed, x.bool(false)),
    x.set(V.entryWaits, x.num(0)),
    x.notify(
      "info",
      x.text(
        `NeuroTrade Barrier Bastion · ${input.displayName} · ${nLabel} normal → ${rLabel} recovery · ` +
          `stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · ` +
          `first entry timed within ${entryPatience} ticks, then executes the scanned Bastion lock non-stop · ` +
          `markup ${markupPercent}% · circuit breaker ${breakerDepth} losses`,
      ),
    ),
  ];

  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="btopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="btdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="btamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    `<value name="PREDICTION"><shadow type="math_number_positive" id="btprd"><field name="NUM">${input.normal.barrier}</field></shadow>${x.get(V.barrier)}</value>` +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="btmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="bttt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">overunder</field>` +
      `<next><block type="trade_definition_contracttype" id="btct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">both</field>` +
      `<next><block type="trade_definition_candleinterval" id="btci" deletable="false" movable="false">` +
      `<field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="btrb" deletable="false" movable="false">` +
      `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="btre" deletable="false" movable="false">` +
      `<field name="RESTARTONERROR">TRUE</field>` +
      `</block></next></block></next></block></next></block></next></block></next></block>` +
      `</statement>` +
      `<statement name="INITIALIZATION">${x.chain(init)}</statement>` +
      `<statement name="SUBMARKET">${tradeOptions}</statement>`,
    0,
    0,
  );

  const purchaseCurrentContract = () =>
    x.ifElse(
      [
        {
          cond: x.compare("EQ", x.get(V.contract), x.text("DIGITOVER")),
          then: [x.purchase("DIGITOVER")],
        },
      ],
      [x.purchase("DIGITUNDER")],
    );

  const timeFirstEntry: Stmt[] = [
    x.set(V.entryWaits, x.arith("ADD", x.get(V.entryWaits), x.num(1))),
    x.ntAnalyseBastionEntry(
      input.normal.side,
      input.normal.barrier,
      entryWindow,
      entryPatience,
      x.get(V.entryWaits),
    ),
    x.ifElse([
      {
        cond: x.compare("EQ", x.ntBastionEntryDecision("ready"), x.bool(true)),
        then: [
          x.set(V.entryTimed, x.bool(true)),
          x.joinInto(V.message, [
            x.text(`${nLabel} on ${input.displayName} —`),
            x.ntBastionEntryDecision("reason"),
          ]),
          x.notify("success", x.get(V.message)),
          purchaseCurrentContract(),
        ],
      },
      {
        cond: x.compare("EQ", x.mod(x.get(V.entryWaits), x.num(3)), x.num(0)),
        then: [
          x.joinInto(V.message, [
            x.text("Waiting for a clean Bastion start —"),
            x.ntBastionEntryDecision("reason"),
          ]),
          x.notify("info", x.get(V.message)),
        ],
      },
    ]),
  ];

  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      x.ifElse(
        [
          {
            cond: x.compare("EQ", x.get(V.entryTimed), x.bool(true)),
            then: [purchaseCurrentContract()],
          },
        ],
        timeFirstEntry,
      ),
    ])}</statement>`,
    0,
    900,
  );

  const sizeRecoveryStake: Stmt[] = [
    x.set(
      V.stake,
      x.arith(
        "DIVIDE",
        x.arith("MULTIPLY", x.get(V.debt), x.num(1 + markupPercent / 100)),
        x.arith("MINUS", x.get(V.recPayout), x.num(1)),
      ),
    ),
    x.set(V.stake, x.constrain(x.get(V.stake), x.num(0.35), x.num(maxStake))),
    x.set(
      V.stake,
      x.arith(
        "DIVIDE",
        x.round(
          "ROUNDUP",
          x.arith(
            "MULTIPLY",
            x.arith("MINUS", x.get(V.stake), x.num(0.000000001)),
            x.num(100),
          ),
        ),
        x.num(100),
      ),
    ),
    x.ifElse([
      {
        cond: x.compare("GT", x.get(V.stake), x.balance()),
        then: [
          x.set(
            V.stake,
            x.arith(
              "DIVIDE",
              x.round(
                "ROUNDDOWN",
                x.arith("MULTIPLY", x.balance(), x.num(100)),
              ),
              x.num(100),
            ),
          ),
        ],
      },
    ]),
    x.ifElse([
      {
        cond: x.compare("LT", x.get(V.stake), x.num(0.35)),
        then: [x.set(V.stake, x.num(0.35))],
      },
    ]),
  ];

  const recoveryProc = x.topLevel(
    "procedures_defnoreturn",
    `<field name="NAME">${esc(RECOVERY_PROC)}</field><statement name="STACK">${x.chain(sizeRecoveryStake)}</statement>`,
    1000,
    900,
  );

  const enterRecovery: Stmt[] = [
    x.set(V.inRecovery, x.bool(true)),
    x.set(V.step, x.num(1)),
    x.set(V.debt, x.get(V.lastStake)),
    x.set(V.contract, x.text(input.recovery.side)),
    x.set(V.barrier, x.num(input.recovery.barrier)),
  ];
  const deepenRecovery: Stmt[] = [
    x.ifElse([
      {
        cond: x.compare("LT", x.get(V.step), x.num(maxRecoverySteps)),
        then: [x.set(V.step, x.arith("ADD", x.get(V.step), x.num(1)))],
      },
    ]),
    x.set(V.debt, x.arith("ADD", x.get(V.debt), x.get(V.lastStake))),
  ];
  const exitRecovery: Stmt[] = [
    x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.step, x.num(0)),
    x.set(V.contract, x.text(input.normal.side)),
    x.set(V.barrier, x.num(input.normal.barrier)),
    x.set(V.stake, x.get(V.baseStake)),
    x.notify(
      "success",
      x.text(
        `Recovery complete — debt cleared, back to ${nLabel} at base stake`,
      ),
    ),
  ];
  const onRecoveryWinPartial: Stmt[] = [
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [
      x.text("Partial recovery —"),
      x.get(V.debt),
      x.text(`${currency} debt remains, next ${rLabel} stake`),
      x.get(V.stake),
      x.text(currency),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onLoss: Stmt[] = [
    x.set(V.lossRun, x.arith("ADD", x.get(V.lossRun), x.num(1))),
    x.ifElse(
      [
        {
          cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
          then: deepenRecovery,
        },
      ],
      enterRecovery,
    ),
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [
      x.text("Recovery step"),
      x.get(V.step),
      x.text(`— ${rLabel} sized at`),
      x.get(V.stake),
      x.text(`${currency} to clear`),
      x.get(V.debt),
      x.text(`${currency} · firing Bastion lock`),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onWin: Stmt[] = [
    x.set(V.lossRun, x.num(0)),
    x.ifElse([
      {
        cond: x.compare("GT", x.get(V.lastStake), x.num(0)),
        then: [
          x.ifElse(
            [
              {
                cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
                then: [
                  x.set(
                    V.recPayout,
                    x.arith("DIVIDE", x.get(V.lastReturn), x.get(V.lastStake)),
                  ),
                ],
              },
            ],
            [
              x.set(
                V.normPayout,
                x.arith("DIVIDE", x.get(V.lastReturn), x.get(V.lastStake)),
              ),
            ],
          ),
        ],
      },
    ]),
    x.ifElse([
      {
        cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
        then: [
          x.set(V.debt, x.arith("MINUS", x.get(V.debt), x.get(V.profit))),
          x.ifElse(
            [
              {
                cond: x.compare("LTE", x.get(V.debt), x.num(0.005)),
                then: exitRecovery,
              },
            ],
            onRecoveryWinPartial,
          ),
        ],
      },
    ]),
  ];

  const boundaries: Stmt = x.ifElse(
    [
      {
        cond: x.compare("GTE", x.totalProfit(), x.num(input.takeProfit)),
        then: [
          x.notify(
            "success",
            x.text(
              `Take profit ${money(input.takeProfit)} ${currency} reached — session complete`,
            ),
            "job-done",
          ),
        ],
      },
      {
        cond: x.compare("LTE", x.totalProfit(), x.num(-input.stopLoss)),
        then: [
          x.notify(
            "error",
            x.text(
              `Stop loss ${money(input.stopLoss)} ${currency} hit — session stopped`,
            ),
            "error",
          ),
        ],
      },
      {
        cond: x.compare("GTE", x.get(V.lossRun), x.num(breakerDepth)),
        then: [
          x.notify(
            "error",
            x.text(
              `Circuit breaker: ${breakerDepth} consecutive losses exceeded this Bastion lock — re-scan before redeploying`,
            ),
            "severe-error",
          ),
        ],
      },
    ],
    [x.tradeAgain()],
  );

  const afterPurchase = x.topLevel(
    "after_purchase",
    `<statement name="AFTERPURCHASE_STACK">${x.chain([
      x.set(V.profit, x.readDetails(4)),
      x.set(V.lastStake, x.readDetails(2)),
      x.set(V.lastReturn, x.readDetails(3)),
      x.ifElse([{ cond: x.checkResult("win"), then: onWin }], onLoss),
      boundaries,
    ])}</statement>`,
    1000,
    0,
  );

  const xml =
    `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">` +
    x.variablesXml() +
    tradeDefinition +
    recoveryProc +
    beforePurchase +
    afterPurchase +
    `</xml>`;

  const name = `NeuroTrade Barrier Bastion ${input.symbol} ${nLabel} to ${rLabel}`;

  return {
    name,
    xml,
    summary: {
      symbol: input.symbol,
      displayName: input.displayName,
      market,
      submarket,
      normal: nLabel,
      recovery: rLabel,
      stake: input.stake,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      maxRecoverySteps,
      markupPercent,
      maxStake,
      normalPayout: input.normalPayout,
      recoveryPayout: input.recoveryPayout,
      breakerDepth,
      currency,
      entryWindow,
      entryPatience,
    },
  };
}
