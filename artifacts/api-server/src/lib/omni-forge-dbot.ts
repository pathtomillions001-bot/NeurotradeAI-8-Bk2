/**
 * Omni Forge → Deriv DBot strategy generator.
 *
 * WHAT THIS IS
 * ────────────
 *   Digit Forge's sibling with TOTAL contract freedom. The user picks ANY mix
 *   of digit contracts for the normal set and ANY mix for the recovery set —
 *   Over/Under barriers, Even/Odd, Matches/Differs, one of them or several —
 *   presses "Create DBot", and the API renders a Deriv Bot (Blockly) strategy
 *   that carries its OWN analysis while it runs. No NeuroTrade engine, agent
 *   or AI is in the loop once Deriv's Run button is pressed.
 *
 * WHAT THE GENERATED BOT DOES
 * ───────────────────────────
 *   · NORMAL mode (no debt): every tick, `nt_analyse_contracts` ranks every
 *     user-chosen normal contract on every watched market (up to 8) and fires
 *     only when the best candidate clears the statistical gate.
 *   · RECOVERY mode (debt outstanding): the SAME ranker runs over the user's
 *     recovery set, but the estimand shifts to P(win | previous loss) — the
 *     state a recovery entry actually fires from — with deliberately looser
 *     thresholds (repayment speed beats selectivity) while still refusing
 *     tapes where losses cluster. When several recovery contracts are chosen
 *     (e.g. Even/Odd AND Over 4), the bot picks the best contract AND the
 *     best market for that moment, switching markets safely between
 *     contracts when another tape is measurably stronger.
 *   · Stakes: base stake in normal mode; the shared `getBotRecoveryStake`
 *     ladder in recovery — debt × (1 + markup) / (payout − 1), floored at
 *     0.35, capped by max stake and live balance, rounded up to the cent.
 *   · Circuit breaker on consecutive losses; take-profit / stop-loss on
 *     Deriv's own total-profit counter end the run.
 *
 * THE MATHS (all computed INSIDE the bot runtime, per candidate, per market)
 * ──────────────────────────────────────────────────────────────────────────
 *   · Beta(20·p0, 20·(1−p0)) prior — short tapes shrink to fair digit odds,
 *     so a lucky 30-tick streak cannot impersonate an edge.
 *   · Wilson one-sided 90% lower confidence bound vs the payout's break-even
 *     — the bot trades its worst plausible rate, never its point estimate.
 *   · Two-state Markov chain (add-one smoothed); recovery mode conditions on
 *     the LOSS state because that is the state it enters from — this is what
 *     times the recovery entry instead of firing blind.
 *   · Loss-clustering ratio ξ = P(loss|loss)/P(loss) and split-half
 *     instability as score penalties: clustered losses are what turn a
 *     depth-3 ladder into a depth-6 event.
 *
 * NEUROTRADE ADAPTIVE BLOCKS
 * ──────────────────────────
 *   The generated strategy uses four blocks registered by our vendored
 *   builder: `nt_analyse_contracts`, `nt_contract_decision`,
 *   `nt_purchase_contract` (any contract type + just-in-time digit, so one
 *   workspace can buy DIGITOVER and DIGITEVEN in the same session) and
 *   `nt_switch_market`. This XML therefore runs in NeuroTrade's builder, not
 *   the unmodified app.deriv.com builder.
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
} from "./payouts";

// ── Public types ──────────────────────────────────────────────────────────────

export const FORGE_CONTRACT_TYPES = [
  "DIGITOVER",
  "DIGITUNDER",
  "DIGITEVEN",
  "DIGITODD",
  "DIGITMATCH",
  "DIGITDIFF",
] as const;

export type ForgeContractType = (typeof FORGE_CONTRACT_TYPES)[number];

export interface ForgeContractSpec {
  type: ForgeContractType;
  /**
   * The digit: barrier for Over/Under (Over 0–8, Under 1–9), target digit for
   * Matches/Differs (0–9, or −1 = let the running bot auto-pick the
   * hottest/coldest digit of the live tape). Ignored for Even/Odd.
   */
  digit?: number;
}

export interface OmniForgeInput {
  symbol: string;
  displayName: string;
  /** The user's normal-mode contract set (1–6 entries, any mix of types). */
  normal: ForgeContractSpec[];
  /** The user's recovery-mode contract set (1–6 entries, any mix of types). */
  recovery: ForgeContractSpec[];
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
  /** Digits inspected by the in-bot ranker (default 120, capped at 300). */
  window?: number;
  /** Evaluations before entering WITHOUT a confirmed edge. 0 = never force. */
  forceEntryAfter?: number;
  /** Markets the in-bot ranker may switch to (≤ 8, always includes symbol). */
  watchMarkets?: string[];
}

export interface OmniForgeStrategy {
  name: string;
  /** Blockly workspace XML (`is_dbot="true"`). */
  xml: string;
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
    forceEntryAfter: number;
    watchMarkets: string[];
    /** Worst-case recovery ladder (lowest payout, lowest fair rate) for the panel. */
    ladder: {
      debtGrowthPerStep: number;
      capitalAtRisk: number;
      failureProbability: number;
    };
  };
}

/** Every block type the generated strategy may contain. */
export const OMNI_FORGE_BLOCK_TYPES = Object.freeze([
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
  "nt_analyse_contracts",
  "nt_contract_decision",
  "nt_purchase_contract",
  "nt_switch_market",
  "controls_if",
  "logic_compare",
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

// ── Forge-time maths (mirrored by the runtime, computed here for the summary) ─

/** Canonical total-return payout multiplier for a spec. */
export function forgePayout(spec: ForgeContractSpec): number {
  switch (spec.type) {
    case "DIGITOVER":
      return OVER_PAYOUTS[spec.digit ?? 4] ?? OVER_PAYOUTS[4]!;
    case "DIGITUNDER":
      return UNDER_PAYOUTS[spec.digit ?? 5] ?? UNDER_PAYOUTS[5]!;
    case "DIGITEVEN":
    case "DIGITODD":
      return EVEN_ODD_PAYOUT;
    case "DIGITMATCH":
      return MATCH_PAYOUT;
    case "DIGITDIFF":
      return DIFF_PAYOUT;
  }
}

/** Theoretical win probability of a spec on a uniform tape. */
export function forgeFairRate(spec: ForgeContractSpec): number {
  switch (spec.type) {
    case "DIGITOVER":
      return (9 - (spec.digit ?? 4)) / 10;
    case "DIGITUNDER":
      return (spec.digit ?? 5) / 10;
    case "DIGITEVEN":
    case "DIGITODD":
      return 0.5;
    case "DIGITMATCH":
      return 0.1;
    case "DIGITDIFF":
      return 0.9;
  }
}

/** Human label — "Over 1", "Even", "Matches auto", "Differs 3", … */
export function forgeLabel(spec: ForgeContractSpec): string {
  const digit = spec.digit ?? -1;
  switch (spec.type) {
    case "DIGITOVER":
      return `Over ${digit}`;
    case "DIGITUNDER":
      return `Under ${digit}`;
    case "DIGITEVEN":
      return "Even";
    case "DIGITODD":
      return "Odd";
    case "DIGITMATCH":
      return digit >= 0 ? `Matches ${digit}` : "Matches auto";
    case "DIGITDIFF":
      return digit >= 0 ? `Differs ${digit}` : "Differs auto";
  }
}

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** Validate + canonicalise a user contract set. Throws on anything illegal. */
export function normaliseForgeSet(raw: ForgeContractSpec[], which: "normal" | "recovery"): ForgeContractSpec[] {
  ensure(Array.isArray(raw) && raw.length >= 1, `${which} needs at least one contract`);
  ensure(raw.length <= 6, `${which} allows at most 6 contracts`);
  const seen = new Set<string>();
  const out: ForgeContractSpec[] = [];
  for (const spec of raw) {
    ensure(
      (FORGE_CONTRACT_TYPES as readonly string[]).includes(spec?.type),
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
        digit = -1; // Even/Odd carry no digit.
    }
    const key = `${spec.type}:${digit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: spec.type, digit });
  }
  return out;
}

/** Wire format the vendored `nt_analyse_contracts` block parses at runtime. */
export function forgeCsv(specs: ForgeContractSpec[]): string {
  return specs.map((s) => `${s.type}:${s.digit ?? -1}:${forgePayout(s)}`).join(",");
}

/** The trade type the workspace declares — from the FIRST normal contract. */
function tradeTypeFor(spec: ForgeContractSpec): { tradeType: string; hasPrediction: boolean } {
  switch (spec.type) {
    case "DIGITEVEN":
    case "DIGITODD":
      return { tradeType: "evenodd", hasPrediction: false };
    case "DIGITMATCH":
    case "DIGITDIFF":
      return { tradeType: "matchesdiffers", hasPrediction: true };
    default:
      return { tradeType: "overunder", hasPrediction: true };
  }
}

// ── Strategy generator ────────────────────────────────────────────────────────

export function buildOmniForgeStrategy(input: OmniForgeInput): OmniForgeStrategy {
  const normal = normaliseForgeSet(input.normal, "normal");
  const recovery = normaliseForgeSet(input.recovery, "recovery");
  ensure(Number.isFinite(input.stake) && input.stake >= 0.35, "stake must be ≥ 0.35");
  ensure(input.takeProfit > 0, "takeProfit must be > 0");
  ensure(input.stopLoss > 0, "stopLoss must be > 0");
  ensure(/^[A-Za-z0-9_]+$/.test(input.symbol), "symbol must be a Deriv symbol code");

  const windowSize = Math.max(20, Math.min(300, Math.round(input.window ?? 120)));
  const forceEntryAfter = Math.max(0, Math.round(input.forceEntryAfter ?? 0));
  const breakerDepth = Math.max(3, Math.round(input.breakerDepth));
  const maxRecoverySteps = Math.max(1, Math.min(10, Math.round(input.maxRecoverySteps)));
  const markupPercent = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency) ? input.currency.toUpperCase() : "USD";
  const watchMarkets = [input.symbol, ...(input.watchMarkets ?? [])]
    .filter((s, i, all) => /^[A-Za-z0-9_]+$/.test(s) && all.indexOf(s) === i)
    .slice(0, 8);

  const normalCsv = forgeCsv(normal);
  const recoveryCsv = forgeCsv(recovery);
  const firstNormal = normal[0]!;
  const firstRecovery = recovery[0]!;
  const { tradeType, hasPrediction } = tradeTypeFor(firstNormal);
  const normalLabels = normal.map(forgeLabel);
  const recoveryLabels = recovery.map(forgeLabel);

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
  const init: Stmt[] = [
    x.set(V.baseStake, x.num(input.stake)),
    x.set(V.stake, x.get(V.baseStake)),
    x.set(V.contract, x.text(firstNormal.type)),
    x.set(V.barrier, x.num(firstNormal.digit ?? -1)),
    x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.step, x.num(0)),
    x.set(V.lossRun, x.num(0)),
    x.set(V.normPayout, x.num(forgePayout(firstNormal))),
    x.set(V.recPayout, x.num(forgePayout(firstRecovery))),
    x.set(V.evalTicks, x.num(0)),
    x.set(V.activeSymbol, x.text(input.symbol)),
    x.set(V.decisionReason, x.text("analysis warming up")),
    x.set(V.decisionScore, x.num(0)),
    x.set(V.gate, x.bool(false)),
    x.notify(
      "info",
      x.text(
        `NeuroTrade Omni Forge · ${input.displayName} · normal [${normalLabels.join(", ")}] → recovery [${recoveryLabels.join(", ")}] · ` +
          `stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · ` +
          `${windowSize}-digit window ranked across ${watchMarkets.length} market${watchMarkets.length === 1 ? "" : "s"} · ` +
          `recovery markup ${markupPercent}% · circuit breaker ${breakerDepth} losses`,
      ),
    ),
  ];

  // ── 2. Trade options ───────────────────────────────────────────────────────
  // The declared trade type follows the FIRST normal contract so the workspace
  // loads with a coherent Trade Definition; at runtime `nt_purchase_contract`
  // sets or removes the prediction just-in-time for whichever contract the
  // ranker actually buys, so one workspace can trade every chosen type.
  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="ofopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="${hasPrediction}"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="ofdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="ofamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    (hasPrediction
      ? `<value name="PREDICTION"><shadow type="math_number_positive" id="ofprd"><field name="NUM">${Math.max(0, firstNormal.digit ?? 0)}</field></shadow>${x.get(V.barrier)}</value>`
      : "") +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="ofmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="oftt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">${tradeType}</field>` +
      `<next><block type="trade_definition_contracttype" id="ofct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">both</field>` +
      `<next><block type="trade_definition_candleinterval" id="ofci" deletable="false" movable="false">` +
      `<field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="ofrb" deletable="false" movable="false">` +
      `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="ofre" deletable="false" movable="false">` +
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
  const waitingReport: Stmt[] = [
    x.joinInto(V.message, [
      x.text("ANALYSING · market"), x.get(V.activeSymbol),
      x.text("· score"), x.get(V.decisionScore), x.text("·"), x.get(V.decisionReason),
    ]),
    x.notify("info", x.get(V.message)),
  ];

  const readDecision: Stmt[] = [
    x.set(V.activeSymbol, x.ntForgeDecision("symbol")),
    x.set(V.contract, x.ntForgeDecision("contract")),
    x.set(V.barrier, x.ntForgeDecision("barrier")),
    x.set(V.decisionScore, x.ntForgeDecision("score")),
    x.set(V.decisionReason, x.ntForgeDecision("reason")),
    x.set(V.gate, x.ntForgeDecision("eligible")),
    x.ifElse(
      [{
        cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
        then: [x.set(V.recPayout, x.ntForgeDecision("payout"))],
      }],
      [x.set(V.normPayout, x.ntForgeDecision("payout"))],
    ),
  ];

  const adaptiveEntry: Stmt[] = [
    x.set(V.evalTicks, x.arith("ADD", x.get(V.evalTicks), x.num(1))),
    x.ifElse(
      [{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: [x.ntAnalyseContracts("RECOVERY", watchMarkets, recoveryCsv, windowSize)] }],
      [x.ntAnalyseContracts("NORMAL", watchMarkets, normalCsv, windowSize)],
    ),
    ...readDecision,
    x.ifElse(
      [{
        cond: x.compare("EQ", x.ntForgeDecision("changedMarket"), x.bool(true)),
        then: [
          x.ntSwitchMarket(x.get(V.activeSymbol)),
          x.joinInto(V.message, [x.text("SWITCHED MARKET · now analysing"), x.get(V.activeSymbol), x.text("· stale proposals cleared")]),
          x.notify("info", x.get(V.message)),
        ],
      }, {
        cond: x.compare("EQ", x.get(V.gate), x.bool(true)),
        then: [x.set(V.fire, x.bool(true))],
      },
      ...(forceEntryAfter > 0 ? [{
        cond: x.compare("GTE", x.get(V.evalTicks), x.num(forceEntryAfter)),
        then: [x.notify("warn", x.text(`Patience limit ${forceEntryAfter}: taking the highest-ranked candidate`)), x.set(V.fire, x.bool(true))],
      }] : []),
      {
        cond: x.compare("EQ", x.mod(x.get(V.evalTicks), x.num(10)), x.num(0)),
        then: waitingReport,
      }],
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
    x.set(V.barrier, x.num(firstRecovery.digit ?? -1)),
    x.set(V.recPayout, x.num(forgePayout(firstRecovery))),
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
    x.set(V.barrier, x.num(firstNormal.digit ?? -1)),
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
      x.text(`${currency} debt remains, next recovery stake`),
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
      x.text("— best of your recovery set at"),
      x.get(V.stake),
      x.text(`${currency} to clear`),
      x.get(V.debt),
      x.text(currency),
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

  const name = `NeuroTrade Omni Forge ${input.symbol} ${normalLabels.join("+")} to ${recoveryLabels.join("+")}`;

  // Worst-case ladder disclosure: the lowest recovery payout grows debt the
  // fastest and the lowest fair rate fails the most often.
  const worstPayout = Math.min(...recovery.map(forgePayout));
  const worstRate = Math.min(...recovery.map(forgeFairRate));

  return {
    name,
    xml,
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
      forceEntryAfter,
      watchMarkets,
      ladder: ladderRisk(worstPayout, markupPercent, maxRecoverySteps, worstRate),
    },
  };
}
