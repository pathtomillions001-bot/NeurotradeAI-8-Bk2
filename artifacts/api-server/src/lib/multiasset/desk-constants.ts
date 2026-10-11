/**
 * The desk's shared constants — the numbers that more than one layer has to
 * agree on.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────
 *
 * These four constants used to live in `agent.ts`, and the layers that needed
 * them imported them from there. That worked until the live path needed the
 * alpha agents: `agent.ts` → `meta/view.ts` → `alpha/edge.ts` → `agent.ts` is a
 * cycle, and `alpha/edge.ts` reads `STOP_ATR_MULT` while the module graph is
 * still being built — so the constant was in its temporal dead zone and the
 * import threw before a single decision was made. In a test runner that looks
 * like a broken test; in production it would have been an outage.
 *
 * The fix is not to make the leaf lazy — it is to give the values a home that
 * depends on nothing. `agent.ts` re-exports every one of them, so no caller has
 * to change, and the numbers still have exactly one definition.
 *
 * ── WHAT BELONGS HERE ───────────────────────────────────────────────────
 *
 * A number that two layers must agree on, and that a leaf module has to read at
 * import time. Nothing else: policy that lives in one layer stays in that layer,
 * and anything that needs a decision belongs in the module that makes it.
 */
import type { Timeframe, TradeMode } from "./types";

/**
 * Entry timeframe used for stop placement and horizons, per style.
 *
 * These sit inside each mode's analysis band by construction:
 *   scalp → M2 (inside S10–M3; the 2-minute frame is where a scalp stop has
 *            enough range to survive a spread but is still a scalp's stop)
 *   intraday → M15 (the middle of M5–M30)
 *   swing → H1 (the fast end of H1–W1, where a swing stop belongs)
 */
export const ENTRY_TIMEFRAME: Record<TradeMode, Timeframe> = {
  scalp: "M2",
  intraday: "M15",
  swing: "H1",
};

/**
 * ATR multiple for the initial structural stop, per style.
 *
 * A scalp's stop must be reachable in minutes or the trade is not a scalp, so
 * it is the tightest; a swing stop has to survive a full session of noise.
 */
export const STOP_ATR_MULT: Record<TradeMode, number> = {
  scalp: 0.8,
  intraday: 1.5,
  swing: 2.0,
};

/**
 * The stop may never be smaller than this many times the round-trip cost.
 *
 * THIS IS THE FIX FOR "the expectancy is always below 0.15R".
 *
 * Every gate in the desk is measured in R — the distance to the stop. If R is
 * about the same size as the spread, then "one R" of edge can never cover "one
 * R" of cost, and the expectancy is structurally negative no matter how good
 * the setup is. That is exactly what a 0.8 × ATR stop on a one-minute FX frame
 * produces on a broker quoting a 0.8-pip spread: an 8-point spread against a
 * 10-point stop is 0.8R of cost before the trade has any edge at all.
 *
 * Four is a deliberate number: it caps the round-trip cost at 25% of the money
 * risked, which still leaves room for a 0.15R+ net edge on a genuine setup.
 * The spread is *not* filtered out anywhere — it is priced here, inside the
 * risk the trade is taking.
 */
export const MIN_COST_COVERAGE = 4;

/**
 * MINIMUM REWARD:RISK, MEASURED AT THE EXPECTED FILL — the owner's hard rule.
 *
 * The old desk computed reward:risk from the QUOTE, then handed the EA a
 * trigger placed 0.08–0.12 ATR BEYOND that quote. Every fill was therefore
 * worse than the geometry the decision was made on: with a 0.10 ATR offset on
 * a 1.5 ATR stop, a plan sold as "1:2" was really 1:1.87, and on a scalp
 * (0.08 ATR against a minimum 0.8 ATR stop) it was 1:1.82. Small differences,
 * but the whole edge lives in that ratio.
 *
 * The fill is modelled as the trigger plus the mode's slippage allowance —
 * worst case, since the plan only fires when price is already moving — and the
 * ratio is recomputed from THAT price. Anything under 2.0 is refused with the
 * number in the reason, so the terminal can show exactly what was rejected and
 * why.
 */
export const MIN_RR_FILL = 2.0;
