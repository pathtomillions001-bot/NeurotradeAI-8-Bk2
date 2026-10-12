/**
 * Autonomous engine — recovery drawdown headroom (WP4, pure).
 *
 * D3: the legacy stake was sized to the debt alone; the risk-manager hard
 * stops (daily loss limit, max drawdown) were only checked BETWEEN trades, so a
 * single recovery stake could exceed the entire remaining drawdown budget.
 * The headroom cap folds the same budget INTO the stake:
 *
 *   peakBalance        = balance − min(0, dailyProfit)     (risk-manager's peak)
 *   drawdownUsed       = peakBalance − balance
 *   drawdownLimit      = maxDrawdown% · peakBalance
 *   drawdownHeadroom   = max(0, drawdownLimit − drawdownUsed)
 *   headroomCap        = min(φ · max(0, balance − reserve), drawdownHeadroom)
 *
 * φ defaults to 5 %: a single recovery stake may consume at most 5 % of the
 * free balance — and NEVER more than the remaining drawdown budget, whichever
 * is smaller (D3: the stake folds the same budget in that the hard stops
 * enforce between trades). As drawdown approaches the limit the cap tends to
 * 0 and the adaptive ladder re-bases (realises the debt) instead of breaching
 * it — the hard stops remain authoritative and are reached later, not bypassed.
 */

export interface HeadroomInput {
  balance: number;
  /** Today's resolved P&L (Deriv journal first, local DB fallback). */
  dailyProfit: number;
  /** settings.maxDrawdown, in percent. */
  maxDrawdownPct: number;
  /** φ: fraction of headroom one stake may consume (percent, default 5). */
  headroomPct: number;
  /** Cash kept aside from recovery sizing (default 0). */
  reserve?: number;
}

export interface HeadroomResult {
  peakBalance: number;
  drawdownUsed: number;
  drawdownLimit: number;
  drawdownHeadroom: number;
  headroomCap: number;
}

export function computeRecoveryHeadroom(input: HeadroomInput): HeadroomResult {
  const balance = Number.isFinite(input.balance) ? Math.max(0, input.balance) : 0;
  const dailyProfit = Number.isFinite(input.dailyProfit) ? input.dailyProfit : 0;
  const maxDrawdownPct = Number.isFinite(input.maxDrawdownPct) ? Math.max(0, input.maxDrawdownPct) : 10;
  const headroomPct = Number.isFinite(input.headroomPct) ? Math.max(0, input.headroomPct) : 5;
  const reserve = Number.isFinite(input.reserve) ? Math.max(0, input.reserve!) : 0;

  const peakBalance = balance - Math.min(0, dailyProfit);
  const drawdownUsed = Math.max(0, peakBalance - balance);
  const drawdownLimit = peakBalance * (maxDrawdownPct / 100);
  const drawdownHeadroom = Math.max(0, drawdownLimit - drawdownUsed);
  // φ scales the free-balance side; the remaining drawdown budget is the hard
  // ceiling. (The naive φ·min(balance, headroom) collapses to ≈ base stake and
  // re-bases on the first loss — validated against the WP4 acceptance gates.)
  const headroomCap = Math.min((headroomPct / 100) * Math.max(0, balance - reserve), drawdownHeadroom);

  return { peakBalance, drawdownUsed, drawdownLimit, drawdownHeadroom, headroomCap };
}
