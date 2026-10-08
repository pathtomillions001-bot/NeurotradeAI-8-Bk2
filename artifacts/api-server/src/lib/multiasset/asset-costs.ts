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
 * WHAT THIS MODULE IS *NOT* ANYMORE
 *
 * It used to be a VETO: `spread / stop > ceiling` refused the trade outright,
 * and `(spread + commission) / risk > ceiling` refused it again. Both were
 * spread gates in disguise, both fired on perfectly tradeable A+ setups, and
 * both were redundant: the spread is *charged* in the Monte-Carlo cost term, so
 * the expectancy gate (minEdgeR) already measures the trade net of it. A setup
 * whose edge cannot pay the spread fails that one gate; a setup whose edge can
 * pay it must not be blocked by a second, arbitrary ratio.
 *
 * So the vetoes are gone. What remains is what an execution desk actually
 * needs:
 *
 *   • `fillSpreadFractionOfStop` — how far the spread may WIDEN between arming
 *     a plan and filling it (a fill-time sanity check, not an edge judgement);
 *   • `slippageMultiplier` — the asset-class slippage allowance that goes into
 *     the cost term.
 *
 * The edge decision lives in ONE place: `expectancyR`, net of spread +
 * commission + slippage, gated once at `minEdgeR`.
 */

import type { AssetClass, SymbolSpec, TradeMode } from "./types";

export interface AssetCostPolicy {
  /**
   * Spread the EA may still accept AT FILL, as a fraction of the stop.
   * A plan armed when the spread was acceptable must not be killed by a
   * momentary widening on a news tick, but it must not be filled into a spread
   * that has run away either. This is a fill guard: it never refuses an
   * analysis, it refuses a *fill* into a market that has changed character.
   */
  fillSpreadFractionOfStop: number;
  /** Multiplier on the mode's base slippage allowance. */
  slippageMultiplier: number;
}

/**
 * Defaults per asset class.
 *
 * The ordering of the slippage multipliers (forex < metals < futures <
 * indices ≈ commodities < crypto ≈ stocks) follows how these instruments
 * actually quote: an ECN FX spread is a fraction of a pip, a crypto CFD spread
 * is often tens of points, and a single-stock CFD is worse again outside its
 * cash session.
 */
export const ASSET_COST_POLICY: Record<AssetClass, AssetCostPolicy> = {
  forex: { fillSpreadFractionOfStop: 0.4, slippageMultiplier: 1 },
  metals: { fillSpreadFractionOfStop: 0.45, slippageMultiplier: 1.5 },
  indices: { fillSpreadFractionOfStop: 0.55, slippageMultiplier: 2 },
  commodities: { fillSpreadFractionOfStop: 0.55, slippageMultiplier: 2 },
  futures: { fillSpreadFractionOfStop: 0.5, slippageMultiplier: 2 },
  crypto: { fillSpreadFractionOfStop: 0.65, slippageMultiplier: 3 },
  stocks: { fillSpreadFractionOfStop: 0.65, slippageMultiplier: 3 },
  other: { fillSpreadFractionOfStop: 0.5, slippageMultiplier: 2 },
};

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
