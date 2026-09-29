/**
 * Combo Forge → Deriv DBot strategy generator.
 *
 * WHAT THIS IS
 * ────────────
 *   Omni Forge's successor. The user picks ANY markets and ANY contracts for the
 *   normal set and an independent set for recovery — Over/Under, Even/Odd,
 *   Matches/Differs AND 1-tick Rise/Fall — presses "Create DBot", and the API
 *   renders a Deriv Bot (Blockly) strategy that carries its OWN analysis while
 *   it runs. No NeuroTrade engine, agent or AI is in the loop once Deriv's Run
 *   button is pressed.
 *
 * WHAT THE GENERATED BOT DOES
 * ───────────────────────────
 *   · NORMAL mode (no debt): every tick `nt_analyse_combo` scores every
 *     (market, contract) candidate with a prequential mixture e-process against
 *     the contract's OWN break-even and fires only when the evidence clears a
 *     threshold Bonferroni'd over everything it scanned. Strict is the default:
 *     on a fair random tape it stays silent, by design.
 *   · RECOVERY mode (debt outstanding): the same scan, but the objective is the
 *     expected log-growth of the exact attempt the shared ladder will place
 *     (debt × (1 + markup) / (payout − 1)), so a low-payout leg that forces a
 *     huge stake, or an attempt that would eat the balance, loses to a better
 *     one. Recovery has a patience limit so the session can never stall on a
 *     debt.
 *   · Stakes: base stake in normal mode; the SHARED recovery ladder in recovery
 *     — identical to every other NeuroTrade bot, floored at 0.35, capped by max
 *     stake and live balance, rounded up to the cent.
 *   · Circuit breaker on consecutive losses; take-profit / stop-loss on
 *     Deriv's own total-profit counter end the run.
 *
 * SAFETY (what keeps "Run" from erroring)
 * ───────────────────────────────────────
 *   · Every emitted block type is asserted against COMBO_FORGE_BLOCK_TYPES.
 *   · Inputs are validated and canonicalised; illegal combinations throw here,
 *     at forge time, never inside the running bot.
 *   · The runtime analyser catches everything and answers HOLD on failure.
 *   · A patience-forced entry requires a real ranked candidate (`forceable`).
 *
 * The maths lives in `combo-forge-analysis` (typed port) and, byte-for-byte in
 * behaviour, in the vendored builder's `combo-forge-analysis.js`.
 */

import { XmlBuilder, esc, money, type Stmt } from "./dbot-xml";
import { marketPathForSymbol } from "./overunder-turbo-dbot";
import { ladderRisk } from "./digit-forge-dbot";
import {
  OVER_PAYOUTS,
  UNDER_PAYOUTS,
  EVEN_ODD_PAYOUT,
  MATCH_PAYOUT,
  DIFF_PAYOUT,
  RISE_FALL_PAYOUT,
} from "./payouts";
import {
  COMBO_CONTRACT_TYPES,
  COMBO_FORGE_LIMITS,
  analyseComboGate,
  comboFairRate,
  comboLabel,
  expandComboContracts,
  normaliseStrictness,
  type ComboContractReading,
  type ComboContractType,
  type ComboSpec,
  type ComboStrictness,
  type ComboWireSpec,
} from "./combo-forge-analysis";

// ── Public types ──────────────────────────────────────────────────────────────

export const COMBO_FORGE_TYPES = COMBO_CONTRACT_TYPES;
export type ComboForgeType = ComboContractType;
export type ComboForgeSpec = ComboSpec;

export interface ComboForgeInput {
  symbol: string;
  displayName: string;
  /** Normal-mode contract set (1–8 entries, any mix of types). */
  normal: ComboForgeSpec[];
  /** Recovery-mode contract set (1–8 entries, any mix of types). */
  recovery: ComboForgeSpec[];
  /** Base stake in account currency (≥ 0.35). */
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  /** Recovery profit markup on debt, % (settings.botRecoveryMarkup). */
  markupPercent: number;
  /** Hard cap for any single stake (settings.maxTradeStake). */
  maxStake: number;
  /** Consecutive losses that halt the bot. */
  breakerDepth: number;
  currency: string;
  /** Ticks of history analysed per market (default 500, 60–1000). */
  window?: number;
  /** strict (default) | balanced | always. */
  strictness?: ComboStrictness | string;
  /** Normal-mode evaluations before entering on the best candidate anyway. 0 = never. */
  normalPatience?: number;
  /** Recovery evaluations before entering on the best candidate anyway. 0 = never. */
  recoveryPatience?: number;
  /** Markets the in-bot ranker may use (≤ 8, always includes `symbol`). */
  watchMarkets?: string[];
}

export interface ComboRecoveryReading {
  key: string;
  label: string;
  payout: number;
  fairRate: number;
  /** Expected cost per $1 of debt of one recovery attempt on a fair tape. */
  costPerDebt: number;
  /** Chance a fair tape fails `maxRecoverySteps` attempts in a row. */
  ladderFailure: number;
}

export interface ComboForgeStrategy {
  name: string;
  /** Blockly workspace XML (`is_dbot="true"`). */
  xml: string;
  /** Plain-English cautions about the chosen settings (never errors). */
  warnings: string[];
  summary: {
    symbol: string;
    displayName: string;
    market: string;
    submarket: string;
    normal: string[];
    recovery: string[];
    normalCsv: string;
    recoveryCsv: string;
    stake: number;
    takeProfit: number;
    stopLoss: number;
    maxRecoverySteps: number;
    markupPercent: number;
    maxStake: number;
    breakerDepth: number;
    currency: string;
    window: number;
    strictness: ComboStrictness;
    normalPatience: number;
    recoveryPatience: number;
    watchMarkets: string[];
    /** Scan breadth the multiple-testing correction is sized for. */
    candidates: { normal: number; recovery: number };
    ladder: {
      debtGrowthPerStep: number;
      capitalAtRisk: number;
      failureProbability: number;
    };
    gate: {
      normal: ComboContractReading[];
      recovery: ComboRecoveryReading[];
    };
  };
}

/** Every block type the generated strategy may contain. */
export const COMBO_FORGE_BLOCK_TYPES = Object.freeze([
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
  "trade_again",
  "contract_check_result",
  "read_details",
  "total_profit",
  "balance",
  "nt_analyse_combo",
  "nt_combo_decision",
  "nt_purchase_contract",
  "nt_switch_market",
  "controls_if",
  "logic_compare",
  "logic_operation",
  "logic_boolean",
  "math_number",
  "math_number_positive",
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
] as const);

export const COMBO_MAX_SET = 8;
export const COMBO_MAX_MARKETS = 8;
export const COMBO_MIN_WINDOW = 80; // the normal gate needs 60 samples; Rise/Fall yields window−1, so keep headroom
export const COMBO_MAX_WINDOW = 1000;
export const COMBO_DEFAULT_WINDOW = 500;
export const COMBO_DEFAULT_RECOVERY_PATIENCE = 20;

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

// ── Contract maths ────────────────────────────────────────────────────────────

/** Canonical total-return payout multiplier for a spec. */
export function comboPayout(spec: ComboForgeSpec): number {
  switch (spec.type) {
    case "DIGITOVER":
      return OVER_PAYOUTS[spec.digit] ?? OVER_PAYOUTS[4]!;
    case "DIGITUNDER":
      return UNDER_PAYOUTS[spec.digit] ?? UNDER_PAYOUTS[5]!;
    case "DIGITEVEN":
    case "DIGITODD":
      return EVEN_ODD_PAYOUT;
    case "DIGITMATCH":
      return MATCH_PAYOUT;
    case "DIGITDIFF":
      return DIFF_PAYOUT;
    case "CALL":
    case "PUT":
      return RISE_FALL_PAYOUT;
  }
}

export { comboFairRate, comboLabel };

/** Validate + canonicalise a user contract set. Throws on anything illegal. */
export function normaliseComboSet(raw: ComboForgeSpec[], which: "normal" | "recovery"): ComboForgeSpec[] {
  ensure(Array.isArray(raw) && raw.length >= 1, `${which} needs at least one contract`);
  ensure(raw.length <= COMBO_MAX_SET, `${which} allows at most ${COMBO_MAX_SET} contracts`);
  const seen = new Set<string>();
  const out: ComboForgeSpec[] = [];
  for (const spec of raw) {
    ensure(
      (COMBO_CONTRACT_TYPES as readonly string[]).includes(spec?.type),
      `${which}: unknown contract type ${String(spec?.type)}`,
    );
    let digit = Number.isFinite(Number(spec.digit)) ? Math.trunc(Number(spec.digit)) : -1;
    switch (spec.type) {
      case "DIGITOVER":
        ensure(digit >= 0 && digit <= 8, `${which}: Over needs a barrier 0–8`);
        break;
      case "DIGITUNDER":
        ensure(digit >= 1 && digit <= 9, `${which}: Under needs a barrier 1–9`);
        break;
      case "DIGITMATCH":
      case "DIGITDIFF":
        ensure(digit === -1 || (digit >= 0 && digit <= 9), `${which}: Matches/Differs digit must be 0–9 or auto`);
        break;
      default:
        digit = -1; // Even/Odd and Rise/Fall carry no digit.
    }
    const key = `${spec.type}:${digit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: spec.type, digit });
  }
  return out;
}

/** Wire format the vendored `nt_analyse_combo` block parses at runtime. */
export function comboCsv(specs: ComboForgeSpec[]): string {
  return specs.map((s) => `${s.type}:${s.digit}:${comboPayout(s)}`).join(",");
}

function toWire(specs: ComboForgeSpec[]): ComboWireSpec[] {
  return specs.map((s) => ({ ...s, payout: comboPayout(s) }));
}

const isDirection = (spec: ComboForgeSpec): boolean => spec.type === "CALL" || spec.type === "PUT";

/** The trade type the workspace declares — from the FIRST normal contract. */
function tradeTypeFor(spec: ComboForgeSpec): { category: string; tradeType: string; hasPrediction: boolean } {
  switch (spec.type) {
    case "DIGITEVEN":
    case "DIGITODD":
      return { category: "digits", tradeType: "evenodd", hasPrediction: false };
    case "DIGITMATCH":
    case "DIGITDIFF":
      return { category: "digits", tradeType: "matchesdiffers", hasPrediction: true };
    case "CALL":
    case "PUT":
      return { category: "callput", tradeType: "callput", hasPrediction: false };
    default:
      return { category: "digits", tradeType: "overunder", hasPrediction: true };
  }
}

/**
 * `-1` is the CSV sentinel for "auto-pick" (Matches/Differs) or "no digit"
 * (Even/Odd, Rise/Fall) — never a legal Deriv prediction. Seed the live Trade
 * Definition with digit 0 until the first analysis resolves a concrete digit.
 */
function safeRuntimeDigit(spec: ComboForgeSpec): number {
  if (spec.type === "DIGITEVEN" || spec.type === "DIGITODD" || isDirection(spec)) return -1;
  return spec.digit >= 0 && spec.digit <= 9 ? spec.digit : 0;
}

/** Seed for the Trade Definition's PREDICTION input (only exists for digit-barrier types). */
function seedPrediction(spec: ComboForgeSpec): number {
  return spec.digit >= 0 && spec.digit <= 9 ? spec.digit : 0;
}

// ── Strategy generator ────────────────────────────────────────────────────────

export function buildComboForgeStrategy(input: ComboForgeInput): ComboForgeStrategy {
  const normal = normaliseComboSet(input.normal, "normal");
  const recovery = normaliseComboSet(input.recovery, "recovery");
  ensure(Number.isFinite(input.stake) && input.stake >= 0.35, "stake must be ≥ 0.35");
  ensure(input.takeProfit > 0, "takeProfit must be > 0");
  ensure(input.stopLoss > 0, "stopLoss must be > 0");
  ensure(/^[A-Za-z0-9_]+$/.test(input.symbol), "symbol must be a Deriv symbol code");

  const warnings: string[] = [];
  const requestedWindow = Math.max(1, Math.min(COMBO_MAX_WINDOW, Math.round(input.window ?? COMBO_DEFAULT_WINDOW)));
  if (requestedWindow < COMBO_MIN_WINDOW) {
    warnings.push(
      `Tick window ${requestedWindow} is below the ${COMBO_MIN_WINDOW}-tick minimum the evidence gate needs — raised to ${COMBO_MIN_WINDOW}.`,
    );
  }
  const windowSize = Math.max(COMBO_MIN_WINDOW, requestedWindow);
  const strictness = normaliseStrictness(input.strictness);
  const normalPatience = Math.max(0, Math.min(5000, Math.round(input.normalPatience ?? 0)));
  const recoveryPatience = Math.max(
    0,
    Math.min(5000, Math.round(input.recoveryPatience ?? COMBO_DEFAULT_RECOVERY_PATIENCE)),
  );
  const breakerDepth = Math.max(3, Math.round(input.breakerDepth));
  const maxRecoverySteps = Math.max(1, Math.min(10, Math.round(input.maxRecoverySteps)));
  const markupPercent = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency) ? input.currency.toUpperCase() : "USD";
  const requestedMarkets = [input.symbol, ...(input.watchMarkets ?? [])].filter(
    (s, i, all) => /^[A-Za-z0-9_]+$/.test(s) && all.indexOf(s) === i,
  );
  if (requestedMarkets.length > COMBO_MAX_MARKETS) {
    warnings.push(
      `Only ${COMBO_MAX_MARKETS} markets can be scanned per cycle — the first ${COMBO_MAX_MARKETS} you chose are used.`,
    );
  }
  const watchMarkets = requestedMarkets.slice(0, COMBO_MAX_MARKETS);

  const normalCsv = comboCsv(normal);
  const recoveryCsv = comboCsv(recovery);
  const firstNormal = normal[0]!;
  const firstRecovery = recovery[0]!;
  const { category, tradeType, hasPrediction } = tradeTypeFor(firstNormal);
  const normalLabels = normal.map(comboLabel);
  const recoveryLabels = recovery.map(comboLabel);

  // Scan breadth — the multiple-testing correction is sized for exactly this.
  const candidateCounts = {
    normal: expandComboContracts(toWire(normal)).length * watchMarkets.length,
    recovery: expandComboContracts(toWire(recovery)).length * watchMarkets.length,
  };

  // Forge-time replica of the NORMAL evidence gate: how long a real edge takes
  // to detect, and how often a FAIR tape would trip it (≈ 0 in strict).
  const gateNormal = analyseComboGate(toWire(normal), {
    window: windowSize,
    strictness,
    candidates: candidateCounts.normal,
  });
  if (strictness !== "always") {
    for (const reading of gateNormal) {
      const six = reading.ticksToDetect.find((t) => t.edge === 0.06)?.ticks ?? null;
      if (six === null || six > windowSize) {
        warnings.push(
          `${reading.label} pays ${reading.payout}× (break-even ${(reading.breakEven * 100).toFixed(1)}%). ` +
            `Proving a real edge of 6 points above that takes about ${six === null ? "more than the tape holds" : `${six} ticks`}, ` +
            `beyond your ${windowSize}-tick window — in ${strictness} mode it will rarely or never qualify for a normal entry.`,
        );
      }
    }
  }
  if (strictness === "always") {
    warnings.push(
      "Always mode trades the best-timed, lowest-cost candidate WITHOUT demanding evidence of an edge. Every contract is priced below fair odds, so expect the house margin to cost you on each trade.",
    );
  }
  if ([...normal, ...recovery].some(isDirection)) {
    warnings.push(
      `Rise/Fall is 1-tick and priced at ${RISE_FALL_PAYOUT}× here; the running bot refreshes the realised payout after each win, and a flat tick counts as a loss for both sides.`,
    );
  }

  // Recovery frontier — expected cost per $1 of debt and ladder failure odds.
  const recoveryReadings: ComboRecoveryReading[] = recovery.map((spec) => {
    const payout = comboPayout(spec);
    const fair = comboFairRate(spec);
    const margin = 1 - fair * payout;
    return {
      key: `${spec.type}:${spec.digit}`,
      label: comboLabel(spec),
      payout,
      fairRate: fair,
      costPerDebt: margin / (payout - 1),
      ladderFailure: Math.pow(1 - fair, maxRecoverySteps),
    };
  });

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
    gate: "Gate Pass",
    forceable: "Can Force",
    fire: "Fire",
    evalTicks: "Evaluations",
    activeSymbol: "Active Market",
    decisionReason: "Analysis Reason",
    decisionScore: "Analysis Score",
    profit: "Profit",
    lastStake: "Last Stake",
    lastReturn: "Last Return",
    message: "Message",
  } as const;

  const RECOVERY_PROC = "Size recovery stake";

  // ── 1. Run once at start ────────────────────────────────────────────────────
  const strictNotice =
    strictness === "strict"
      ? "evidence STRICT — it holds until a contract's win rate is proven above its break-even"
      : strictness === "balanced"
        ? "evidence BALANCED — it trades on moderate proof of an edge"
        : "evidence ALWAYS — it trades the best-timed cheapest candidate without demanding proof";
  const init: Stmt[] = [
    x.set(V.baseStake, x.num(input.stake)),
    x.set(V.stake, x.get(V.baseStake)),
    x.set(V.contract, x.text(firstNormal.type)),
    x.set(V.barrier, x.num(safeRuntimeDigit(firstNormal))),
    x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.step, x.num(0)),
    x.set(V.lossRun, x.num(0)),
    x.set(V.normPayout, x.num(comboPayout(firstNormal))),
    x.set(V.recPayout, x.num(comboPayout(firstRecovery))),
    x.set(V.evalTicks, x.num(0)),
    x.set(V.activeSymbol, x.text(input.symbol)),
    x.set(V.decisionReason, x.text("analysis warming up")),
    x.set(V.decisionScore, x.num(0)),
    x.set(V.gate, x.bool(false)),
    x.set(V.forceable, x.bool(false)),
    x.notify(
      "info",
      x.text(
        `NeuroTrade Combo Forge · ${input.displayName} · normal [${normalLabels.join(", ")}] → recovery [${recoveryLabels.join(", ")}] · ` +
          `stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · ` +
          `${windowSize}-tick window across ${watchMarkets.length} market${watchMarkets.length === 1 ? "" : "s"} · ` +
          `recovery markup ${markupPercent}% · circuit breaker ${breakerDepth} losses`,
      ),
    ),
    x.notify("info", x.text(`Combo Forge ${strictNotice}`)),
  ];

  // ── 2. Trade options ───────────────────────────────────────────────────────
  // The declared trade type follows the FIRST normal contract so the workspace
  // loads with a coherent Trade Definition; at runtime `nt_purchase_contract`
  // sets or removes the prediction just-in-time for whichever contract the
  // ranker actually buys, so one workspace can trade every chosen type —
  // digits and Rise/Fall alike.
  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="cfopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="${hasPrediction}"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="cfdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="cfamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    (hasPrediction
      ? `<value name="PREDICTION"><shadow type="math_number_positive" id="cfprd"><field name="NUM">${seedPrediction(firstNormal)}</field></shadow>${x.get(V.barrier)}</value>`
      : "") +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="cfmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="cftt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">${category}</field><field name="TRADETYPE_LIST">${tradeType}</field>` +
      `<next><block type="trade_definition_contracttype" id="cfct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">both</field>` +
      `<next><block type="trade_definition_candleinterval" id="cfci" deletable="false" movable="false">` +
      `<field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="cfrb" deletable="false" movable="false">` +
      `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="cfre" deletable="false" movable="false">` +
      `<field name="RESTARTONERROR">TRUE</field>` +
      `</block></next></block></next></block></next></block></next></block></next></block>` +
      `</statement>` +
      `<statement name="INITIALIZATION">${x.chain(init)}</statement>` +
      // The trade options MUST be unconditional: the interpreter's loop spins
      // on sleep(1) forever while BinaryBotPrivateHasCalledTradeOptions is false.
      `<statement name="SUBMARKET">${tradeOptions}</statement>`,
    0,
    0,
  );

  // ── 3. Purchase conditions — the ranker IS the gate ───────────────────────
  // Journal transparency is deliberately minimal: state and subject only.
  const waitingReport: Stmt[] = [
    x.joinInto(V.message, [
      x.text("ANALYSING"), x.get(V.activeSymbol),
      x.text("· no qualified setup yet — holding"),
    ]),
    x.notify("info", x.get(V.message)),
  ];

  // A factory, not a shared array: every emission needs its own block ids.
  const entryReport = (): Stmt[] => [
    x.joinInto(V.message, [
      x.text("ENTRY ·"), x.get(V.activeSymbol), x.text("·"), x.get(V.contract),
      x.text("· setup qualified"),
    ]),
    x.notify("success", x.get(V.message)),
  ];

  const readDecision: Stmt[] = [
    x.set(V.activeSymbol, x.ntComboDecision("symbol")),
    x.set(V.contract, x.ntComboDecision("contract")),
    x.set(V.barrier, x.ntComboDecision("barrier")),
    x.set(V.decisionScore, x.ntComboDecision("score")),
    x.set(V.decisionReason, x.ntComboDecision("reason")),
    x.set(V.gate, x.ntComboDecision("eligible")),
    x.set(V.forceable, x.ntComboDecision("forceable")),
    x.ifElse(
      [{
        cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
        then: [x.set(V.recPayout, x.ntComboDecision("payout"))],
      }],
      [x.set(V.normPayout, x.ntComboDecision("payout"))],
    ),
  ];

  /** `inRecovery == wanted AND evaluations >= limit AND a real candidate exists`. */
  const patienceCond = (wanted: boolean, limit: number): string =>
    x.logic(
      "AND",
      x.logic(
        "AND",
        x.compare("EQ", x.get(V.inRecovery), x.bool(wanted)),
        x.compare("GTE", x.get(V.evalTicks), x.num(limit)),
      ),
      x.compare("EQ", x.get(V.forceable), x.bool(true)),
    );

  const patienceBranch = (wanted: boolean, limit: number): Array<{ cond: string; then: Stmt[] }> =>
    limit > 0
      ? [{
          cond: patienceCond(wanted, limit),
          then: [
            x.notify("warn", x.text(`Patience limit ${limit}: entering on the best available setup`)),
            ...entryReport(),
            x.set(V.fire, x.bool(true)),
          ],
        }]
      : [];

  const adaptiveEntry: Stmt[] = [
    x.set(V.evalTicks, x.arith("ADD", x.get(V.evalTicks), x.num(1))),
    x.ifElse(
      [{
        cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
        then: [x.ntAnalyseCombo("RECOVERY", watchMarkets, recoveryCsv, windowSize, strictness, markupPercent, maxStake, x.get(V.debt))],
      }],
      [x.ntAnalyseCombo("NORMAL", watchMarkets, normalCsv, windowSize, strictness, markupPercent, maxStake, x.num(0))],
    ),
    ...readDecision,
    x.ifElse(
      [
        {
          cond: x.compare("EQ", x.ntComboDecision("changedMarket"), x.bool(true)),
          then: [
            x.ntSwitchMarket(x.get(V.activeSymbol)),
            x.joinInto(V.message, [x.text("SWITCHED MARKET · now analysing"), x.get(V.activeSymbol)]),
            x.notify("info", x.get(V.message)),
          ],
        },
        {
          cond: x.compare("EQ", x.get(V.gate), x.bool(true)),
          then: [...entryReport(), x.set(V.fire, x.bool(true))],
        },
        ...patienceBranch(true, recoveryPatience),
        ...patienceBranch(false, normalPatience),
        {
          cond: x.compare("EQ", x.mod(x.get(V.evalTicks), x.num(5)), x.num(0)),
          then: waitingReport,
        },
      ],
    ),
  ];

  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      x.set(V.fire, x.bool(false)),
      ...adaptiveEntry,
      x.ifElse([{
        cond: x.compare("EQ", x.get(V.fire), x.bool(true)),
        then: [x.ntPurchaseContract(x.get(V.contract), x.get(V.barrier))],
      }]),
    ])}</statement>`,
    0,
    900,
  );

  // ── 4. Recovery stake sizing — the shared bot formula, verbatim ────────────
  //   This procedure seeds the Stake variable (and therefore the next Trade
  //   Definition) with the CURRENT payout estimate. The running analyser then
  //   re-applies the identical formula with the payout of the contract it
  //   actually picked (`nt_analyse_combo` overwrites the purchase amount in
  //   RECOVERY mode), so a leg paying 1.23× is never staked as if it paid 1.95×.
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
        x.round("ROUNDUP", x.arith("MULTIPLY", x.arith("MINUS", x.get(V.stake), x.num(0.000000001)), x.num(100))),
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

  // ── 5. Settlement — the shared recovery ledger ─────────────────────────────
  const enterRecovery: Stmt[] = [
    x.set(V.inRecovery, x.bool(true)),
    x.set(V.step, x.num(1)),
    x.set(V.debt, x.get(V.lastStake)),
    // Defaults until the next analysis cycle re-ranks the recovery set.
    x.set(V.contract, x.text(firstRecovery.type)),
    x.set(V.barrier, x.num(safeRuntimeDigit(firstRecovery))),
    x.set(V.recPayout, x.num(comboPayout(firstRecovery))),
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
    x.set(V.contract, x.text(firstNormal.type)),
    x.set(V.barrier, x.num(safeRuntimeDigit(firstNormal))),
    x.set(V.stake, x.get(V.baseStake)),
    // Back to normal means back behind the gate: the next entry must re-qualify.
    x.set(V.gate, x.bool(false)),
    x.set(V.evalTicks, x.num(0)),
    x.notify("success", x.text(`Recovery complete — debt cleared, back to your normal set [${normalLabels.join(", ")}] at base stake behind the gate`)),
  ];
  const onRecoveryWinPartial: Stmt[] = [
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [
      x.text("Partial recovery —"),
      x.get(V.debt),
      x.text(`${currency} debt remains, sizing the next attempt from your recovery set`),
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
      x.text("— clearing"),
      x.get(V.debt),
      x.text(`${currency} with the best of your recovery set`),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onWin: Stmt[] = [
    x.set(V.lossRun, x.num(0)),
    // Refresh the realised payout multiplier of the leg that just won, so the
    // ladder always divides by the price Deriv actually paid.
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

  const name = `NeuroTrade Combo Forge ${input.symbol} ${normalLabels.join("+")} to ${recoveryLabels.join("+")}`;

  // Worst-case ladder disclosure: the lowest recovery payout grows debt the
  // fastest and the lowest fair rate fails the most often.
  const worstPayout = Math.min(...recovery.map(comboPayout));
  const worstRate = Math.min(...recovery.map(comboFairRate));

  return {
    name,
    xml,
    warnings,
    summary: {
      symbol: input.symbol,
      displayName: input.displayName,
      market,
      submarket,
      normal: normalLabels,
      recovery: recoveryLabels,
      normalCsv,
      recoveryCsv,
      stake: input.stake,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      maxRecoverySteps,
      markupPercent,
      maxStake,
      breakerDepth,
      currency,
      window: windowSize,
      strictness,
      normalPatience,
      recoveryPatience,
      watchMarkets,
      candidates: candidateCounts,
      ladder: ladderRisk(worstPayout, markupPercent, maxRecoverySteps, worstRate),
      gate: { normal: gateNormal, recovery: recoveryReadings },
    },
  };
}

export { COMBO_FORGE_LIMITS };
