/**
 * Hedge Pair Forge → Deriv Bot (Blockly) strategy generator.
 *
 * This factory does not analyse or trade in the NeuroTrade API. Create DBot
 * only loads this workspace into the embedded Builder; the Builder's own Run
 * button invokes the custom in-bot analysis, timing, quote, pair-buy and
 * settlement lifecycle.
 */

import { XmlBuilder, esc } from "./dbot-xml";
import { marketPathForSymbol } from "./overunder-turbo-dbot";

export const HEDGE_PAIR_DEFINITIONS = Object.freeze({
  DIGIT_OVERUNDER: { label: "Over 5 / Under 4", legs: [{ type: "DIGITOVER", barrier: 5, barriers: 1 }, { type: "DIGITUNDER", barrier: 4, barriers: 1 }], tradeCategory: "digits", tradeType: "overunder", needsDigitStream: true, needsPriceBarriers: false, timing: { confirmations: 2, recoveryConfirmations: 3 } },
  ONLY_UPS_DOWNS: { label: "Only Ups / Only Downs", legs: [{ type: "RUNHIGH", barriers: 0 }, { type: "RUNLOW", barriers: 0 }], tradeCategory: "runs", tradeType: "runs", needsDigitStream: false, needsPriceBarriers: false, timing: { confirmations: 3, recoveryConfirmations: 4 } },
  HIGHER_LOWER: { label: "Higher / Lower", legs: [{ type: "CALL", barrier: "upper", barriers: 1 }, { type: "PUT", barrier: "lower", barriers: 1 }], tradeCategory: "callput", tradeType: "higherlower", needsDigitStream: false, needsPriceBarriers: true, timing: { confirmations: 2, recoveryConfirmations: 3 } },
  TOUCH_UPPER_LOWER: { label: "Touch upper / Touch lower", legs: [{ type: "ONETOUCH", barrier: "upper", barriers: 1 }, { type: "ONETOUCH", barrier: "lower", barriers: 1 }], tradeCategory: "touchnotouch", tradeType: "touchnotouch", needsDigitStream: false, needsPriceBarriers: true, timing: { confirmations: 2, recoveryConfirmations: 3 } },
  NO_TOUCH_UPPER_LOWER: { label: "No Touch upper / No Touch lower", legs: [{ type: "NOTOUCH", barrier: "upper", barriers: 1 }, { type: "NOTOUCH", barrier: "lower", barriers: 1 }], tradeCategory: "touchnotouch", tradeType: "touchnotouch", needsDigitStream: false, needsPriceBarriers: true, timing: { confirmations: 3, recoveryConfirmations: 4 } },
  ENDS_BETWEEN_OUTSIDE: { label: "Ends Between / Ends Outside", legs: [{ type: "EXPIRYRANGE", barrier: "upper", barrier2: "lower", barriers: 2 }, { type: "EXPIRYMISS", barrier: "upper", barrier2: "lower", barriers: 2 }], tradeCategory: "inout", tradeType: "endsinout", needsDigitStream: false, needsPriceBarriers: true, timing: { confirmations: 2, recoveryConfirmations: 3 } },
  STAYS_BETWEEN_OUTSIDE: { label: "Stays Between / Goes Outside", legs: [{ type: "RANGE", barrier: "upper", barrier2: "lower", barriers: 2 }, { type: "UPORDOWN", barrier: "upper", barrier2: "lower", barriers: 2 }], tradeCategory: "inout", tradeType: "staysinout", needsDigitStream: false, needsPriceBarriers: true, timing: { confirmations: 3, recoveryConfirmations: 4 } },
} as const);

type HedgePairFamily = keyof typeof HEDGE_PAIR_DEFINITIONS;
export const HEDGE_PAIR_FAMILIES = Object.keys(HEDGE_PAIR_DEFINITIONS) as HedgePairFamily[];

export const HEDGE_PAIR_BLOCK_TYPES = Object.freeze([
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
  "notify",
  "text",
  "math_number_positive",
  "nt_hedge_pair_cycle",
  "nt_hedge_pair_status",
  "controls_if",
] as const);

export interface HedgePairInput {
  symbol: string;
  displayName: string;
  family: string;
  stake: number;
  requestedDuration: number;
  upperOffset: number;
  lowerOffset: number;
  analysisWindow: number;
  minSamples: number;
  requiredEdge: number;
  recoveryMultiplier: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStake: number;
  takeProfit: number;
  stopLoss: number;
  maxConsecutiveDoubleLosses: number;
  entryConfirmations?: number;
  recoveryConfirmations?: number;
  /** Comma separated watch list. Empty/omitted = the bot's own market only. */
  watchMarkets?: string;
  /** Patience valve, seconds, normal mode only. 0 (default) = never force. */
  forceEntryAfter?: number;
  currency: string;
}

export interface HedgePairStrategy {
  name: string;
  xml: string;
  warnings: string[];
  summary: {
    symbol: string;
    displayName: string;
    family: string;
    pair: string;
    contracts: [string, string];
    perLegStake: number;
    basePairExposure: number;
    targetDurationTicks: number;
    analysisWindow: number;
    minSamples: number;
    requiredEdge: number;
    recoveryMultiplier: number;
    maxRecoverySteps: number;
    markupPercent: number;
    maxStakePerLeg: number;
    maxPairExposure: number;
    takeProfit: number;
    stopLoss: number;
    maxConsecutiveDoubleLosses: number;
    entryConfirmations: number;
    recoveryConfirmations: number;
    watchMarkets: string[];
    forceEntryAfter: number;
    /**
     * Debt-driven sizing for ONE pair's debt (both base legs lost), projected at
     * the configured ladder ceiling: no live payout exists at build time, and
     * inventing one would be a fabricated number in the owner's face. The runtime
     * re-computes this from the poorer of the two live leg payouts every cycle.
     */
    recoveryProjection: {
      debt: number;
      markupPercent: number;
      target: number;
      assumedWinMultiplier: number;
      stakePerLeg: number;
      pairStake: number;
      netOnPairWin: number;
      residualAfterWin: number;
      pairsToClear: number;
      ladder: { step: number; debt: number; stakePerLeg: number; pairStake: number }[];
      capBinding: string;
      caveat: string;
    };
    currency: string;
  };
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Smallest barrier offset the Builder's number field can hold.
 *
 * The `nt_hedge_pair_cycle` block declares `FieldNumber(..., 1e-8)` for both
 * offsets; Blockly rounds every value — including one restored from XML — to
 * `Math.round(v / precision) * precision` and then to the precision's decimal
 * places (8). Anything smaller cannot survive the round trip, so refusing it
 * here turns a silent runtime hold into an actionable message at build time.
 */
export const MIN_REPRESENTABLE_OFFSET = 1e-8;
/** Deriv's hard maximum for one `ticks_history` request (5000 is rejected). */
export const MAX_ANALYSIS_WINDOW = 5000;
export const DEFAULT_ANALYSIS_WINDOW = 4999;
/** Hedge Pair Forge's own recovery markup — a pair risks two premiums at once. */
export const DEFAULT_PAIR_MARKUP_PERCENT = 40;
/** Ceiling on the per-leg recovery ladder, not the size. */
export const DEFAULT_PAIR_RECOVERY_MULTIPLIER = 2.43;

/** Plain decimal text: never exponent notation inside a Blockly field. */
function formatOffset(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 8 });
}

/** Stakes round UP to the cent: the debt must never be under-sized. */
const round2 = (value: number) => Math.ceil((value - 1e-10) * 100) / 100;
/** Displayed money rounds to the nearest cent, matching the runtime journal. */
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Mirror of the runtime's `sizePairRecovery` for one debt level.
 *
 *   target      = debt × (1 + markup / 100)
 *   stakePerLeg = target ÷ (winMultiplier − 1)          (the repo's canonical
 *                                                        single-contract shape)
 *   capped by   = baseStake × ceiling^step, maxStake, balance
 *   floored at  = the broker's 0.35 minimum
 *
 * A pair risks two premiums, so ONE split win nets `stake × (winMultiplier − 2)`
 * and does not clear the debt; the runtime stays armed and sizes the residual on
 * the next pair. `pairsToClear` walks that chain so the console can show it
 * instead of implying a one-shot recovery.
 */
function projectPairRecovery({
  debt,
  markupPercent,
  winMultiplier,
  baseStake,
  ceiling,
  maxStake,
  maxRecoverySteps,
}: {
  debt: number;
  markupPercent: number;
  winMultiplier: number;
  baseStake: number;
  ceiling: number;
  maxStake: number;
  maxRecoverySteps: number;
}) {
  const minimumStake = 0.35;
  const sizeAt = (owed: number, step: number) => {
    const target = owed * (1 + markupPercent / 100);
    const cap = Math.min(baseStake * Math.pow(ceiling, Math.max(1, step)), maxStake);
    if (!(winMultiplier > 1) || cap < minimumStake) return null;
    const exact = target / (winMultiplier - 1);
    const stake = Math.max(minimumStake, round2(Math.min(exact, cap)));
    return { target, exact, cap, stake, netOnPairWin: stake * (winMultiplier - 2) };
  };

  const first = sizeAt(debt, 1);
  if (!first) {
    return {
      debt: cents(debt), markupPercent, target: cents(debt * (1 + markupPercent / 100)),
      assumedWinMultiplier: winMultiplier, stakePerLeg: 0, pairStake: 0, netOnPairWin: 0,
      residualAfterWin: cents(debt), pairsToClear: 0, ladder: [], capBinding: "unpayable payout",
      caveat: `A winning leg paying ${winMultiplier.toFixed(2)}× cannot repay a pair debt: the payout must exceed 1.00× to size anything and 2.00× before a split win shrinks the debt.`,
    };
  }
  const capBinding = first.stake < round2(first.exact) - 1e-9 ? "ladder ceiling / max stake" : "none";

  const ladder: { step: number; debt: number; stakePerLeg: number; pairStake: number }[] = [];
  let owed = debt;
  let pairs = 0;
  for (let step = 1; step <= Math.max(1, maxRecoverySteps) && owed > 0.005; step += 1) {
    const sized = sizeAt(owed, step);
    if (!sized) break;
    ladder.push({ step, debt: cents(owed), stakePerLeg: sized.stake, pairStake: cents(sized.stake * 2) });
    break; // one rung: the next rung only exists if another double loss lands
  }
  // A double loss mid-recovery is what escalates the ladder, so show those rungs.
  let escalated = first.stake * 2;
  for (let step = 2; step <= Math.max(1, maxRecoverySteps); step += 1) {
    const owedAfterLoss = escalated;
    const sized = sizeAt(owedAfterLoss, step);
    if (!sized) break;
    ladder.push({ step, debt: cents(owedAfterLoss), stakePerLeg: sized.stake, pairStake: cents(sized.stake * 2) });
    escalated = sized.stake * 2 + owedAfterLoss;
  }

  // Split-win decay chain: how many consecutive one-win pairs clear the debt.
  let remaining = debt;
  while (remaining > 0.005 && pairs < 40) {
    const sized = sizeAt(remaining, 1);
    if (!sized) break;
    if (sized.netOnPairWin <= 0) break;
    remaining = Math.max(0, remaining - sized.netOnPairWin);
    pairs += 1;
  }

  return {
    debt: cents(debt),
    markupPercent,
    target: cents(first.target),
    assumedWinMultiplier: winMultiplier,
    stakePerLeg: first.stake,
    pairStake: cents(first.stake * 2),
    netOnPairWin: cents(first.netOnPairWin),
    residualAfterWin: cents(Math.max(0, debt - first.netOnPairWin)),
    pairsToClear: remaining > 0.005 ? 0 : pairs,
    ladder,
    capBinding,
    caveat: `Projected at an assumed winning-leg payout of ${winMultiplier.toFixed(2)}× (this bot's ladder ceiling) because no live quote exists at build time. The runtime sizes every pair from the poorer of the two live leg payouts and refuses to trade when that payout is 2.00× or lower, because a split win could not shrink the debt.`,
  };
}

/** Normalize a watch list the same way the runtime does: seed first, dedup, cap. */
export const MAX_WATCH_MARKETS = 8;
export function normalizeWatchMarkets(input: unknown, seedSymbol: string): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(",");
  const seed = String(seedSymbol ?? "").trim().toUpperCase();
  const cleaned: string[] = [];
  for (const entry of raw) {
    const symbol = String(entry ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,30}$/.test(symbol)) continue;
    if (!cleaned.includes(symbol)) cleaned.push(symbol);
  }
  if (seed && /^[A-Z0-9_]{2,30}$/.test(seed)) {
    const at = cleaned.indexOf(seed);
    if (at > 0) cleaned.splice(at, 1);
    if (at !== 0) cleaned.unshift(seed);
  }
  return cleaned.slice(0, MAX_WATCH_MARKETS);
}

export function buildHedgePairStrategy(input: HedgePairInput): HedgePairStrategy {
  requireValue(/^[A-Z0-9_]{2,30}$/.test(input.symbol), "Choose a valid Deriv symbol");
  const family = String(input.family).toUpperCase() as HedgePairFamily;
  requireValue(HEDGE_PAIR_FAMILIES.includes(family), "Choose one supported hedge-pair family");
  requireValue(Number.isFinite(input.stake) && input.stake >= 0.35 && input.stake <= 50000, "Per-leg stake must be between 0.35 and 50000");
  requireValue(Number.isFinite(input.maxStake) && input.maxStake >= 0.35 && input.maxStake <= 50000, "Maximum per-contract stake must be between 0.35 and 50000");
  requireValue(input.stake <= input.maxStake, "Per-leg base stake cannot exceed the account's Max Stake Per Trade setting");
  requireValue(/^[A-Z]{3}$/.test(input.currency), "Account currency is invalid");

  const definition = HEDGE_PAIR_DEFINITIONS[family];
  const config = {
    family,
    // One tick is the target. Runtime metadata may raise it only to the
    // contracts' actual shared minimum when one tick is unavailable.
    requestedDuration: 1,
    upperOffset: Number.isFinite(Number(input.upperOffset)) ? Math.max(0, Number(input.upperOffset)) : 0,
    lowerOffset: Number.isFinite(Number(input.lowerOffset)) ? Math.max(0, Number(input.lowerOffset)) : 0,
    // Deep tape by default: at 500 ticks a one-minute pair yields eight
    // non-overlapping samples and can never clear the 20-sample hard floor, which
    // is why Ends / Stays Between looked like a bot that never analysed anything.
    analysisWindow: Math.max(100, Math.min(MAX_ANALYSIS_WINDOW, Math.trunc(Number(input.analysisWindow) || DEFAULT_ANALYSIS_WINDOW))),
    minSamples: Math.max(20, Math.min(1000, Math.trunc(Number(input.minSamples) || 80))),
    // 0 = break-even. The hurdle is enforced at runtime now, so a build-time
    // default of 0.01 would silently demand +1% per combined stake.
    requiredEdge: Math.max(0, Math.min(0.5, Number.isFinite(Number(input.requiredEdge)) ? Number(input.requiredEdge) : 0)),
    recoveryMultiplier: Math.max(1.01, Math.min(5, Number(input.recoveryMultiplier) || DEFAULT_PAIR_RECOVERY_MULTIPLIER)),
    maxRecoverySteps: Math.max(1, Math.min(10, Math.trunc(Number(input.maxRecoverySteps) || 3))),
    markupPercent: Math.max(0, Math.min(100, Number.isFinite(Number(input.markupPercent)) ? Number(input.markupPercent) : DEFAULT_PAIR_MARKUP_PERCENT)),
    maxStake: Math.max(0.35, Number(input.maxStake)),
    takeProfit: Math.max(0.01, Number(input.takeProfit) || 10),
    stopLoss: Math.max(0.01, Number(input.stopLoss) || 5),
    maxConsecutiveDoubleLosses: Math.max(1, Math.min(20, Math.trunc(Number(input.maxConsecutiveDoubleLosses) || 6))),
    entryConfirmations: Math.max(
      definition.timing.confirmations,
      Math.min(12, Math.trunc(Number(input.entryConfirmations) || definition.timing.confirmations)),
    ),
    recoveryConfirmations: Math.max(
      definition.timing.recoveryConfirmations,
      Math.min(12, Math.trunc(Number(input.recoveryConfirmations) || definition.timing.recoveryConfirmations)),
    ),
    watchMarkets: normalizeWatchMarkets(input.watchMarkets, input.symbol),
    forceEntryAfter: Math.max(0, Math.min(3600, Math.trunc(Number(input.forceEntryAfter) || 0))),
  };
  if (definition.needsPriceBarriers) {
    requireValue(config.upperOffset > 0 && config.lowerOffset > 0, "Upper and lower price-barrier offsets must be positive");
    // The console defaults these to one pip (1e-4 on a pipSize-4 index). That is
    // representable, but 1e-9 would be rounded to 0 by the Blockly field and the
    // bot would then hold forever on "offsets must both be positive".
    requireValue(
      config.upperOffset >= MIN_REPRESENTABLE_OFFSET && config.lowerOffset >= MIN_REPRESENTABLE_OFFSET,
      `Price-barrier offsets must be at least ${MIN_REPRESENTABLE_OFFSET} (the Builder's number field cannot store anything smaller)`,
    );
  }
  const marketPath = marketPathForSymbol(input.symbol);
  const x = new XmlBuilder();
  const pairLabel = definition.label;
  /** Shared bot-recovery markup the other five specialist bots use (settings-owned). */
  const SHARED_MARKUP_PERCENT = 10;
  const projection = projectPairRecovery({
    debt: round2(input.stake * 2),
    markupPercent: config.markupPercent,
    // No live payout exists at build time; project at this bot's ladder ceiling
    // and say so, rather than inventing a broker payout.
    winMultiplier: config.recoveryMultiplier,
    baseStake: input.stake,
    ceiling: config.recoveryMultiplier,
    maxStake: config.maxStake,
    maxRecoverySteps: config.maxRecoverySteps,
  });
  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="hpoptions">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="false"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${esc(input.currency)}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="hpduration"><field name="NUM">${config.requestedDuration}</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="hpstake"><field name="NUM">${esc(input.stake)}</field></shadow></value>` +
    `</block>`;

  const marketDefinition =
    `<block type="trade_definition_market" id="hpmarket" deletable="false" movable="false">` +
    `<field name="MARKET_LIST">${esc(marketPath.market)}</field>` +
    `<field name="SUBMARKET_LIST">${esc(marketPath.submarket)}</field>` +
    `<field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
    `<next><block type="trade_definition_tradetype" id="hptradetype" deletable="false" movable="false">` +
    `<field name="TRADETYPECAT_LIST">${esc(definition.tradeCategory)}</field>` +
    `<field name="TRADETYPE_LIST">${esc(definition.tradeType)}</field>` +
    `<next><block type="trade_definition_contracttype" id="hpcontracttype" deletable="false" movable="false">` +
    `<field name="TYPE_LIST">both</field>` +
    `<next><block type="trade_definition_candleinterval" id="hpcandle" deletable="false" movable="false">` +
    `<field name="CANDLEINTERVAL_LIST">60</field>` +
    `<next><block type="trade_definition_restartbuysell" id="hprestart" deletable="false" movable="false">` +
    `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
    `<next><block type="trade_definition_restartonerror" id="hperror" deletable="false" movable="false">` +
    // Pair execution is not idempotent after a partial buy. Stop on unexpected
    // errors rather than letting the Builder automatically replay a possible fill.
    `<field name="RESTARTONERROR">FALSE</field>` +
    `</block></next></block></next></block></next></block></next></block></next></block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">${marketDefinition}</statement>` +
      `<statement name="INITIALIZATION">${x.chain([
        x.notify(
          "info",
          x.text(
            `Hedge Pair Forge · ${input.displayName} · ${pairLabel} · ${input.currency} ${input.stake.toFixed(2)} per leg / ${input.currency} ${(input.stake * 2).toFixed(2)} pair exposure · target ${config.requestedDuration} tick(s) · ` +
              `up to ${config.analysisWindow} ticks of Deriv deep history replayed as non-overlapping pairs · measured joint EV must clear ${(config.requiredEdge * 100).toFixed(2)}% per combined stake (0% = break-even) · ` +
              `watching ${config.watchMarkets.length} market(s): ${config.watchMarkets.join(", ")} · paired buys are non-atomic; Run in this Builder is required`,
          ),
        ),
        x.notify(
          "warn",
          x.text(
            `No profitability promise. Every hold is written to the Builder's Journal with its own arithmetic — paired sample count against the count the tape can actually produce, joint win/loss state counts, measured EV against the hurdle, entry timing. ` +
              `Hard blockers (too few paired samples, a tape in which every replayed pair lost both legs, an unstable estimate, entry timing) are never overridden` +
              `${config.forceEntryAfter > 0 ? `; only a negative-EV hold may be forced after ${config.forceEntryAfter}s of continuous holding` : "; the patience valve is off, so a negative-EV hold is never forced"}. ` +
              `A one-win/one-loss pair never triggers recovery, but it never disarms an outstanding debt either.`,
          ),
        ),
        x.notify(
          "info",
          x.text(
            `Pair recovery arithmetic · markup ${config.markupPercent}%${config.markupPercent === SHARED_MARKUP_PERCENT ? "" : ` (this bot's own; the shared server default is ${SHARED_MARKUP_PERCENT}%)`} · debt = BOTH lost premiums · ` +
              `per-leg stake = debt × (1 + ${config.markupPercent}%) ÷ (winning-leg payout − 1), capped at base × ${config.recoveryMultiplier.toFixed(2)}^step, max stake and half the balance, floored at 0.35 · ` +
              (projection.netOnPairWin > 0
                ? `projected at a ${projection.assumedWinMultiplier.toFixed(2)}× winning leg, one pair's debt of ${projection.debt.toFixed(2)} sizes ${projection.stakePerLeg.toFixed(2)} per leg (${projection.pairStake.toFixed(2)} at risk)` +
                  `${projection.capBinding === "none" ? "" : `, clamped by the ${projection.capBinding}`} · a split win nets ${projection.netOnPairWin.toFixed(2)} and leaves ${projection.residualAfterWin.toFixed(2)} owed` +
                  `${projection.pairsToClear > 0 ? `, cleared by ${projection.pairsToClear} consecutive split wins` : ""} · `
                : `at a ${projection.assumedWinMultiplier.toFixed(2)}× winning leg a split win would net ${projection.netOnPairWin.toFixed(2)}, so the runtime REFUSES to size a recovery until the live legs pay above 2.00× · `) +
              `recovery stays armed until the debt is 0 · the runtime re-sizes every pair from the poorer of the two LIVE leg payouts, not from this projection`,
          ),
        ),
      ])}</statement>` +
      `<statement name="SUBMARKET">${tradeOptions}</statement>`,
    0,
    0,
  );

  const cycleField = (name: string, value: string | number) => `<field name="${name}">${esc(value)}</field>`;
  const cycleBlock = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">` +
      x.chain([{
        type: "nt_hedge_pair_cycle",
        inner:
          cycleField("FAMILY", config.family) +
          cycleField("DURATION", config.requestedDuration) +
          cycleField("UPPER_OFFSET", formatOffset(config.upperOffset)) +
          cycleField("LOWER_OFFSET", formatOffset(config.lowerOffset)) +
          cycleField("WINDOW", config.analysisWindow) +
          cycleField("MIN_SAMPLES", config.minSamples) +
          cycleField("EDGE_HURDLE", config.requiredEdge) +
          cycleField("RECOVERY_MULTIPLIER", config.recoveryMultiplier) +
          cycleField("MAX_RECOVERY_STEPS", config.maxRecoverySteps) +
          cycleField("MARKUP_PERCENT", config.markupPercent) +
          cycleField("MAX_STAKE", config.maxStake) +
          cycleField("TAKE_PROFIT", config.takeProfit) +
          cycleField("STOP_LOSS", config.stopLoss) +
          cycleField("LOSS_BREAKER", config.maxConsecutiveDoubleLosses) +
          cycleField("ENTRY_CONFIRMATIONS", config.entryConfirmations) +
          cycleField("RECOVERY_CONFIRMATIONS", config.recoveryConfirmations) +
          // Appended LAST: the runtime signature is positional, so workspaces
          // saved before these fields existed still load and mean the same thing.
          cycleField("MARKETS", config.watchMarkets.join(",")) +
          cycleField("FORCE_ENTRY_AFTER", config.forceEntryAfter),
      }]) +
      `</statement>`,
    0,
    900,
  );

  const afterPurchase = x.topLevel(
    "after_purchase",
    `<statement name="AFTERPURCHASE_STACK">` +
      x.chain([{
        type: "controls_if",
        inner:
          `<value name="IF0"><block type="nt_hedge_pair_status" id="hpcontinuecheck"><field name="FIELD">continue</field></block></value>` +
          `<statement name="DO0"><block type="trade_again" id="hptradeagain"></block></statement>`,
      }]) +
      `</statement>`,
    0,
    1600,
  );

  const xml =
    `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">` +
    x.variablesXml() +
    tradeDefinition +
    cycleBlock +
    afterPurchase +
    `</xml>`;

  const warnings = [
    "Create DBot only loads blocks into the embedded Builder. Trades begin only when the user presses that Builder's Run button.",
    "Deriv does not offer an atomic two-contract buy. The generated bot submits both buys concurrently, records each fill, attempts an eligible early close after a partial fill, then halts new pairs and monitors any remaining exposure.",
    "The runtime targets one tick when the exact family/barrier contracts support it; otherwise it uses the shortest common duration from their live contracts_for metadata, including time units when necessary, then validates both live proposals. Missing or malformed metadata and rejected proposals fail closed.",
    `Analysis replays up to ${config.analysisWindow} ticks of Deriv deep history as NON-OVERLAPPING pairs, so one observation costs the pair's whole duration. When a tape cannot produce the configured ${config.minSamples} pairs, the bot accepts what is reachable down to a hard floor of 20 and marks the result low-confidence; when it cannot even reach 20 it holds and the Journal names the arithmetic instead of silently lowering the bar.`,
    `Entry requires the measured joint expectation to clear ${(config.requiredEdge * 100).toFixed(2)}% per combined stake (0% = break-even). The 95% lower bound, the estimate's instability across windows, the joint win/loss state counts and the entry-timing score are reported in the Journal and through the hedge-pair status block, but the hurdle itself is applied to the measured expectation.`,
    "Recovery is triggered only after both legs settle as losses. A split win/loss never triggers a recovery step, even if the combined live P&L is negative; the negative amount remains in session P&L. A split no longer DISARMS an outstanding debt either: recovery stays armed and sizes the residual until the debt reaches zero.",
    `Recovery stake per leg = debt × (1 + ${config.markupPercent}%) ÷ (winning-leg payout − 1), where the payout is the POORER of the two live legs, then capped by base × ${config.recoveryMultiplier.toFixed(2)}^step, max stake and half the balance, and floored at the broker's 0.35 minimum. Because a pair spends two premiums, one split win nets stake × (payout − 2) and does not clear the debt; the ledger carries the residual. Sizing refuses to trade when the live winning leg pays 2.00× or less. It cannot guarantee debt recovery.`,
    config.watchMarkets.length > 1
      ? `The bot ranks ${config.watchMarkets.join(", ")} for this pair on measured evidence — repayment rate, estimate stability, entry-timing score and sample confidence, never on assumed payouts — and may switch between contracts. A candidate must lead by at least 1 evidence point (2 in recovery), the incumbent must have been held for 60 evaluations and 120 must have passed since the last switch. Switching never happens while a pair is live; all per-market caches are cleared on a move.`
      : "Only one market is watched, so no market-to-market switching can occur. Add markets in the Hedge Pair Forge console (or the block's watch-markets field) to let the bot rank and rotate between contracts.",
    config.forceEntryAfter > 0
      ? `The patience valve is ON: after ${config.forceEntryAfter}s of continuous holding against a negative measured EV, the bot enters anyway and labels the entry in the Journal. Hard blockers are never overridden, and recovery never uses the valve.`
      : "The patience valve is off, so a setup whose measured joint EV is below the hurdle is never forced — the bot holds and keeps explaining why.",
    "All theoretical relationships and in-sample estimates are hypotheses, not a proven trading edge. Live quotes, future market behavior, slippage and sample uncertainty can reverse measured results.",
  ];

  return {
    name: `Hedge Pair Forge — ${pairLabel} — ${input.displayName}`,
    xml,
    warnings,
    summary: {
      symbol: input.symbol,
      displayName: input.displayName,
      family: config.family,
      pair: pairLabel,
      contracts: [definition.legs[0].type, definition.legs[1].type],
      perLegStake: input.stake,
      basePairExposure: input.stake * 2,
      targetDurationTicks: config.requestedDuration,
      analysisWindow: config.analysisWindow,
      minSamples: config.minSamples,
      requiredEdge: config.requiredEdge,
      recoveryMultiplier: config.recoveryMultiplier,
      maxRecoverySteps: config.maxRecoverySteps,
      markupPercent: config.markupPercent,
      maxStakePerLeg: config.maxStake,
      maxPairExposure: config.maxStake * 2,
      takeProfit: config.takeProfit,
      stopLoss: config.stopLoss,
      maxConsecutiveDoubleLosses: config.maxConsecutiveDoubleLosses,
      entryConfirmations: config.entryConfirmations,
      recoveryConfirmations: config.recoveryConfirmations,
      watchMarkets: config.watchMarkets,
      forceEntryAfter: config.forceEntryAfter,
      recoveryProjection: projection,
      currency: input.currency,
    },
  };
}
