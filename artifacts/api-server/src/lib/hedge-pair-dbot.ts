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
    currency: string;
  };
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
    analysisWindow: Math.max(100, Math.min(1000, Math.trunc(Number(input.analysisWindow) || 500))),
    minSamples: Math.max(20, Math.min(1000, Math.trunc(Number(input.minSamples) || 80))),
    requiredEdge: Math.max(0, Math.min(0.5, Number.isFinite(Number(input.requiredEdge)) ? Number(input.requiredEdge) : 0.01)),
    recoveryMultiplier: Math.max(1.01, Math.min(5, Number(input.recoveryMultiplier) || 1.62)),
    maxRecoverySteps: Math.max(1, Math.min(10, Math.trunc(Number(input.maxRecoverySteps) || 3))),
    markupPercent: Math.max(0, Math.min(100, Number(input.markupPercent) || 0)),
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
  };
  if (definition.needsPriceBarriers) {
    requireValue(config.upperOffset > 0 && config.lowerOffset > 0, "Upper and lower price-barrier offsets must be positive");
  }
  const marketPath = marketPathForSymbol(input.symbol);
  const x = new XmlBuilder();
  const pairLabel = definition.label;
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
              `${config.analysisWindow}-tick causal tape · 95% HAC lower-bound gate · paired buys are non-atomic; Run in this Builder is required`,
          ),
        ),
        x.notify(
          "warn",
          x.text(
            `No profitability promise. The bot waits unless both live quotes and the joint pair-payoff lower bound clear the configured edge hurdle. A one-win/one-loss pair never triggers recovery.`,
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
          cycleField("UPPER_OFFSET", config.upperOffset) +
          cycleField("LOWER_OFFSET", config.lowerOffset) +
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
          cycleField("RECOVERY_CONFIRMATIONS", config.recoveryConfirmations),
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
    "Recovery is triggered only after both legs settle as losses. A split win/loss never triggers a recovery step, even if the combined live P&L is negative; the negative amount remains in session P&L.",
    "Recovery stake sizing uses both legs' live proposal returns and a conservative joint-return lower bound, then caps the per-leg amount by the configured multiplier ladder, max stake and half the current balance. It cannot guarantee debt recovery.",
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
      currency: input.currency,
    },
  };
}
