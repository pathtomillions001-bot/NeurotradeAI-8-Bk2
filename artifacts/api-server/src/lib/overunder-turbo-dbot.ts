/**
 * Over/Under Turbo → Deriv DBot strategy generator.
 *
 * WHAT THIS IS
 * ────────────
 *   The Turbo scan (`overunder-turbo-engine.scanForTurbo`) finds ONE best
 *   (market, normal barrier, recovery barrier) triple. Normally the user deploys
 *   it into NeuroTrade's own executor. "Create DBot" instead turns that exact
 *   triple — plus the session's stake / take-profit / stop-loss and the shared
 *   bot recovery rules — into a stock Deriv Bot (Blockly) strategy. The user
 *   opens it in the unmodified Deriv bot builder, verifies the blocks, and
 *   presses Deriv's own Run: from then on Deriv Bot executes the trades, not
 *   the Turbo engine.
 *
 * WHAT THE GENERATED BOT DOES (1:1 with the Turbo engine's LOCKED mode)
 * ────────────────────────────────────────────────────────────────────────
 *   · Trades the scanned market only, 1-tick Over/Under digit contracts.
 *   · ARM ONCE: before the first purchase it waits until the normal contract's
 *     hit-rate over the last 40 digits is ≥ its break-even (1 / payout), or
 *     the arming window elapses (`armTimeoutTicks`) — then it never re-arms.
 *   · Normal contract while there is no debt; recovery contract while there is.
 *   · Recovery stake = debt × (1 + markup %) / (payout − 1), floored at $0.35,
 *     capped at the account's max trade stake and at the live balance, rounded
 *     UP to cents — the same `getBotRecoveryStake` maths as every specialist bot.
 *   · A recovery win pays the net profit into the debt; recovery ends the moment
 *     debt reaches zero (a partial win keeps recovery active on the remainder).
 *   · Circuit breaker: `breakerDepth` consecutive losses stops the bot (the
 *     Turbo engine's only non-TP/SL halt).
 *   · Take-profit / stop-loss on Deriv's own total-profit counter end the run.
 *
 *   The one thing a DBot cannot do is Turbo's SWITCHING mode (Deriv Bot fixes
 *   the market in its trade definition), so the generated bot is a LOCKED bot.
 *
 * WHY EVERY BLOCK IS STOCK
 * ────────────────────────
 *   Only block types that ship with the vendored Deriv bot builder are used
 *   (`TURBO_DBOT_BLOCK_TYPES`), so the workspace loads through the builder's
 *   normal `load()` path with zero patches to Deriv's code. The generated XML is
 *   plain Blockly XML with `is_dbot="true"`, identical in shape to the Quick
 *   Strategy templates in `artifacts/dbot-builder/src/xml/`.
 */

import {
  contractLabel,
  isNormalContract,
  isRecoveryContract,
  type TurboContract,
} from "./overunder-turbo-analysis";
import { XmlBuilder, esc, money, type Stmt } from "./dbot-xml";

// ── Public types ──────────────────────────────────────────────────────────────

export interface TurboDbotInput {
  symbol: string;
  displayName: string;
  normal: TurboContract;
  recovery: TurboContract;
  /** Base stake in account currency (≥ 0.35). */
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  /** Recovery profit markup on debt, % (settings.botRecoveryMarkup). */
  markupPercent: number;
  /** Hard cap for any single stake (settings.maxTradeStake). */
  maxStake: number;
  /** Total-return payout multipliers (stake included), e.g. Over 4 ≈ 1.95. */
  normalPayout: number;
  recoveryPayout: number;
  /** Consecutive losses that halt the bot (engine: p95 ladder depth + 2). */
  breakerDepth: number;
  currency: string;
  /** Digits inspected while arming (engine default 40). */
  armWindow?: number;
  /** Purchase-condition evaluations (≈ ticks) before arming is forced. */
  armTimeoutTicks?: number;
}

export interface TurboDbotStrategy {
  /** Strategy / file name shown in the builder. */
  name: string;
  /** Blockly workspace XML (`is_dbot="true"`). */
  xml: string;
  /** Human-readable recap for the console and toast. */
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
    armWindow: number;
    armTimeoutTicks: number;
    currency: string;
  };
}

/** Every block type the generated strategy may contain — all stock Deriv Bot blocks. */
export const TURBO_DBOT_BLOCK_TYPES = Object.freeze([
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
  "lastDigitList",
  "lists_getSublist",
  "lists_length",
  "controls_forEach",
  "controls_if",
  "logic_compare",
  "logic_operation",
  "logic_boolean",
  "math_number",
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

// ── Market path (Deriv market / submarket for the trade-definition block) ─────

/**
 * Deriv's `trade_definition_market` block needs market + submarket + symbol.
 * All Turbo markets are synthetics; this is the static mapping the builder
 * also confirms live from `contracts_for` when it loads the strategy.
 */
export function marketPathForSymbol(symbol: string): { market: string; submarket: string } {
  if (symbol === "RDBULL" || symbol === "RDBEAR") {
    return { market: "synthetic_index", submarket: "random_daily" };
  }
  if (/^JD\d+$/.test(symbol)) {
    return { market: "synthetic_index", submarket: "jump_index" };
  }
  return { market: "synthetic_index", submarket: "random_index" };
}

// ── Strategy generator ────────────────────────────────────────────────────────

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

export function buildTurboDbotStrategy(input: TurboDbotInput): TurboDbotStrategy {
  ensure(
    isNormalContract(input.normal.side, input.normal.barrier),
    "normal must be one of Over 1, Over 2, Under 7, Under 8",
  );
  ensure(
    isRecoveryContract(input.recovery.side, input.recovery.barrier),
    "recovery must be one of Over 4, Over 5, Under 4, Under 5",
  );
  ensure(Number.isFinite(input.stake) && input.stake >= 0.35, "stake must be ≥ 0.35");
  ensure(input.takeProfit > 0, "takeProfit must be > 0");
  ensure(input.stopLoss > 0, "stopLoss must be > 0");
  ensure(input.normalPayout > 1, "normalPayout must be a total-return multiplier > 1");
  ensure(input.recoveryPayout > 1, "recoveryPayout must be a total-return multiplier > 1");
  ensure(/^[A-Za-z0-9_]+$/.test(input.symbol), "symbol must be a Deriv symbol code");

  const armWindow = Math.max(12, Math.round(input.armWindow ?? 40));
  const armTimeoutTicks = Math.max(1, Math.round(input.armTimeoutTicks ?? 30));
  const breakerDepth = Math.max(3, Math.round(input.breakerDepth));
  const maxRecoverySteps = Math.max(1, Math.min(10, Math.round(input.maxRecoverySteps)));
  const markupPercent = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const normalLabel = contractLabel(input.normal);
  const recoveryLabel = contractLabel(input.recovery);
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency) ? input.currency.toUpperCase() : "USD";

  const x = new XmlBuilder();

  // Variable names — readable, since the user verifies the workspace before Run.
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
    armed: "Armed",
    armTicks: "Arm Ticks",
    hits: "Hits",
    digits: "Digits",
    digit: "Digit",
    profit: "Profit",
    lastStake: "Last Stake",
    lastReturn: "Last Return",
    message: "Message",
  } as const;

  const RECOVERY_PROC = "Size recovery stake";
  const normalWinsCond = (digitValue: string) =>
    input.normal.side === "DIGITOVER"
      ? x.compare("GT", digitValue, x.num(input.normal.barrier))
      : x.compare("LT", digitValue, x.num(input.normal.barrier));

  // ── 1. Run once at start ────────────────────────────────────────────────────
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
    x.set(V.armed, x.bool(false)),
    x.set(V.armTicks, x.num(0)),
    x.notify(
      "info",
      x.text(
        `NeuroTrade Turbo · ${input.displayName} · ${normalLabel} normal → ${recoveryLabel} recovery · ` +
          `stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · ` +
          `recovery markup ${markupPercent}% · circuit breaker ${breakerDepth} losses`,
      ),
    ),
  ];

  // ── 2. Trade options (1-tick Over/Under on the scanned market) ─────────────
  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="ntopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="ntdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="ntamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    `<value name="PREDICTION"><shadow type="math_number_positive" id="ntprd"><field name="NUM">${input.normal.barrier}</field></shadow>${x.get(V.barrier)}</value>` +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="ntmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="nttt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">overunder</field>` +
      `<next><block type="trade_definition_contracttype" id="ntct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">both</field>` +
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

  // ── 3. Purchase conditions — ARM ONCE, then fire the locked contract ───────
  const arming: Stmt[] = [
    x.set(V.armTicks, x.arith("ADD", x.get(V.armTicks), x.num(1))),
    x.set(V.digits, x.lastN(x.lastDigitList(), armWindow)),
    x.set(V.hits, x.num(0)),
    x.forEach(V.digit, x.get(V.digits), [
      x.ifElse([
        { cond: normalWinsCond(x.get(V.digit)), then: [x.set(V.hits, x.arith("ADD", x.get(V.hits), x.num(1)))] },
      ]),
    ]),
    x.ifElse([
      {
        cond: x.logic(
          "OR",
          x.logic(
            "AND",
            x.compare("GTE", x.length(x.get(V.digits)), x.num(12)),
            x.compare(
              "GTE",
              x.arith("DIVIDE", x.get(V.hits), x.length(x.get(V.digits))),
              x.arith("DIVIDE", x.num(1), x.get(V.normPayout)),
            ),
          ),
          x.compare("GTE", x.get(V.armTicks), x.num(armTimeoutTicks)),
        ),
        then: [
          x.set(V.armed, x.bool(true)),
          x.notify(
            "success",
            x.text(`Armed on ${input.displayName} — ${normalLabel} entry confirmed, starting the non-stop run`),
          ),
        ],
      },
    ]),
  ];

  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      x.ifElse([{ cond: x.compare("EQ", x.get(V.armed), x.bool(false)), then: arming }]),
      x.ifElse([
        {
          cond: x.compare("EQ", x.get(V.armed), x.bool(true)),
          then: [
            x.ifElse(
              [{ cond: x.compare("EQ", x.get(V.contract), x.text("DIGITOVER")), then: [x.purchase("DIGITOVER")] }],
              [x.purchase("DIGITUNDER")],
            ),
          ],
        },
      ]),
    ])}</statement>`,
    0,
    900,
  );

  // ── 4. Recovery stake sizing — the shared bot formula ──────────────────────
  //   raw   = debt × (1 + markup/100) / (recovery payout − 1)
  //   stake = roundUp₂( clamp(raw, 0.35, maxStake) ), then never above balance
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
    // Round UP to cents with the engine's 1e-9 guard (`roundRecoveryStakeUp`)
    // so IEEE noise on an exact cent never adds a phantom cent.
    x.set(
      V.stake,
      x.arith(
        "DIVIDE",
        x.round(
          "ROUNDUP",
          x.arith("MULTIPLY", x.arith("MINUS", x.get(V.stake), x.num(0.000000001)), x.num(100)),
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
            x.arith("DIVIDE", x.round("ROUNDDOWN", x.arith("MULTIPLY", x.balance(), x.num(100))), x.num(100)),
          ),
        ],
      },
    ]),
    x.ifElse([{ cond: x.compare("LT", x.get(V.stake), x.num(0.35)), then: [x.set(V.stake, x.num(0.35))] }]),
  ];

  const recoveryProc = x.topLevel(
    "procedures_defnoreturn",
    `<field name="NAME">${esc(RECOVERY_PROC)}</field><statement name="STACK">${x.chain(sizeRecoveryStake)}</statement>`,
    1000,
    900,
  );

  // ── 5. Restart trading conditions — the shared recovery ledger ─────────────
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
    x.notify("success", x.text(`Recovery complete — debt cleared, back to ${normalLabel} at base stake`)),
  ];
  const onRecoveryWinPartial: Stmt[] = [
    x.call(RECOVERY_PROC),
    // Deriv's text_join glues its parts with a single space.
    x.joinInto(V.message, [
      x.text("Partial recovery —"),
      x.get(V.debt),
      x.text(`${currency} debt remains, next ${recoveryLabel} stake`),
      x.get(V.stake),
      x.text(currency),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onLoss: Stmt[] = [
    x.set(V.lossRun, x.arith("ADD", x.get(V.lossRun), x.num(1))),
    x.ifElse([{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: deepenRecovery }], enterRecovery),
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [
      x.text("Recovery step"),
      x.get(V.step),
      x.text(`— ${recoveryLabel} at`),
      x.get(V.stake),
      x.text(`${currency} to clear`),
      x.get(V.debt),
      x.text(currency),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onWin: Stmt[] = [
    x.set(V.lossRun, x.num(0)),
    // Refresh the realised payout multiplier of the leg that just won.
    x.ifElse([
      {
        cond: x.compare("GT", x.get(V.lastStake), x.num(0)),
        then: [
          x.ifElse(
            [
              {
                cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
                then: [x.set(V.recPayout, x.arith("DIVIDE", x.get(V.lastReturn), x.get(V.lastStake)))],
              },
            ],
            [x.set(V.normPayout, x.arith("DIVIDE", x.get(V.lastReturn), x.get(V.lastStake)))],
          ),
        ],
      },
    ]),
    x.ifElse([
      {
        cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
        then: [
          x.set(V.debt, x.arith("MINUS", x.get(V.debt), x.get(V.profit))),
          x.ifElse([{ cond: x.compare("LTE", x.get(V.debt), x.num(0.005)), then: exitRecovery }], onRecoveryWinPartial),
        ],
      },
    ]),
  ];
  const boundaries: Stmt = x.ifElse(
    [
      {
        cond: x.compare("GTE", x.totalProfit(), x.num(input.takeProfit)),
        then: [x.notify("success", x.text(`Take profit ${money(input.takeProfit)} ${currency} reached — session complete`), "job-done")],
      },
      {
        cond: x.compare("LTE", x.totalProfit(), x.num(-input.stopLoss)),
        then: [x.notify("error", x.text(`Stop loss ${money(input.stopLoss)} ${currency} hit — session stopped`), "error")],
      },
      {
        cond: x.compare("GTE", x.get(V.lossRun), x.num(breakerDepth)),
        then: [
          x.notify(
            "error",
            x.text(
              `Circuit breaker: ${breakerDepth} consecutive losses exceeds the depth this lock was modelled for — re-scan before redeploying`,
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

  // Definitions first so every caller resolves its procedure on load.
  const xml =
    `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">` +
    x.variablesXml() +
    tradeDefinition +
    recoveryProc +
    beforePurchase +
    afterPurchase +
    `</xml>`;

  const name = `NeuroTrade Turbo ${input.symbol} ${normalLabel} to ${recoveryLabel}`;

  return {
    name,
    xml,
    summary: {
      symbol: input.symbol,
      displayName: input.displayName,
      market,
      submarket,
      normal: normalLabel,
      recovery: recoveryLabel,
      stake: input.stake,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      maxRecoverySteps,
      markupPercent,
      maxStake,
      normalPayout: input.normalPayout,
      recoveryPayout: input.recoveryPayout,
      breakerDepth,
      armWindow,
      armTimeoutTicks,
      currency,
    },
  };
}
