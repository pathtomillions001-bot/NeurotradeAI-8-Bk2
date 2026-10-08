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

import type { Position, Side, SymbolSpec } from "./types";

export interface SizingLimits {
  /** Minimum margin level (%) that must remain AFTER the trade is opened. */
  minMarginLevelPct: number;
  /** Hard ceiling on risk per trade as a percentage of equity. */
  maxRiskPct: number;
  /** Minimum acceptable reward:risk after any SL widening. */
  minRewardRisk: number;
}

/**
 * Fallback limits for a caller that supplies none.
 *
 * THERE ARE NO COST CEILINGS HERE ANY MORE.
 *
 * `maxSpreadFractionOfStop` and `maxCostFractionOfRisk` used to live in this
 * interface and refused trades on a ratio. They are gone: the spread is charged
 * inside the agent's expectancy (which is the gate), and the risk unit itself
 * can no longer be smaller than the round-trip cost (`MIN_COST_COVERAGE` in
 * agent.ts). Keeping a third, ratio-shaped veto here only ever produced
 * "Spread 8 pts is 83% of the 10-pt stop" refusals for setups the desk had
 * already approved on the numbers that matter. Sizing converts a risk budget
 * into a legal lot size — that is the whole job.
 */
export const DEFAULT_SIZING_LIMITS: SizingLimits = {
  minMarginLevelPct: 500,
  maxRiskPct: 2,
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
  /** The adaptive risk target, in percent of equity. Never above the ceiling. */
  riskPct: number;
  /**
   * The per-trade risk ceiling this target works inside, in percent of equity.
   *
   * THE MINIMUM LOT IS JUDGED AGAINST THIS, NOT AGAINST `riskPct`.
   *
   * A broker's smallest position is indivisible, and on a small account it can
   * cost more than the (possibly edge-shrunk) adaptive target. Refusing there
   * means refusing a trade the desk's own budget can easily afford — which is
   * how "Minimum 0.01 lots would risk 1.29 units (0.17% of equity), above the
   * 0.15% budget" appeared on a $760 account. When the smallest legal lot fits
   * inside the CEILING, it is taken (and the fact is reported); when it does
   * not fit even there, the trade is refused and the budget is named.
   *
   * Defaults to `limits.maxRiskPct`.
   */
  riskCeilingPct?: number;
  leverage: number;
  limits?: Partial<SizingLimits>;
}

export type SizingRejection =
  | "invalid_input"
  | "stop_too_tight"
  | "below_min_lot"
  | "insufficient_margin"
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
  /** True when the broker's minimum lot was taken inside the risk budget. */
  minLotApplied: boolean;
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
    minLotApplied: false,
    rejection,
    explanation,
  };
}

export function sizePosition(request: SizingRequest): SizingResult {
  const { spec, side, entry, equity, freeMargin, usedMargin, leverage } = request;
  const limits: SizingLimits = { ...DEFAULT_SIZING_LIMITS, ...(request.limits ?? {}) };

  if (!(entry > 0) || !(equity > 0) || !(spec.point > 0)) {
    return reject("invalid_input", "Entry price, equity and symbol point must all be positive.");
  }

  const riskPct = Math.min(Math.max(request.riskPct, 0), limits.maxRiskPct);
  if (riskPct <= 0) {
    return reject("invalid_input", "Risk percentage must be greater than zero.");
  }
  // The ceiling the adaptive target lives inside. Never above the broker-level
  // hard cap, never below the target itself.
  const riskCeilingPct = Math.min(
    Math.max(request.riskCeilingPct ?? limits.maxRiskPct, riskPct),
    limits.maxRiskPct,
  );

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

  // ── Base size ──────────────────────────────────────────────────────────────
  const riskBudget = equity * (riskPct / 100);
  const riskPerLot = riskPoints * pointValue;
  let lots = quantiseVolume(spec, riskBudget / riskPerLot);

  /**
   * ── The minimum lot, judged against the BUDGET ────────────────────────────
   *
   * The adaptive target can be smaller than the broker's smallest trade. The
   * old code treated that as a refusal, which is the one place rounding up is
   * *not* a silent over-risk: the ceiling is a number the account can afford by
   * construction, and the alternative is never taking the trade at all. Above
   * the ceiling it still refuses — that is the case the guard was written for.
   */
  let minLotApplied = false;
  if (lots < spec.volumeMin) {
    const minRisk = spec.volumeMin * riskPerLot;
    const minRiskPct = (minRisk / equity) * 100;
    if (minRiskPct <= riskCeilingPct + 1e-9) {
      lots = spec.volumeMin;
      minLotApplied = true;
    } else {
      return reject(
        "below_min_lot",
        `Minimum ${spec.volumeMin} lots would risk ${minRisk.toFixed(2)} units (${minRiskPct.toFixed(2)}% of equity), ` +
          `above the ${riskCeilingPct.toFixed(2)}% per-trade risk budget of ${(equity * (riskCeilingPct / 100)).toFixed(2)}. ` +
          `The adaptive target was ${riskPct.toFixed(2)}% (${riskBudget.toFixed(2)}).`,
        { pointValue, sl, slAdjusted, riskPoints },
      );
    }
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
  // Cost is REPORTED, never refused. Whether the edge can pay it is decided
  // once, on the expectancy, before sizing is ever reached.
  const costMoney = costForLots(spec, lots);
  const riskMoney = lots * riskPerLot;

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
    minLotApplied,
    rejection: null,
    explanation:
      `${lots} lots — ${riskPoints.toFixed(0)} pts × ${pointValue.toFixed(2)}/pt/lot = ` +
      `${riskMoney.toFixed(2)} at risk (${((riskMoney / equity) * 100).toFixed(2)}% of ${equity.toFixed(2)})` +
      (minLotApplied
        ? `; broker minimum lot taken because the adaptive ${riskPct.toFixed(2)}% target could not buy less — inside the ${riskCeilingPct.toFixed(2)}% budget`
        : "") +
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
