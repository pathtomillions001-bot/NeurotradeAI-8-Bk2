/**
 * Digit Forge → Deriv DBot strategy generator.
 *
 * WHAT THIS IS
 * ────────────
 *   The Forge bot has NO scan step. The user opens its console, sets their
 *   numbers, presses "Create DBot", and the API renders a Deriv Bot (Blockly)
 *   strategy that does its OWN analysis while it runs — there is no NeuroTrade
 *   engine, agent or AI in the loop once Deriv's Run button is pressed.
 *
 * WHAT THE GENERATED BOT DOES
 * ───────────────────────────
 *   · Trades 1-tick Over/Under digit contracts on the chosen market.
 *   · NORMAL mode (no debt): fires only when its own live measurement of the
 *     tape clears a statistical gate (§ "The gate" below).
 *   · RECOVERY mode (debt outstanding): re-ranks the two recovery barriers (Over 5 / Under 4), then
 *     waits for a stable, loss-conditioned edge confirmed on two distinct
 *     ticks. Multi-horizon agreement, clustering and adverse-run vetoes keep a
 *     growing stake out of a hostile regime. The stake is the shared recovery
 *     ladder, identical to every other bot.
 *   · Circuit breaker on consecutive losses; take-profit / stop-loss on Deriv's
 *     own total-profit counter end the run.
 *
 * THE GATE (all of this is computed INSIDE the workspace, every tick)
 * ──────────────────────────────────────────────────────────────────
 *   Over the last W digits of the live tape, with S = the normal contract's
 *   winning digit set and k = |{d ∈ S}|:
 *
 *   1. Agresti–Coull lower confidence bound (one-sided, z = 1.645):
 *        ñ    = W + z²
 *        p̃    = (k + z²/2) / ñ
 *        p_lo = p̃ − z·√(p̃(1−p̃)/ñ)
 *      Fire only when p_lo > 1/payout. Comparing the LOWER BOUND to break-even
 *      — never the point estimate — is what stops the bot trading its own noise.
 *
 *   2. Two-state Markov chain on Xt = 1{dt ∈ S}, add-one smoothed, with a
 *      likelihood-ratio test for whether the dependence is real at all:
 *        G² = 2·Σ n_ij·ln( n_ij·N / (row_i·col_j) )     ~ χ²(1)
 *      When G² > 3.84 (p < 0.05) the chain is trusted and the conditional rate
 *      from the CURRENT state must also clear break-even. Below 3.84 the tape
 *      is treated as i.i.d. and the chain is ignored. A full 10×10 chain would
 *      have 90 free parameters and ~10 observations per cell — noise — so the
 *      digits are collapsed onto the contract's own win/lose partition first.
 *
 *   3. Streak cooldown: the trailing adverse run must be shorter than the
 *      window's expected maximum, ln(W(1−q))/ln(1/q) + 2·1.2825/ln(1/q).
 *      Clustered losses are what turn a depth-4 ladder into a depth-7 event.
 *
 * NEUROTRADE ADAPTIVE BLOCKS
 * ──────────────────────────
 *   The vendored builder ranks legal pairs with `nt_analyse_digit_markets`,
 *   reads the decision with `nt_digit_decision`, and retargets with
 *   `nt_switch_market`. `nt_prepare_digit_trade` quotes that exact tuple before
 *   sizing; `nt_purchase_digit_trade` validates it again and buys a fresh quote
 *   at the calculated stake. This XML requires NeuroTrade's builder, not the
 *   unmodified app.deriv.com builder.
 */

import { contractLabel, type TurboContract } from "./overunder-turbo-analysis";
import { XmlBuilder, esc, money, type Stmt } from "./dbot-xml";
import { marketPathForSymbol } from "./overunder-turbo-dbot";

// ── Public types ──────────────────────────────────────────────────────────────

/** The ONLY contracts Digit Forge may rank for normal (non-recovery) trades. */
export const DIGIT_FORGE_NORMAL_CONTRACTS: readonly TurboContract[] =
  Object.freeze([
    { side: "DIGITOVER", barrier: 1 },
    { side: "DIGITOVER", barrier: 2 },
    { side: "DIGITUNDER", barrier: 7 },
    { side: "DIGITUNDER", barrier: 8 },
  ]);

/** The ONLY contracts Digit Forge may rank for recovery trades. */
export const DIGIT_FORGE_RECOVERY_CONTRACTS: readonly TurboContract[] =
  Object.freeze([
    { side: "DIGITOVER", barrier: 5 },
    { side: "DIGITUNDER", barrier: 4 },
  ]);

export function isDigitForgeNormalContract(
  side: unknown,
  barrier: unknown,
): boolean {
  return DIGIT_FORGE_NORMAL_CONTRACTS.some(
    (c) => c.side === side && c.barrier === barrier,
  );
}

export function isDigitForgeRecoveryContract(
  side: unknown,
  barrier: unknown,
): boolean {
  return DIGIT_FORGE_RECOVERY_CONTRACTS.some(
    (c) => c.side === side && c.barrier === barrier,
  );
}

export interface DigitForgeInput {
  symbol: string;
  displayName: string;
  /** Over 1 / Over 2 / Under 7 / Under 8. */
  normal: TurboContract;
  /** Over 5 / Under 4 only. */
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
  /** Total-return payout multipliers (stake included), e.g. Over 5 ≈ 2.43. */
  normalPayout: number;
  recoveryPayout: number;
  /** Consecutive losses that halt the bot. */
  breakerDepth: number;
  currency: string;
  /** Digits inspected by the live gate (default 120, capped at 300). */
  window?: number;
  /** Minimum digits before the gate may pass at all (default 30). */
  minSamples?: number;
  /** Confidence for the lower bound: 1.282 = 90 %, 1.645 = 95 %, 2.326 = 99 %. */
  confidenceZ?: number;
  /** Evaluations before entering WITHOUT a confirmed edge. 0 = never force. */
  forceEntryAfter?: number;
  /** Include the Markov / G² clause (default true). */
  useMarkov?: boolean;
  /** Include the streak cooldown clause (default true). */
  useStreakCooldown?: boolean;
  /** Markets ranked inside the running DBot (starting market first, at most eight). */
  watchMarkets?: string[];
}

export interface DigitForgeStrategy {
  name: string;
  /** Blockly workspace XML (`is_dbot="true"`). */
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
    window: number;
    minSamples: number;
    confidenceZ: number;
    forceEntryAfter: number;
    useMarkov: boolean;
    useStreakCooldown: boolean;
    runLimit: number;
    breakEven: number;
    watchMarkets: string[];
    /** Expected cost of one full ladder, for the panel's risk sentence. */
    ladder: {
      debtGrowthPerStep: number;
      capitalAtRisk: number;
      failureProbability: number;
    };
  };
}

/** Every block type the generated strategy may contain, including our builder extensions. */
export const DIGIT_FORGE_BLOCK_TYPES = Object.freeze([
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
  "nt_prepare_digit_trade",
  "nt_purchase_digit_trade",
  "trade_again",
  "contract_check_result",
  "read_details",
  "total_profit",
  "balance",
  "lastDigitList",
  "nt_analyse_digit_markets",
  "nt_digit_decision",
  "nt_switch_market",
  "lists_getSublist",
  "lists_length",
  "controls_forEach",
  "controls_if",
  "logic_compare",
  "logic_operation",
  "logic_boolean",
  "math_number",
  "math_number_positive",
  "math_arithmetic",
  "math_round",
  "math_constrain",
  "math_single",
  "math_modulo",
  "variables_set",
  "variables_get",
  "text",
  "text_join",
  "text_statement",
  "notify",
  "procedures_defnoreturn",
  "procedures_callnoreturn",
] as const);

// ── Forge-time maths (mirrored by the XML, computed here for the summary) ─────

/** Theoretical win probability of a digit barrier on a uniform tape. */
export function fairWinRate(c: TurboContract): number {
  return c.side === "DIGITOVER" ? (9 - c.barrier) / 10 : c.barrier / 10;
}

/**
 * Longest adverse run the window should produce by chance:
 * E[R] = ln(W(1−q))/ln(1/q), sd ≈ 1.2825/ln(1/q), limit = ceil(E[R] + 2·sd).
 * A trailing run longer than this is the bot's "losses are clustering" signal.
 */
export function expectedMaxRun(windowSize: number, lossRate: number): number {
  const q = Math.min(0.999, Math.max(0.001, lossRate));
  const denom = Math.log(1 / q);
  const mean = Math.log(Math.max(1, windowSize * (1 - q))) / denom;
  const sd = 1.2825 / denom;
  return Math.max(3, Math.ceil(mean + 2 * sd));
}

/**
 * Recovery ladder shape for the panel's risk disclosure. With
 * `stake = debt·(1+m)/(payout−1)`, a failed step multiplies debt by
 * `1 + (1+m)/(payout−1)`, so surviving depth k needs the cumulative stake.
 */
export function ladderRisk(
  payout: number,
  markupPercent: number,
  depth: number,
  winRate: number,
): {
  debtGrowthPerStep: number;
  capitalAtRisk: number;
  failureProbability: number;
} {
  const rate = (1 + markupPercent / 100) / (payout - 1);
  const growth = 1 + rate;
  let capital = 0;
  for (let k = 1; k <= depth; k += 1) capital += Math.pow(growth, k - 1) * rate;
  return {
    debtGrowthPerStep: Math.round(growth * 1000) / 1000,
    capitalAtRisk: Math.round(capital * 100) / 100,
    failureProbability:
      Math.round(Math.pow(1 - winRate, depth) * 10000) / 10000,
  };
}

// ── Strategy generator ────────────────────────────────────────────────────────

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

export function buildDigitForgeStrategy(
  input: DigitForgeInput,
): DigitForgeStrategy {
  ensure(
    isDigitForgeNormalContract(input.normal.side, input.normal.barrier),
    "normal must be one of Over 1, Over 2, Under 7, Under 8",
  );
  ensure(
    isDigitForgeRecoveryContract(input.recovery.side, input.recovery.barrier),
    "recovery must be one of Over 5 or Under 4",
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

  // Window is capped because `before_purchase` runs on EVERY tick and the
  // JS-Interpreter is step-limited: an O(W) rescan of 300 digits per tick is
  // the most the sandbox absorbs without visibly stalling the bot.
  const windowSize = Math.max(
    20,
    Math.min(300, Math.round(input.window ?? 120)),
  );
  const minSamples = Math.max(
    10,
    Math.min(windowSize, Math.round(input.minSamples ?? 30)),
  );
  const z = Math.max(0, Math.min(3, input.confidenceZ ?? 1.645));
  const forceEntryAfter = Math.max(0, Math.round(input.forceEntryAfter ?? 0));
  const useMarkov = input.useMarkov !== false;
  const useStreakCooldown = input.useStreakCooldown !== false;
  const breakerDepth = Math.max(3, Math.round(input.breakerDepth));
  const maxRecoverySteps = Math.max(
    1,
    Math.min(10, Math.round(input.maxRecoverySteps)),
  );
  const markupPercent = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const normalLabel = contractLabel(input.normal);
  const recoveryLabel = contractLabel(input.recovery);
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency)
    ? input.currency.toUpperCase()
    : "USD";
  const watchMarkets = [input.symbol, ...(input.watchMarkets ?? [])]
    .filter((s, i, all) => /^[A-Za-z0-9_]+$/.test(s) && all.indexOf(s) === i)
    .slice(0, 8);

  const zSquared = Math.round(z * z * 1e6) / 1e6;
  const halfZSquared = Math.round(((z * z) / 2) * 1e6) / 1e6;
  const runLimit = expectedMaxRun(windowSize, 1 - fairWinRate(input.normal));
  const breakEven = Math.round((1 / input.normalPayout) * 10000) / 10000;

  const x = new XmlBuilder();
  // Deriv's math_number validator rejects scientific notation; a literal 1e-9
  // silently loads as 0. Build the shared money-rounding epsilon arithmetically
  // so an exact-cent result such as 0.55 never rounds up to 0.56.
  const moneyEpsilon = (): string => x.arith("DIVIDE", x.num(1), x.num(1_000_000_000));

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
    // Live measurement
    digits: "Digits",
    digit: "Digit",
    windowN: "Window Size",
    hits: "Hits",
    cur: "Is Win",
    prev: "Prev State",
    runNow: "Adverse Run",
    nTilde: "N Adjusted",
    pTilde: "P Adjusted",
    pLo: "Worst Case Rate",
    breakEven: "Break Even",
    n00: "Loss to Loss",
    n01: "Loss to Win",
    n10: "Win to Loss",
    n11: "Win to Win",
    row0: "Row Loss",
    row1: "Row Win",
    col0: "Col Loss",
    col1: "Col Win",
    pairs: "Pairs",
    g2: "Dependence G2",
    pCond: "Conditional Rate",
    gate: "Gate Pass",
    fire: "Fire",
    forced: "Forced Normal Entry",
    livePayout: "Live Payout",
    stakeLimit: "Stake Limit",
    evalTicks: "Evaluations",
    activeSymbol: "Active Market",
    decisionReason: "Analysis Reason",
    decisionScore: "Analysis Score",
    // Settlement
    profit: "Profit",
    lastStake: "Last Stake",
    lastReturn: "Last Return",
    message: "Message",
  } as const;

  const RECOVERY_PROC = "Size recovery stake";
  const MEASURE_PROC = "Measure the tape";

  /** Digit is a WIN for the normal contract. */
  const normalWins = (digitValue: string) =>
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
    x.set(V.evalTicks, x.num(0)),
    x.set(V.activeSymbol, x.text(input.symbol)),
    x.set(V.decisionReason, x.text("analysis warming up")),
    x.set(V.decisionScore, x.num(0)),
    x.set(V.gate, x.bool(false)),
    x.notify(
      "info",
      x.text(
        `NeuroTrade Digit Forge · ${input.displayName} · ${normalLabel} normal → ${recoveryLabel} recovery · ` +
          `stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · ` +
          `${windowSize}-digit window checked across ${watchMarkets.length} market${watchMarkets.length === 1 ? "" : "s"} · ` +
          `recovery markup ${markupPercent}% · circuit breaker ${breakerDepth} losses`,
      ),
    ),
  ];

  // ── 2. Trade options — 1-tick Over/Under, stake and barrier from variables ──
  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="dfopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="dfdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="dfamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    `<value name="PREDICTION"><shadow type="math_number_positive" id="dfprd"><field name="NUM">${input.normal.barrier}</field></shadow>${x.get(V.barrier)}</value>` +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="dfmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="dftt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">overunder</field>` +
      `<next><block type="trade_definition_contracttype" id="dfct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">both</field>` +
      `<next><block type="trade_definition_candleinterval" id="dfci" deletable="false" movable="false">` +
      `<field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="dfrb" deletable="false" movable="false">` +
      `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="dfre" deletable="false" movable="false">` +
      // Quotes retry safely by holding for a new scan. A BUY error may mean
      // the contract exists: stop for reconciliation, never auto-replay it.
      `<field name="RESTARTONERROR">FALSE</field>` +
      `</block></next></block></next></block></next></block></next></block></next></block>` +
      `</statement>` +
      `<statement name="INITIALIZATION">${x.chain(init)}</statement>` +
      // The trade options MUST be unconditional: the interpreter's loop spins on
      // sleep(1) forever — no error, no trades — while
      // BinaryBotPrivateHasCalledTradeOptions is false.
      `<statement name="SUBMARKET">${tradeOptions}</statement>`,
    0,
    0,
  );

  // ── 3. "Measure the tape" — the whole statistical gate, in-workspace ────────
  const measure: Stmt[] = [
    x.set(V.digits, x.lastN(x.lastDigitList(), windowSize)),
    x.set(V.windowN, x.length(x.get(V.digits))),
    x.set(V.hits, x.num(0)),
    x.set(V.runNow, x.num(0)),
    x.set(V.n00, x.num(0)),
    x.set(V.n01, x.num(0)),
    x.set(V.n10, x.num(0)),
    x.set(V.n11, x.num(0)),
    // -1 marks "no previous digit yet", so the first digit starts no pair.
    x.set(V.prev, x.num(-1)),
    x.forEach(V.digit, x.get(V.digits), [
      x.ifElse(
        [{ cond: normalWins(x.get(V.digit)), then: [x.set(V.cur, x.num(1))] }],
        [x.set(V.cur, x.num(0))],
      ),
      x.set(V.hits, x.arith("ADD", x.get(V.hits), x.get(V.cur))),
      // Trailing adverse run: resets on every win, so after the loop it holds
      // the length of the losing streak the tape is sitting in right now.
      x.ifElse(
        [
          {
            cond: x.compare("EQ", x.get(V.cur), x.num(0)),
            then: [x.set(V.runNow, x.arith("ADD", x.get(V.runNow), x.num(1)))],
          },
        ],
        [x.set(V.runNow, x.num(0))],
      ),
      x.ifElse([
        {
          cond: x.compare("EQ", x.get(V.prev), x.num(0)),
          then: [
            x.ifElse(
              [
                {
                  cond: x.compare("EQ", x.get(V.cur), x.num(0)),
                  then: [x.set(V.n00, x.arith("ADD", x.get(V.n00), x.num(1)))],
                },
              ],
              [x.set(V.n01, x.arith("ADD", x.get(V.n01), x.num(1)))],
            ),
          ],
        },
        {
          cond: x.compare("EQ", x.get(V.prev), x.num(1)),
          then: [
            x.ifElse(
              [
                {
                  cond: x.compare("EQ", x.get(V.cur), x.num(0)),
                  then: [x.set(V.n10, x.arith("ADD", x.get(V.n10), x.num(1)))],
                },
              ],
              [x.set(V.n11, x.arith("ADD", x.get(V.n11), x.num(1)))],
            ),
          ],
        },
      ]),
      x.set(V.prev, x.get(V.cur)),
    ]),

    // Agresti–Coull one-sided lower bound.
    x.set(V.nTilde, x.arith("ADD", x.get(V.windowN), x.num(zSquared))),
    x.set(
      V.pTilde,
      x.arith(
        "DIVIDE",
        x.arith("ADD", x.get(V.hits), x.num(halfZSquared)),
        x.get(V.nTilde),
      ),
    ),
    x.set(
      V.pLo,
      x.arith(
        "MINUS",
        x.get(V.pTilde),
        x.arith(
          "MULTIPLY",
          x.num(z),
          x.single(
            "ROOT",
            x.arith(
              "DIVIDE",
              x.arith(
                "MULTIPLY",
                x.get(V.pTilde),
                x.arith("MINUS", x.num(1), x.get(V.pTilde)),
              ),
              x.get(V.nTilde),
            ),
          ),
        ),
      ),
    ),
    // Break-even tracks the REALISED payout (refreshed after every win), so the
    // gate follows the price Deriv is actually paying, not a static table.
    x.set(V.breakEven, x.arith("DIVIDE", x.num(1), x.get(V.normPayout))),
  ];

  if (useMarkov) {
    const g2Term = (count: string, row: string, col: string): Stmt =>
      x.ifElse([
        {
          cond: x.compare("GT", x.get(count), x.num(0)),
          then: [
            x.set(
              V.g2,
              x.arith(
                "ADD",
                x.get(V.g2),
                x.arith(
                  "MULTIPLY",
                  x.get(count),
                  x.single(
                    "LN",
                    x.arith(
                      "DIVIDE",
                      x.arith("MULTIPLY", x.get(count), x.get(V.pairs)),
                      x.arith("MULTIPLY", x.get(row), x.get(col)),
                    ),
                  ),
                ),
              ),
            ),
          ],
        },
      ]);

    measure.push(
      x.set(V.row0, x.arith("ADD", x.get(V.n00), x.get(V.n01))),
      x.set(V.row1, x.arith("ADD", x.get(V.n10), x.get(V.n11))),
      x.set(V.col0, x.arith("ADD", x.get(V.n00), x.get(V.n10))),
      x.set(V.col1, x.arith("ADD", x.get(V.n01), x.get(V.n11))),
      x.set(V.pairs, x.arith("ADD", x.get(V.row0), x.get(V.row1))),
      x.set(V.g2, x.num(0)),
      // Every term is guarded: a zero cell contributes 0 (0·ln0 → 0) and the
      // row/col products would otherwise divide by zero.
      x.ifElse([
        {
          cond: x.all("AND", [
            x.compare("GT", x.get(V.pairs), x.num(0)),
            x.compare("GT", x.get(V.row0), x.num(0)),
            x.compare("GT", x.get(V.row1), x.num(0)),
            x.compare("GT", x.get(V.col0), x.num(0)),
            x.compare("GT", x.get(V.col1), x.num(0)),
          ]),
          then: [
            g2Term(V.n00, V.row0, V.col0),
            g2Term(V.n01, V.row0, V.col1),
            g2Term(V.n10, V.row1, V.col0),
            g2Term(V.n11, V.row1, V.col1),
            x.set(V.g2, x.arith("MULTIPLY", x.num(2), x.get(V.g2))),
          ],
        },
      ]),
      // Add-one smoothed conditional rate from the state the tape is in NOW
      // (Prev holds the last digit's membership after the loop).
      x.ifElse(
        [
          {
            cond: x.compare("EQ", x.get(V.prev), x.num(1)),
            then: [
              x.set(
                V.pCond,
                x.arith(
                  "DIVIDE",
                  x.arith("ADD", x.get(V.n11), x.num(1)),
                  x.arith("ADD", x.get(V.row1), x.num(2)),
                ),
              ),
            ],
          },
        ],
        [
          x.set(
            V.pCond,
            x.arith(
              "DIVIDE",
              x.arith("ADD", x.get(V.n01), x.num(1)),
              x.arith("ADD", x.get(V.row0), x.num(2)),
            ),
          ),
        ],
      ),
    );
  }

  // The gate itself — every clause must hold.
  const gateClauses: string[] = [
    x.compare("GTE", x.get(V.windowN), x.num(minSamples)),
    x.compare("GT", x.get(V.pLo), x.get(V.breakEven)),
  ];
  if (useStreakCooldown)
    gateClauses.push(x.compare("LT", x.get(V.runNow), x.num(runLimit)));
  if (useMarkov) {
    // χ²(1) at 5 %: below 3.84 the chain is indistinguishable from i.i.d., so
    // it must not veto — above it, the conditional rate has to clear break-even.
    gateClauses.push(
      x.logic(
        "OR",
        x.compare("LTE", x.get(V.g2), x.num(3.84)),
        x.compare("GT", x.get(V.pCond), x.get(V.breakEven)),
      ),
    );
  }
  measure.push(
    x.set(V.gate, x.bool(false)),
    x.ifElse([
      { cond: x.all("AND", gateClauses), then: [x.set(V.gate, x.bool(true))] },
    ]),
  );

  const measureProc = x.topLevel(
    "procedures_defnoreturn",
    `<field name="NAME">${esc(MEASURE_PROC)}</field><statement name="STACK">${x.chain(measure)}</statement>`,
    0,
    1500,
  );

  // ── 4. Purchase conditions ─────────────────────────────────────────────────
  // ── Journal transparency (deliberately minimal) ───────────────────────────
  // The Journal shows the STATE and the SUBJECT of each decision — which
  // market, which contract, holding vs entering — and never the score, EV,
  // lower bound, Markov row or clustering ratio behind it. Same contract as
  // Omni Forge's journal, so both generated bots read identically.
  const waitingReport: Stmt[] = [
    x.joinInto(V.message, [
      x.text("ANALYSING"),
      x.get(V.activeSymbol),
      x.text("· no qualified setup yet — holding"),
    ]),
    x.notify("info", x.get(V.message)),
  ];

  // A factory, not a shared array: every emission needs its own block ids.
  const entryReport = (): Stmt[] => [
    x.joinInto(V.message, [
      x.text("ENTRY ·"),
      x.get(V.activeSymbol),
      x.text("·"),
      x.get(V.contract),
      x.get(V.barrier),
      x.text("· stake"),
      x.get(V.stake),
      x.text(currency),
    ]),
    x.notify("success", x.get(V.message)),
  ];

  const readAdaptiveDecision: Stmt[] = [
    x.set(V.activeSymbol, x.ntDecision("symbol")),
    x.set(V.contract, x.ntDecision("contract")),
    x.set(V.barrier, x.ntDecision("barrier")),
    x.set(V.decisionScore, x.ntDecision("score")),
    x.set(V.decisionReason, x.ntDecision("reason")),
    x.set(V.gate, x.ntDecision("eligible")),
    x.ifElse(
      [
        {
          cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
          then: [x.set(V.recPayout, x.ntDecision("payout"))],
        },
      ],
      [x.set(V.normPayout, x.ntDecision("payout"))],
    ),
  ];

  const adaptiveEntry: Stmt[] = [
    x.set(V.evalTicks, x.arith("ADD", x.get(V.evalTicks), x.num(1))),
    x.ifElse(
      [
        {
          cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
          then: [x.ntAnalyse("RECOVERY", watchMarkets, windowSize)],
        },
      ],
      [x.ntAnalyse("NORMAL", watchMarkets, windowSize)],
    ),
    ...readAdaptiveDecision,
    x.ifElse([
      {
        cond: x.compare("EQ", x.ntDecision("changedMarket"), x.bool(true)),
        then: [
          x.ntSwitchMarket(x.get(V.activeSymbol)),
          x.joinInto(V.message, [
            x.text("MARKET SWITCH REQUEST ·"),
            x.get(V.activeSymbol),
          ]),
          x.notify("info", x.get(V.message)),
        ],
      },
      {
        cond: x.compare("EQ", x.get(V.gate), x.bool(true)),
        then: [x.set(V.fire, x.bool(true))],
      },
      ...(forceEntryAfter > 0
        ? [
            {
              // Patience may relax a NORMAL statistical gate, never the
              // recovery confirmation/regime gate or the execution allowlist.
              cond: x.all("AND", [
                x.compare("EQ", x.get(V.inRecovery), x.bool(false)),
                x.compare("GTE", x.get(V.evalTicks), x.num(forceEntryAfter)),
              ]),
              then: [
                x.notify(
                  "warn",
                  x.text(
                    `Patience limit ${forceEntryAfter}: entering on the best available setup`,
                  ),
                ),
                x.set(V.forced, x.bool(true)),
                x.set(V.fire, x.bool(true)),
              ],
            },
          ]
        : []),
      {
        cond: x.compare("EQ", x.mod(x.get(V.evalTicks), x.num(5)), x.num(0)),
        then: waitingReport,
      },
    ]),
  ];

  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      x.set(V.fire, x.bool(false)),
      x.set(V.forced, x.bool(false)),
      ...adaptiveEntry,
      x.ifElse([
        {
          cond: x.compare("EQ", x.get(V.fire), x.bool(true)),
          then: [
            // Trade Definition ran BEFORE the adaptive scan. Its cached
            // prediction/stake must never be used to buy the newly chosen side.
            // Quote the complete tuple, then size recovery at THAT live payout.
            x.set(V.livePayout, x.ntPrepareDigitTrade(
              x.get(V.inRecovery), x.get(V.activeSymbol), x.get(V.contract),
              x.get(V.barrier), x.get(V.forced),
            )),
            x.set(V.fire, x.bool(false)),
            x.ifElse([
              {
                cond: x.compare("GT", x.get(V.livePayout), x.num(1)),
                then: [
                  x.ifElse([
                    {
                      cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
                      then: [
                        x.set(V.recPayout, x.get(V.livePayout)),
                        x.call(RECOVERY_PROC),
                      ],
                    },
                  ], [
                    x.set(V.normPayout, x.get(V.livePayout)),
                    x.set(V.stake, x.get(V.baseStake)),
                  ]),
                  x.set(V.fire, x.ntPurchaseDigitTrade(
                    x.get(V.inRecovery), x.get(V.activeSymbol), x.get(V.contract),
                    x.get(V.barrier), x.get(V.stake), x.num(maxStake),
                  )),
                  x.ifElse([{
                    cond: x.compare("EQ", x.get(V.fire), x.bool(true)),
                    then: entryReport(),
                  }]),
                ],
              },
            ]),
          ],
        },
      ]),
    ])}</statement>`,
    0,
    900,
  );

  // ── 5. Recovery stake sizing — the shared bot formula, verbatim ────────────
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
    x.set(
      V.stake,
      x.arith(
        "DIVIDE",
        x.round(
          "ROUNDUP",
          x.arith(
            "MULTIPLY",
            x.arith("MINUS", x.get(V.stake), moneyEpsilon()),
            x.num(100),
          ),
        ),
        x.num(100),
      ),
    ),
    // Round the hard cap DOWN after rounding the request UP. The old
    // clamp-then-ceil could cross a fractional max stake, and its final 0.35
    // floor could buy with a balance below Deriv's minimum.
    x.set(V.stakeLimit, x.num(maxStake)),
    x.ifElse([{
      cond: x.compare("LT", x.balance(), x.get(V.stakeLimit)),
      then: [x.set(V.stakeLimit, x.balance())],
    }]),
    x.set(V.stakeLimit, x.arith("DIVIDE", x.round("ROUNDDOWN", x.arith(
      "MULTIPLY", x.arith("ADD", x.get(V.stakeLimit), moneyEpsilon()), x.num(100),
    )), x.num(100))),
    x.set(V.stake, x.constrain(x.get(V.stake), x.num(0), x.get(V.stakeLimit))),
  ];

  const recoveryProc = x.topLevel(
    "procedures_defnoreturn",
    `<field name="NAME">${esc(RECOVERY_PROC)}</field><statement name="STACK">${x.chain(sizeRecoveryStake)}</statement>`,
    1000,
    900,
  );

  // ── 6. Settlement — the shared recovery ledger ─────────────────────────────
  // Match addMoney/settleRecoveryWin in recovery-math.ts: loss debt is held at
  // integer-cent precision and only REAL net profit reduces it. Reaching the
  // step counter cap never discards debt or returns to normal prematurely.
  const cents = (value: string): string => x.round("ROUND", x.arith("MULTIPLY", value, x.num(100)));
  const addMoney = (a: string, b: string): string =>
    x.arith("DIVIDE", x.arith("ADD", cents(a), cents(b)), x.num(100));
  const enterRecovery: Stmt[] = [
    x.set(V.inRecovery, x.bool(true)),
    x.set(V.step, x.num(1)),
    x.set(V.debt, addMoney(x.get(V.lastStake), x.num(0))),
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
    x.set(V.debt, addMoney(x.get(V.debt), x.get(V.lastStake))),
  ];
  const exitRecovery: Stmt[] = [
    x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.step, x.num(0)),
    x.set(V.contract, x.text(input.normal.side)),
    x.set(V.barrier, x.num(input.normal.barrier)),
    x.set(V.stake, x.get(V.baseStake)),
    // Back to normal means back behind the gate: the next entry must re-qualify.
    x.set(V.gate, x.bool(false)),
    x.set(V.evalTicks, x.num(0)),
    x.notify(
      "success",
      x.text(
        "Recovery complete — debt cleared, back to normal barriers at base stake behind the gate",
      ),
    ),
  ];
  const onRecoveryWinPartial: Stmt[] = [
    x.joinInto(V.message, [
      x.text("Partial recovery —"),
      x.get(V.debt),
      x.text(`${currency} debt remains; scanning Over 5 / Under 4`),
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
    x.joinInto(V.message, [
      x.text("Recovery step"),
      x.get(V.step),
      x.text("— debt"),
      x.get(V.debt),
      x.text(`${currency}; scanning Over 5 / Under 4`),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onWin: Stmt[] = [
    x.set(V.lossRun, x.num(0)),
    // Refresh the realised payout multiplier of the leg that just won, so the
    // break-even the gate compares against is the live one.
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
          x.set(V.debt, x.arith("DIVIDE", x.arith(
            "MINUS", cents(x.get(V.debt)), cents(x.get(V.profit)),
          ), x.num(100))),
          x.ifElse(
            [
              {
                cond: x.compare("LTE", x.get(V.debt), x.num(0)),
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
              `Circuit breaker: ${breakerDepth} consecutive losses — the ladder is past the depth this session was sized for`,
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
      x.set(V.evalTicks, x.num(0)),
      x.ifElse([{ cond: x.checkResult("win"), then: onWin }], onLoss),
      // Only settlement writes the ledger. The next before_purchase pass
      // re-ranks in the new mode and binds a freshly quoted decision.
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
    measureProc +
    recoveryProc +
    beforePurchase +
    afterPurchase +
    `</xml>`;

  const name = `NeuroTrade Digit Forge ${input.symbol} ${normalLabel} to ${recoveryLabel}`;

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
      window: windowSize,
      minSamples,
      confidenceZ: z,
      forceEntryAfter,
      useMarkov,
      useStreakCooldown,
      runLimit,
      breakEven,
      watchMarkets,
      ladder: ladderRisk(
        input.recoveryPayout,
        markupPercent,
        maxRecoverySteps,
        fairWinRate(input.recovery),
      ),
    },
  };
}
