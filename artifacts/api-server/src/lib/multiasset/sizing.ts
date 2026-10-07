/**
 * Multi-Asset Desk — position sizing.
 *
 * 0.10 lots is 10 000 EUR on EURUSD, 10 ounces on XAUUSD and one index
 * contract on US30. The money at risk for the same lot size differs by orders
 * of magnitude, so lots are never chosen directly: the user chooses a
 * percentage of equity, and this module converts it using the broker's own
 * contract specification.
 *
 *   riskMoney  = equity × riskPct
 *   slPoints   = |entry − sl| / point
 *   pointValue = tickValue × (point / tickSize)      [account ccy / point / lot]
 *   lots       = riskMoney / (slPoints × pointValue), quantised to volumeStep
 *
 * `tickValue` arrives from MT5 already denominated in the ACCOUNT currency,
 * which is what makes one formula correct for USD, EUR or KES accounts with no
 * conversion table of our own.
 *
 * Everything after the formula is refusal logic. Being unable to size a trade
 * safely is a normal, frequent and correct outcome — see docs/multi-asset-architecture.md §2.1.
 */

import { costPolicyFor } from "./asset-costs";
import type { Position, Side, SymbolSpec } from "./types";

export interface SizingLimits {
  /** Minimum margin level (%) that must remain AFTER the trade is opened. */
  minMarginLevelPct: number;
  /** Reject when round-trip cost exceeds this fraction of the risk budget. */
  maxCostFractionOfRisk: number;
  /** Hard ceiling on risk per trade as a percentage of equity. */
  maxRiskPct: number;
  /** Reject when the spread alone exceeds this fraction of the stop distance. */
  maxSpreadFractionOfStop: number;
  /** Minimum acceptable reward:risk after any SL widening. */
  minRewardRisk: number;
}

/**
 * Fallback limits for a caller that supplies none.
 *
 * The two cost ceilings here are only a fallback: `sizePosition` resolves them
 * from the SYMBOL'S ASSET CLASS (asset-costs.ts) unless the caller overrides
 * them explicitly. A fixed pair of numbers cannot describe both a 0.2-pip
 * EURUSD quote and a BTCUSD quote twenty points wide.
 */
export const DEFAULT_SIZING_LIMITS: SizingLimits = {
  minMarginLevelPct: 500,
  maxCostFractionOfRisk: 0.35,
  maxRiskPct: 2,
  maxSpreadFractionOfStop: 0.35,
  minRewardRisk: 1,
};

export interface SizingRequest {
  spec: SymbolSpec;
  side: Side;
  entry: number;
  sl: number;
  /** Primary take-profit, used only for the reward:risk check. */
  tp?: number;
  equity: number;
  freeMargin: number;
  /** Margin currently used by open positions, for the post-trade level check. */
  usedMargin: number;
  riskPct: number;
  leverage: number;
  limits?: Partial<SizingLimits>;
}

export type SizingRejection =
  | "invalid_input"
  | "stop_too_tight"
  | "below_min_lot"
  | "insufficient_margin"
  | "cost_exceeds_edge"
  | "spread_too_wide"
  | "reward_risk_too_low";

export interface SizingResult {
  ok: boolean;
  lots: number;
  /** Money at risk in account currency if the stop is hit, including costs. */
  riskMoney: number;
  riskPoints: number;
  /** Account currency per point per 1.00 lot. */
  pointValue: number;
  /** The stop actually used — may be wider than requested (broker stop level). */
  sl: number;
  /** True when the SL had to be moved to satisfy the broker's stops level. */
  slAdjusted: boolean;
  costMoney: number;
  marginRequired: number;
  /** Projected margin level (%) once the position is open. */
  projectedMarginLevel: number;
  effectiveRiskPct: number;
  rejection: SizingRejection | null;
  /** Always populated — the terminal shows this verbatim. */
  explanation: string;
}

/**
 * Account currency gained or lost per point of price movement, per 1.00 lot.
 *
 * For most FX symbols tickSize === point and this is simply tickValue. It
 * differs on instruments quoted with a tick size coarser than a point (many
 * indices and futures CFDs), which is exactly where naive bots mis-size.
 */
export function pointValuePerLot(spec: SymbolSpec): number {
  if (spec.tickSize > 0 && spec.tickValue > 0 && spec.point > 0) {
    return spec.tickValue * (spec.point / spec.tickSize);
  }
  // Fallback for a spec that omitted tick data: notional per point.
  return spec.contractSize * spec.point;
}

/** Price distance converted to broker points. */
export function priceToPoints(spec: SymbolSpec, priceDistance: number): number {
  if (spec.point <= 0) return 0;
  return Math.abs(priceDistance) / spec.point;
}

/** Quantise down to a legal volume. Rounding UP would exceed the risk budget. */
export function quantiseVolume(spec: SymbolSpec, lots: number): number {
  const step = spec.volumeStep > 0 ? spec.volumeStep : 0.01;
  const steps = Math.floor(lots / step + 1e-9);
  const quantised = steps * step;
  // Floating point: 0.1 + 0.2 style drift would produce 0.30000000000000004 lots,
  // which some brokers reject outright.
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number(Math.min(quantised, spec.volumeMax).toFixed(decimals));
}

/** Margin for a position, preferring the broker's figure over leverage math. */
export function marginForLots(spec: SymbolSpec, lots: number, price: number, leverage: number): number {
  if (spec.marginInitial > 0) return spec.marginInitial * lots;
  if (leverage > 0) return (spec.contractSize * lots * price) / leverage;
  return spec.contractSize * lots * price;
}

/** Round-trip cost in account currency: spread crossed once + commission. */
export function costForLots(spec: SymbolSpec, lots: number): number {
  const pv = pointValuePerLot(spec);
  return spec.spreadPoints * pv * lots + spec.commissionPerLot * lots;
}

function reject(
  rejection: SizingRejection,
  explanation: string,
  partial: Partial<SizingResult> = {},
): SizingResult {
  return {
    ok: false,
    lots: 0,
    riskMoney: 0,
    riskPoints: partial.riskPoints ?? 0,
    pointValue: partial.pointValue ?? 0,
    sl: partial.sl ?? 0,
    slAdjusted: partial.slAdjusted ?? false,
    costMoney: partial.costMoney ?? 0,
    marginRequired: partial.marginRequired ?? 0,
    projectedMarginLevel: partial.projectedMarginLevel ?? 0,
    effectiveRiskPct: 0,
    rejection,
    explanation,
  };
}

export function sizePosition(request: SizingRequest): SizingResult {
  const { spec, side, entry, equity, freeMargin, usedMargin, leverage } = request;
  // Cost ceilings are an ASSET-CLASS property, not a global constant: the same
  // 20-point spread is ordinary on a crypto CFD and disqualifying on EURUSD.
  // A caller may still override either ceiling explicitly.
  const policy = costPolicyFor(spec);
  const limits: SizingLimits = {
    ...DEFAULT_SIZING_LIMITS,
    maxCostFractionOfRisk: policy.maxCostFractionOfRisk,
    maxSpreadFractionOfStop: policy.maxSpreadFractionOfStop,
    ...(request.limits ?? {}),
  };

  if (!(entry > 0) || !(equity > 0) || !(spec.point > 0)) {
    return reject("invalid_input", "Entry price, equity and symbol point must all be positive.");
  }

  const riskPct = Math.min(Math.max(request.riskPct, 0), limits.maxRiskPct);
  if (riskPct <= 0) {
    return reject("invalid_input", "Risk percentage must be greater than zero.");
  }

  const long = side === "buy";
  let sl = request.sl;

  // Stop must be on the correct side of entry, or "risk" is meaningless.
  if ((long && sl >= entry) || (!long && sl <= entry)) {
    return reject(
      "invalid_input",
      `Stop loss ${sl} is on the wrong side of entry ${entry} for a ${side}.`,
    );
  }

  const pointValue = pointValuePerLot(spec);
  if (!(pointValue > 0)) {
    return reject("invalid_input", "Symbol specification does not yield a positive point value.");
  }

  // ── Broker minimum stop distance ───────────────────────────────────────────
  let slAdjusted = false;
  let riskPoints = priceToPoints(spec, entry - sl);
  if (spec.stopsLevel > 0 && riskPoints < spec.stopsLevel) {
    const required = spec.stopsLevel * spec.point;
    sl = long ? entry - required : entry + required;
    slAdjusted = true;
    riskPoints = spec.stopsLevel;
  }

  if (riskPoints <= 0) {
    return reject("stop_too_tight", "Stop distance rounds to zero points.", { pointValue, sl });
  }

  // Widening the stop lowers reward:risk. A plan that no longer clears the
  // floor must be dropped rather than quietly taken at worse odds.
  if (slAdjusted && request.tp !== undefined) {
    const rewardPoints = priceToPoints(spec, request.tp - entry);
    const rr = rewardPoints / riskPoints;
    if (rr < limits.minRewardRisk) {
      return reject(
        "reward_risk_too_low",
        `Broker minimum stop distance (${spec.stopsLevel} pts) cuts reward:risk to ${rr.toFixed(2)}, below the ${limits.minRewardRisk} floor.`,
        { pointValue, sl, slAdjusted, riskPoints },
      );
    }
  }

  // ── Spread sanity, judged against this symbol's asset class ───────────────
  // A 2-pip spread against a 4-pip stop means half the stop is cost. But what
  // is "half the stop" is not the same question on every instrument: crypto and
  // single-stock CFDs quote structurally wider than majors, and holding them to
  // an FX constant silently banned them. The ceiling comes from asset-costs.ts.
  if (spec.spreadPoints > 0 && spec.spreadPoints / riskPoints > limits.maxSpreadFractionOfStop) {
    return reject(
      "spread_too_wide",
      `Spread ${spec.spreadPoints} pts is ${((spec.spreadPoints / riskPoints) * 100).toFixed(0)}% of the ${riskPoints.toFixed(0)}-pt stop — ` +
        `above the ${(limits.maxSpreadFractionOfStop * 100).toFixed(0)}% ceiling for ${spec.assetClass}.`,
      { pointValue, sl, slAdjusted, riskPoints },
    );
  }

  // ── Base size ──────────────────────────────────────────────────────────────
  const riskBudget = equity * (riskPct / 100);
  const riskPerLot = riskPoints * pointValue;
  let lots = quantiseVolume(spec, riskBudget / riskPerLot);

  if (lots < spec.volumeMin) {
    // The broker's smallest trade already risks more than the user allows.
    // Rounding up here is the most common silent over-risk in retail bots.
    const minRisk = spec.volumeMin * riskPerLot;
    return reject(
      "below_min_lot",
      `Minimum ${spec.volumeMin} lots would risk ${minRisk.toFixed(2)} ${"units"} (${((minRisk / equity) * 100).toFixed(2)}% of equity), above the ${riskPct.toFixed(2)}% budget of ${riskBudget.toFixed(2)}.`,
      { pointValue, sl, slAdjusted, riskPoints },
    );
  }

  // ── Margin ─────────────────────────────────────────────────────────────────
  // Shrink before refusing: a smaller legal position is better than no trade,
  // provided it still clears volumeMin.
  let marginRequired = marginForLots(spec, lots, entry, leverage);
  let projectedMarginLevel = projectMarginLevel(equity, usedMargin, marginRequired);

  while (
    lots > spec.volumeMin &&
    (marginRequired > freeMargin || projectedMarginLevel < limits.minMarginLevelPct)
  ) {
    const reduced = quantiseVolume(spec, lots - (spec.volumeStep > 0 ? spec.volumeStep : 0.01));
    if (reduced <= 0 || reduced >= lots) break;
    lots = reduced;
    marginRequired = marginForLots(spec, lots, entry, leverage);
    projectedMarginLevel = projectMarginLevel(equity, usedMargin, marginRequired);
  }

  if (marginRequired > freeMargin || projectedMarginLevel < limits.minMarginLevelPct) {
    return reject(
      "insufficient_margin",
      `Margin ${marginRequired.toFixed(2)} would leave a margin level of ${projectedMarginLevel.toFixed(0)}%, below the ${limits.minMarginLevelPct}% floor (free margin ${freeMargin.toFixed(2)}).`,
      { pointValue, sl, slAdjusted, riskPoints, marginRequired, projectedMarginLevel },
    );
  }

  // ── Costs ──────────────────────────────────────────────────────────────────
  const costMoney = costForLots(spec, lots);
  const riskMoney = lots * riskPerLot;

  if (riskMoney > 0 && costMoney / riskMoney > limits.maxCostFractionOfRisk) {
    return reject(
      "cost_exceeds_edge",
      `Round-trip cost ${costMoney.toFixed(2)} (spread ${spec.spreadPoints} pts + commission) is ` +
        `${((costMoney / riskMoney) * 100).toFixed(0)}% of the ${riskMoney.toFixed(2)} risked — ` +
        `above the ${(limits.maxCostFractionOfRisk * 100).toFixed(0)}% ceiling for ${spec.assetClass}.`,
      { pointValue, sl, slAdjusted, riskPoints, costMoney, marginRequired, projectedMarginLevel },
    );
  }

  return {
    ok: true,
    lots,
    riskMoney,
    riskPoints,
    pointValue,
    sl,
    slAdjusted,
    costMoney,
    marginRequired,
    projectedMarginLevel,
    effectiveRiskPct: (riskMoney / equity) * 100,
    rejection: null,
    explanation:
      `${lots} lots — ${riskPoints.toFixed(0)} pts × ${pointValue.toFixed(2)}/pt/lot = ` +
      `${riskMoney.toFixed(2)} at risk (${((riskMoney / equity) * 100).toFixed(2)}% of ${equity.toFixed(2)})` +
      (slAdjusted ? `; stop widened to the broker minimum of ${spec.stopsLevel} pts` : "") +
      `; cost ${costMoney.toFixed(2)}; margin ${marginRequired.toFixed(2)}.`,
  };
}

function projectMarginLevel(equity: number, usedMargin: number, extraMargin: number): number {
  const total = usedMargin + extraMargin;
  if (total <= 0) return Number.POSITIVE_INFINITY;
  return (equity / total) * 100;
}

// ── Portfolio exposure ───────────────────────────────────────────────────────

/**
 * Currencies a symbol expresses an opinion on.
 *
 * Long EURUSD + long GBPUSD + short USDCHF is one bet against the dollar. Risk
 * measured per trade would call that three 1% positions; measured per currency
 * it is a single 3% position, which is what the governor must see.
 */
export function currencyLegs(spec: SymbolSpec): string[] {
  if (spec.baseCurrency && spec.quoteCurrency) return [spec.baseCurrency, spec.quoteCurrency];
  const symbol = spec.symbol.toUpperCase().replace(/[^A-Z]/g, "");
  if (spec.assetClass === "forex" && symbol.length >= 6) {
    return [symbol.slice(0, 3), symbol.slice(3, 6)];
  }
  // Non-FX instruments are grouped by asset class instead of by currency.
  return [`#${spec.assetClass}`];
}

export interface ExposureEntry {
  key: string;
  riskMoney: number;
  riskPct: number;
}

/**
 * Aggregate open risk per currency leg.
 *
 * A long position is +base/−quote; a short is the reverse. Offsetting
 * exposures genuinely reduce portfolio risk, so they are netted rather than
 * summed in absolute terms.
 */
export function aggregateExposure(
  positions: Position[],
  specs: Map<string, SymbolSpec>,
  equity: number,
): ExposureEntry[] {
  const net = new Map<string, number>();

  for (const position of positions) {
    const spec = specs.get(position.symbol);
    if (!spec) continue;
    const risk =
      position.initialRiskMoney ??
      (position.sl !== null
        ? priceToPoints(spec, position.openPrice - position.sl) *
          pointValuePerLot(spec) *
          position.volume
        : 0);
    if (risk <= 0) continue;

    const legs = currencyLegs(spec);
    const direction = position.side === "buy" ? 1 : -1;
    if (legs.length === 2) {
      net.set(legs[0], (net.get(legs[0]) ?? 0) + risk * direction);
      net.set(legs[1], (net.get(legs[1]) ?? 0) - risk * direction);
    } else {
      net.set(legs[0], (net.get(legs[0]) ?? 0) + risk * direction);
    }
  }

  return [...net.entries()]
    .map(([key, value]) => ({
      key,
      riskMoney: Math.abs(value),
      riskPct: equity > 0 ? (Math.abs(value) / equity) * 100 : 0,
    }))
    .filter((entry) => entry.riskMoney > 1e-9)
    .sort((a, b) => b.riskMoney - a.riskMoney);
}

/**
 * Fractional Kelly, floored at zero and capped.
 *
 * Full Kelly is famously too aggressive for a strategy whose win rate is
 * estimated rather than known; a quarter is the conventional compromise.
 * Size therefore scales with measured EDGE — never with recent losses.
 */
export function kellyFraction(winProbability: number, rewardRisk: number, fraction = 0.25): number {
  if (rewardRisk <= 0) return 0;
  const p = Math.max(0, Math.min(1, winProbability));
  const q = 1 - p;
  const full = (p * rewardRisk - q) / rewardRisk;
  return Math.max(0, full * fraction);
}
