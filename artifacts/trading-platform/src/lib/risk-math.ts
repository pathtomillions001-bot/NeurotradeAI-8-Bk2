// ── Risk Calculator Math ──────────────────────────────────────────────────────
// Pure functions — no React, no side effects.
// Sources: canonical payout schedule + EV formulas.

import { getFallbackPayout, type PayoutContractType } from "./payouts";

export { OVER_PAYOUTS, UNDER_PAYOUTS } from "./payouts";

export type ContractType = Exclude<PayoutContractType, "RISE" | "FALL">;

export function getPayout(type: ContractType, barrier?: number): number {
  return getFallbackPayout(type, barrier);
}

// Theoretical win probability assuming uniform digit distribution [0–9]
export function getWinProb(type: ContractType, barrier?: number): number {
  switch (type) {
    case "CALL": case "PUT":            return 0.50;
    case "DIGITEVEN": case "DIGITODD":  return 0.50;
    case "DIGITMATCH":                  return 0.10;
    case "DIGITDIFF":                   return 0.90;
    case "DIGITOVER":  return (9 - (barrier ?? 5)) / 10;   // P(digit > barrier)
    case "DIGITUNDER": return (barrier ?? 4) / 10;          // P(digit < barrier)
    default:                            return 0.50;
  }
}

// ── Instant Recovery Ladder ───────────────────────────────────────────────────
// Each recovery stake = (totalDebt + optional original target profit)
//                       / (recoveryPayout - 1).
// Target profit is a sizing input only — recovery completes when debt is cleared.
// Payout includes the returned stake, so payout - 1 is the usable profit rate.
export function buildInstantLadder(
  base: number,
  recoveryPayout: number,
  maxLosses: number,
  normalPayout = 1,
): number[] {
  const edge = recoveryPayout - 1;
  if (edge <= 0) return Array(maxLosses).fill(base);
  const targetProfit = base * Math.max(0, normalPayout - 1);
  const ladder: number[] = [base];
  for (let i = 1; i < maxLosses; i++) {
    const debt = ladder.reduce((a, b) => a + b, 0);
    const exact = (debt + targetProfit) / edge;
    ladder.push(Math.max(Math.ceil((exact - 1e-9) * 100) / 100, 0.35));
  }
  return ladder;
}

// ── Split Recovery Ladder ─────────────────────────────────────────────────────
// Progressive cap: step N = base × (multiplier + N - 1)
export function buildSplitLadder(
  base: number,
  multiplier: number,
  maxLosses: number,
): number[] {
  return Array.from({ length: maxLosses }, (_, i) =>
    parseFloat((base * (multiplier + i)).toFixed(2)),
  );
}

// ── Streak Probability (exact DP) ─────────────────────────────────────────────
// P(at least one run of `streak` consecutive losses in `trades` Bernoulli trials)
// Time: O(trades × streak) — safe for trades ≤ 200, streak ≤ 15
export function streakProb(winP: number, streak: number, trades: number): number {
  if (streak <= 0 || trades <= 0) return 0;
  if (winP >= 1) return 0;
  if (winP <= 0) return 1;

  const lossP = 1 - winP;
  // dp[k] = prob of being at k consecutive losses WITHOUT having hit `streak`
  let dp = new Float64Array(streak);
  dp[0] = 1; // start

  for (let t = 0; t < trades; t++) {
    const next = new Float64Array(streak);
    for (let k = 0; k < streak; k++) {
      if (dp[k] === 0) continue;
      // win → reset to 0 consecutive losses
      next[0] += dp[k] * winP;
      // lose → increment streak counter (if still < streak)
      if (k + 1 < streak) next[k + 1] += dp[k] * lossP;
      // else → bad streak occurred; probability escapes the DP (not added back)
    }
    dp = next;
  }

  const pNoStreak = dp.reduce((a, b) => a + b, 0);
  return Math.min(1, Math.max(0, 1 - pNoStreak));
}

// ── Suggested Stake ───────────────────────────────────────────────────────────
// Three constraints are computed independently and the tightest wins:
//
// 1. SL constraint   — full recovery ladder × 1.1 uses ≤ 60 % of the SL budget.
//    Using 60 % (not 100 %) leaves room for multiple failed recovery attempts
//    and back-to-back bad sessions.
//
// 2. TP constraint   — stake is large enough to reach the daily TP target in a
//    realistic session of (max(30, maxLosses × 4)) trades.
//
// 3. Balance cap     — max 1 % of balance per base trade.  Industry-standard
//    conservative ceiling for binary / digit contracts.
//
// All three are combined with Math.min; floor is Deriv's $0.35 minimum.

// Internal: binary-search for the largest base stake whose ladder sums to ≤ targetCost.
function maxStakeForLadderCost(
  targetCost: number,
  recoveryMethod: "instant" | "split",
  recoveryPayout: number,
  recoveryMultiplier: number,
  maxLosses: number,
  primaryPayout: number,
): number {
  let lo = 0.35, hi = Math.max(targetCost * 2, 1);
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const ladder =
      recoveryMethod === "instant"
        ? buildInstantLadder(mid, recoveryPayout, maxLosses, primaryPayout)
        : buildSplitLadder(mid, recoveryMultiplier, maxLosses);
    const cost = ladder.reduce((a, b) => a + b, 0);
    if (cost <= targetCost) lo = mid;
    else hi = mid;
  }
  return Math.max(0.35, lo);
}

export function calcSuggestedStake(
  balance: number,
  targetSLFraction: number,       // e.g. 0.30
  recoveryMethod: "instant" | "split",
  recoveryPayout: number,
  recoveryMultiplier: number,
  maxLosses: number,
  primaryPayout: number,          // e.g. 1.09 for DIGITDIFF
  primaryWinProb: number,         // e.g. 0.90 for DIGITDIFF
  targetTPFraction: number,       // e.g. 0.10
): number {
  if (balance <= 0) return 0.35;

  // ── Constraint 1: SL-based maximum ────────────────────────────────────────
  // Use 60 % of SL budget so there is headroom for multiple recovery failures.
  const slCostTarget = (targetSLFraction * balance * 0.6) / 1.1;
  const maxFromSL = maxStakeForLadderCost(
    slCostTarget, recoveryMethod, recoveryPayout, recoveryMultiplier, maxLosses, primaryPayout,
  );

  // ── Constraint 2: TP-driven stake ─────────────────────────────────────────
  // How large does the stake need to be to reach the TP in a practical session?
  // Session = max(30, maxLosses × 4) trades; expected wins at primaryWinProb.
  const sessionTrades  = Math.max(30, maxLosses * 4);
  const expectedWins   = sessionTrades * primaryWinProb;
  const profitPerUnit  = Math.max(primaryPayout - 1, 0.001); // avoid ÷0
  const stakeFromTP    = (balance * targetTPFraction) / (expectedWins * profitPerUnit);

  // ── Constraint 3: Balance cap (1 % per trade) ──────────────────────────────
  const maxFromBalance = balance * 0.01;

  const result = Math.min(maxFromSL, stakeFromTP, maxFromBalance);
  return Math.max(0.35, parseFloat(result.toFixed(2)));
}

// ── Main Calculation ──────────────────────────────────────────────────────────
export interface RiskResult {
  ladder: number[];
  totalLadderCost: number;
  recommendedSL: number;
  recommendedTP: number;
  riskScore: number;            // 0-100; higher = safer
  riskLabel: "SAFE" | "MODERATE" | "RISKY" | "EXTREME";
  riskColor: string;
  streakProbSession: number;    // P(bad streak in tradesPerSession)
  streakProb50: number;         // P(bad streak in 50 trades)
  balanceCoverage: number;      // how many full ladders balance can fund
  evPerTrade: number;
  breakevenWinRate: number;
  netAfterRecovery: number;     // P&L after one complete win-recovery cycle
  warnings: string[];
}

export function calcRisk(p: {
  baseStake: number;
  balance: number;
  primaryPayout: number;
  primaryWinProb: number;
  recoveryPayout: number;
  maxLosses: number;
  recoveryMethod: "instant" | "split";
  recoveryMultiplier: number;
  tradesPerSession: number;
}): RiskResult {
  const {
    baseStake, balance,
    primaryPayout, primaryWinProb,
    recoveryPayout, maxLosses,
    recoveryMethod, recoveryMultiplier,
    tradesPerSession,
  } = p;

  const ladder =
    recoveryMethod === "instant"
      ? buildInstantLadder(baseStake, recoveryPayout, maxLosses, primaryPayout)
      : buildSplitLadder(baseStake, recoveryMultiplier, maxLosses);

  const totalLadderCost = ladder.reduce((a, b) => a + b, 0);

  // ─ SL: cost of one full losing streak + 10 % buffer ─
  const recommendedSL = parseFloat((totalLadderCost * 1.1).toFixed(2));

  // ─ TP: enough base-stake wins to feel meaningful ─
  // After surviving maxLosses consecutive losses (worst case), user needs
  // maxLosses × 2 consecutive base wins to feel the day was worthwhile.
  const profitPerBaseWin = baseStake * (primaryPayout - 1);
  const recommendedTP = parseFloat((profitPerBaseWin * maxLosses * 2).toFixed(2));

  // ─ Streak probabilities ─
  const streakProbSession = streakProb(primaryWinProb, maxLosses, tradesPerSession);
  const sp50             = streakProb(primaryWinProb, maxLosses, 50);

  // ─ Balance coverage ─
  const balanceCoverage = totalLadderCost > 0 ? balance / totalLadderCost : Infinity;

  // ─ EV & breakeven ─
  const evPerTrade     = primaryWinProb * (primaryPayout - 1) - (1 - primaryWinProb);
  const breakevenWinRate = 1 / primaryPayout;

  // ─ Net profit after one complete recovery cycle ─
  // Instant preserves the expected net profit of the original normal trade.
  // Split remains a manual multiplier model in this standalone risk calculator.
  const netAfterRecovery =
    recoveryMethod === "instant"
      ? baseStake * Math.max(0, primaryPayout - 1)
      : baseStake * (recoveryMultiplier - 1);

  // ─ Risk Score (0–100) ─
  // Three weighted components:
  // 1. Balance coverage   (0–40 pts): 5+ ladders = full marks, <1 = 0
  // 2. Streak avoidance   (0–40 pts): 0% probability = full marks
  // 3. Ladder/balance     (0–20 pts): ladder < 10% of balance = full marks
  const coverageScore = Math.min(40, (Math.min(balanceCoverage, 5) / 5) * 40);
  const streakScore   = Math.max(0, (1 - streakProbSession) * 40);
  const ratioScore    = Math.max(0, 20 - (totalLadderCost / balance) * 40);
  const riskScore     = Math.round(Math.min(100, coverageScore + streakScore + ratioScore));

  let riskLabel: RiskResult["riskLabel"];
  let riskColor: string;
  if (riskScore >= 70)      { riskLabel = "SAFE";     riskColor = "#10b981"; }
  else if (riskScore >= 45) { riskLabel = "MODERATE"; riskColor = "#f59e0b"; }
  else if (riskScore >= 25) { riskLabel = "RISKY";    riskColor = "#f97316"; }
  else                      { riskLabel = "EXTREME";  riskColor = "#ef4444"; }

  // ─ Warnings ─
  const warnings: string[] = [];
  if (balanceCoverage < 2)
    warnings.push("Balance covers fewer than 2 full recovery cycles — one bad run could wipe you out.");
  if (streakProbSession > 0.5)
    warnings.push(`${(streakProbSession * 100).toFixed(0)}% chance of hitting your loss limit in a single session.`);
  if (totalLadderCost > balance * 0.4)
    warnings.push("One full recovery cycle would consume over 40% of your balance.");
  if (ladder[ladder.length - 1] > baseStake * 30)
    warnings.push("Your final recovery stake is 30× your base — consider reducing max losses.");
  if (evPerTrade < -0.15)
    warnings.push("High house edge on this contract — long-term profitability requires strict discipline.");

  return {
    ladder, totalLadderCost,
    recommendedSL, recommendedTP,
    riskScore, riskLabel, riskColor,
    streakProbSession, streakProb50: sp50,
    balanceCoverage, evPerTrade, breakevenWinRate, netAfterRecovery,
    warnings,
  };
}
