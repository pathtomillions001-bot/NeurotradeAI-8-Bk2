/**
 * Dual-Lock Range Sentinel → Deriv DBot strategy generator.
 *
 * WHAT THIS IS
 * ────────────
 *   The Dual-Lock scan (`dual-lock-engine.scanForLock`) finds ONE best
 *   (market, normal Over/Under barrier, recovery Over/Under barrier) triple and
 *   commits the session's stake / take-profit / stop-loss / recovery depth.
 *   Normally the user deploys it into NeuroTrade's own executor. "Create DBot"
 *   instead turns that exact triple — plus those committed session numbers and
 *   the shared bot recovery rules — into a NeuroTrade Deriv Bot (Blockly)
 *   strategy the user opens in the embedded builder, verifies, and runs with
 *   Deriv's own Run button.
 *
 * HOW THIS DIFFERS FROM THE OVER/UNDER TURBO DBOT (the intentional, only diff)
 * ──────────────────────────────────────────────────────────────────────────
 *   The Turbo DBot carries its OWN analysis while it runs: it arms once on a
 *   live hit-rate, and every recovery attempt waits for an in-bot Bayesian
 *   timing gate (`nt_analyse_turbo_recovery` / `nt_turbo_recovery_decision`).
 *
 *   The Dual-Lock DBot does almost none of that. The analysis already happened
 *   during the scan that produced the lock; the generated bot simply EXECUTES
 *   it. The ONE thing it times is the very first entry of the run (see below):
 *     · it fires the locked normal contract every tick, no arming, no gate;
 *     · on a loss it fires the locked recovery contract every tick at the
 *       recovery-ladder stake — again no timing analysis;
 *     · it keeps going until take-profit, stop-loss, the circuit breaker, or
 *       the user stops the bot.
 *   Apart from the first-entry gate this generator emits only stock Deriv-Bot
 *   blocks (including the real `purchase` block), so it loads and runs through
 *   the builder's normal path exactly like a hand-built strategy.
 *
 * FIRST-ENTRY TIMING (the only in-bot analysis, and it runs at most once)
 * ──────────────────────────────────────────────────────────────────────
 *   Pressing Run is a human event; the tape does not care. Starting inside a
 *   burst of range violations dragged the very first trade into the recovery
 *   ladder. So before the FIRST purchase — and only that one — the bot asks
 *   `nt_analyse_dual_lock_entry` whether the next tick is a defensible start:
 *
 *     · recency-weighted Beta baseline of the locked contract's hit rate;
 *     · state-conditional Markov confidence, shrunk toward that baseline;
 *     · violation-cluster guards (clean ticks since the last miss, misses in
 *       the last 5);
 *     · a threshold that DECAYS from the tape's optimistic rate to its
 *       pessimistic rate across a patience budget (default 12 ticks), so the
 *       bar is expressed in the tape's own units — meaningful on every market
 *       and every locked barrier without tuning — and cannot deadlock;
 *     · a hard deadline: at the patience budget the gate opens regardless
 *       (even with a dead tick feed), bounding the wait to ~12 ticks so the
 *       scanned edge cannot go stale.
 *
 *   The gate can only DELAY the start. It never changes the market, side,
 *   barrier, stake or ladder, and once the first trade is placed the bot is
 *   the same non-stop executor it has always been — no further analysis on any
 *   later normal or recovery trade.
 *
 * WHAT THE GENERATED BOT DOES (1:1 with Dual-Lock's locked, non-stop executor)
 * ──────────────────────────────────────────────────────────────────────────
 *   · Trades the scanned market only, 1-tick Over/Under digit contracts.
 *   · Normal entries fire continuously (no arming, no re-analysis).
 *   · Recovery stake = debt × (1 + markup %) / (payout − 1), floored at $0.35,
 *     capped at the account's max trade stake and at the live balance, rounded
 *     UP to cents — the same `getBotRecoveryStake` maths as every specialist bot.
 *   · A recovery win pays the net profit into the debt; recovery ends the moment
 *     debt reaches zero (a partial win keeps recovery active on the remainder).
 *   · Circuit breaker: `breakerDepth` consecutive losses stops the bot (the
 *     Dual-Lock engine's only non-TP/SL halt).
 *   · Take-profit / stop-loss on Deriv's own total-profit counter end the run.
 *
 *   Deriv Bot fixes the market in its trade definition, so — exactly like the
 *   Turbo DBot — the generated bot is a LOCKED bot (no market switching).
 */

import {
  contractLabel,
  isNormalContract,
  isRecoveryContract,
  type DualLockContract,
} from "./dual-lock-analysis";
import { marketPathForSymbol } from "./overunder-turbo-dbot";
import { XmlBuilder, esc, money, type Stmt } from "./dbot-xml";

// ── Public types ──────────────────────────────────────────────────────────────

export interface DualLockDbotInput {
  symbol: string;
  displayName: string;
  normal: DualLockContract;
  recovery: DualLockContract;
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
  /** Digits the first-entry timing gate inspects (default 120, 40–300). */
  entryWindow?: number;
  /** Hard deadline for the first-entry gate, in ticks (default 12, 3–40). */
  entryPatience?: number;
}

export interface DualLockDbotStrategy {
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
    currency: string;
    /** Digits the first-entry timing gate inspects. */
    entryWindow: number;
    /** Hard deadline for the first-entry gate, in ticks. */
    entryPatience: number;
  };
}

/**
 * Every block type the generated strategy may contain. It is a strict SUBSET of
 * the Turbo DBot's — the Dual-Lock bot takes trades with NO in-bot analysis, so
 * there are no `nt_*` analysis blocks and none of the list/loop blocks arming
 * used. Only stock Deriv-Bot blocks the builder registers appear here.
 */
export const DUAL_LOCK_DBOT_BLOCK_TYPES = Object.freeze([
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
  // The ONLY in-bot analysis: the first-entry timing gate (runs once per run).
  "nt_analyse_dual_lock_entry",
  "nt_dual_lock_entry_decision",
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

// ── Strategy generator ────────────────────────────────────────────────────────

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

export function buildDualLockDbotStrategy(input: DualLockDbotInput): DualLockDbotStrategy {
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

  const breakerDepth = Math.max(3, Math.round(input.breakerDepth));
  const maxRecoverySteps = Math.max(1, Math.min(10, Math.round(input.maxRecoverySteps)));
  const markupPercent = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const entryWindow = Math.max(40, Math.min(300, Math.round(input.entryWindow ?? 120)));
  const entryPatience = Math.max(3, Math.min(40, Math.round(input.entryPatience ?? 12)));
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
    profit: "Profit",
    lastStake: "Last Stake",
    lastReturn: "Last Return",
    message: "Message",
    entryTimed: "First Entry Timed",
    entryWaits: "Entry Ticks Waited",
  } as const;

  const RECOVERY_PROC = "Size recovery stake";

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
    x.set(V.entryTimed, x.bool(false)),
    x.set(V.entryWaits, x.num(0)),
    x.notify(
      "info",
      x.text(
        `NeuroTrade Dual-Lock · ${input.displayName} · ${normalLabel} normal → ${recoveryLabel} recovery · ` +
          `stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · ` +
          `first entry timed within ${entryPatience} ticks, then executes the scanned lock non-stop · ` +
          `markup ${markupPercent}% · ` +
          `circuit breaker ${breakerDepth} losses`,
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

  // ── 3. Purchase conditions — fire the locked contract, NO analysis ─────────
  // The whole point of Dual-Lock's DBot: the analysis was already done during
  // the scan, so here it just buys the current (normal or recovery) contract
  // every tick. No arming gate, no recovery-timing gate — the first entry is
  // timed once (§3b) and every trade after it fires straight away.
  const purchaseCurrentContract = () =>
    x.ifElse(
      [{ cond: x.compare("EQ", x.get(V.contract), x.text("DIGITOVER")), then: [x.purchase("DIGITOVER")] }],
      [x.purchase("DIGITUNDER")],
    );

  // ── 3b. First-entry timing gate — runs ONLY until the first purchase ───────
  // Every evaluation while `First Entry Timed` is false: count the tick, ask
  // the in-bot gate, and either start (and latch the gate open forever) or wait.
  // The gate's own deadline guarantees the latch flips within `entryPatience`
  // ticks, so the bot can never sit idle and the scanned edge cannot go stale.
  const timeFirstEntry: Stmt[] = [
    x.set(V.entryWaits, x.arith("ADD", x.get(V.entryWaits), x.num(1))),
    x.ntAnalyseDualLockEntry(
      input.normal.side,
      input.normal.barrier,
      entryWindow,
      entryPatience,
      x.get(V.entryWaits),
    ),
    x.ifElse(
      [
        {
          cond: x.compare("EQ", x.ntDualLockEntryDecision("ready"), x.bool(true)),
          then: [
            // Latch: from here on the bot never consults the tape again.
            x.set(V.entryTimed, x.bool(true)),
            x.joinInto(V.message, [
              x.text(`${normalLabel} on ${input.displayName} —`),
              x.ntDualLockEntryDecision("reason"),
            ]),
            x.notify("success", x.get(V.message)),
            purchaseCurrentContract(),
          ],
        },
        {
          // Throttled progress line so the Journal shows the wait is deliberate.
          cond: x.compare("EQ", x.mod(x.get(V.entryWaits), x.num(3)), x.num(0)),
          then: [
            x.joinInto(V.message, [x.text("Waiting for a clean start —"), x.ntDualLockEntryDecision("reason")]),
            x.notify("info", x.get(V.message)),
          ],
        },
      ],
    ),
  ];

  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      x.ifElse(
        [{ cond: x.compare("EQ", x.get(V.entryTimed), x.bool(true)), then: [purchaseCurrentContract()] }],
        timeFirstEntry,
      ),
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
      x.text(`— ${recoveryLabel} sized at`),
      x.get(V.stake),
      x.text(`${currency} to clear`),
      x.get(V.debt),
      x.text(`${currency} · firing back-to-back`),
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

  const name = `NeuroTrade Dual-Lock ${input.symbol} ${normalLabel} to ${recoveryLabel}`;

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
      currency,
      entryWindow,
      entryPatience,
    },
  };
}
