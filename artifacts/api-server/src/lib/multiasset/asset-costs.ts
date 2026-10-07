/**
 * Multi-Asset Desk — per-asset-class execution costs.
 *
 * WHY THIS EXISTS
 *
 * A "point" is not a comparable unit across asset classes. On a 5-digit FX
 * pair one point is 0.00001 (a tenth of a pip); on BTCUSD it is commonly 0.01
 * of a dollar; on US30 it is one index point. So an absolute spread filter
 * ("reject above 8 points", "spread must be under 25% of the stop") silently
 * means something completely different on each instrument — and it rejected
 * exactly the markets with structurally wider quotes.
 *
 * The rules here are therefore *ratios*, expressed per asset class:
 *
 *   spreadFraction = spreadPoints / stopPoints     ← unit-free, one number
 *   costFraction   = roundTripCostMoney / riskMoney ← unit-free, one number
 *
 * A crypto CFD genuinely quotes wider relative to a tight ATR stop than
 * EURUSD does — that is the market, not a fault in the trade. Forex and metals
 * tolerate the least cost, indices and commodities sit in the middle, and
 * crypto/stocks get the widest allowance because their quotes are structurally
 * wider *and* their tick values are larger.
 *
 * The ceilings are ceilings, not targets: nothing here ever *prefers* a wide
 * spread. It only decides when a spread is wide *for its own asset class*, and
 * the expectancy gate (minEdgeR, net of spread + commission + slippage) remains
 * the gate that actually decides whether the trade pays.
 */

import type { AssetClass, SymbolSpec, TradeMode } from "./types";

export interface AssetCostPolicy {
  /** Ceiling on spread ÷ stop distance before execution is refused. */
  maxSpreadFractionOfStop: number;
  /** Ceiling on (spread + commission) ÷ money risked before execution is refused. */
  maxCostFractionOfRisk: number;
  /**
   * Spread the EA may still accept AT FILL, as a fraction of the stop.
   * Wider than `maxSpreadFractionOfStop`: a plan armed when the spread was
   * acceptable must not be killed by a momentary widening on a news tick, but
   * it must not be filled into a spread that has doubled either.
   */
  fillSpreadFractionOfStop: number;
  /** Multiplier on the mode's base slippage allowance. */
  slippageMultiplier: number;
}

/**
 * Defaults per asset class.
 *
 * The ordering (forex ≲ metals < futures < indices ≈ commodities < crypto ≈
 * stocks) follows how these instruments actually quote: an ECN FX spread is a
 * fraction of a pip, a crypto CFD spread is often tens of points, and a
 * single-stock CFD is worse again outside its cash session.
 */
export const ASSET_COST_POLICY: Record<AssetClass, AssetCostPolicy> = {
  forex: { maxSpreadFractionOfStop: 0.35, maxCostFractionOfRisk: 0.35, fillSpreadFractionOfStop: 0.4, slippageMultiplier: 1 },
  metals: { maxSpreadFractionOfStop: 0.4, maxCostFractionOfRisk: 0.4, fillSpreadFractionOfStop: 0.45, slippageMultiplier: 1.5 },
  indices: { maxSpreadFractionOfStop: 0.5, maxCostFractionOfRisk: 0.45, fillSpreadFractionOfStop: 0.55, slippageMultiplier: 2 },
  commodities: { maxSpreadFractionOfStop: 0.5, maxCostFractionOfRisk: 0.45, fillSpreadFractionOfStop: 0.55, slippageMultiplier: 2 },
  futures: { maxSpreadFractionOfStop: 0.45, maxCostFractionOfRisk: 0.45, fillSpreadFractionOfStop: 0.5, slippageMultiplier: 2 },
  crypto: { maxSpreadFractionOfStop: 0.6, maxCostFractionOfRisk: 0.55, fillSpreadFractionOfStop: 0.65, slippageMultiplier: 3 },
  stocks: { maxSpreadFractionOfStop: 0.6, maxCostFractionOfRisk: 0.55, fillSpreadFractionOfStop: 0.65, slippageMultiplier: 3 },
  other: { maxSpreadFractionOfStop: 0.45, maxCostFractionOfRisk: 0.4, fillSpreadFractionOfStop: 0.5, slippageMultiplier: 2 },
};

/**
 * Where a spread stops being unremarkable *within* its own class.
 *
 * Between this fraction of the class ceiling and the ceiling itself the spread
 * is allowed but worth naming — the trade is arming while paying a large share
 * of its stop to get in, and the user should see that number. It is a caution,
 * never a veto: the veto lives at the ceiling, in sizing.
 */
export const NOTABLE_SPREAD_FRACTION_OF_CEILING = 0.6;

/** Is this spread wide enough, for its class, to be worth naming? */
export function spreadIsNotable(spec: Pick<SymbolSpec, "assetClass">, spreadFraction: number): boolean {
  return spreadFraction > costPolicyFor(spec).maxSpreadFractionOfStop * NOTABLE_SPREAD_FRACTION_OF_CEILING;
}

/**
 * How far the spread may widen between arming a plan and its fill.
 *
 * Expressed against the STOP, not in absolute points — a point means something
 * different on every asset class — and floored above the spread actually
 * measured, so a normal tick on the symbol's own feed can never block the fill
 * the analysis just approved.
 */
export function fillSpreadGuard(
  spec: Pick<SymbolSpec, "assetClass">,
  stopPoints: number,
  measuredSpreadPoints: number,
): number {
  const policy = costPolicyFor(spec);
  return Math.max(
    Math.round(stopPoints * policy.fillSpreadFractionOfStop),
    Math.round(Math.max(measuredSpreadPoints, 1) * 1.25),
    1,
  );
}

/** The policy for a symbol, resolved from its broker-reported asset class. */
export function costPolicyFor(spec: Pick<SymbolSpec, "assetClass">): AssetCostPolicy {
  return ASSET_COST_POLICY[spec.assetClass] ?? ASSET_COST_POLICY.other;
}

/** Base slippage allowance in points, before the asset-class multiplier. */
export function baseSlippagePoints(mode: TradeMode): number {
  return mode === "scalp" ? 1.5 : 1;
}

/** Slippage allowance in points for a mode on a given asset class. */
export function slippageAllowancePoints(spec: Pick<SymbolSpec, "assetClass">, mode: TradeMode): number {
  const policy = costPolicyFor(spec);
  return Number((baseSlippagePoints(mode) * policy.slippageMultiplier).toFixed(2));
}
