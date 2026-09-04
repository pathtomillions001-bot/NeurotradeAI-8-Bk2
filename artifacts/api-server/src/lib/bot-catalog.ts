/**
 * Specialist AI Bot catalogue.
 *
 * Each bot trades exactly ONE contract family. That single constraint is what
 * funds its advantage: the analysis budget the NeuroAI Quantum FAB has to split
 * across six families is spent entirely on the estimators this one family can
 * use (see `lib/specialist-analysis.ts`).
 */

import type { SpecialistFamily } from "./specialist-analysis";

export type BotSideMode = "both" | "primary" | "secondary";

export interface BotSideOption {
  id: BotSideMode;
  label: string;
  /** Contract types this option arms. */
  contracts: string[];
  desc: string;
}

export interface BotDefinition {
  id: string;
  name: string;
  code: string;
  family: SpecialistFamily | "duallock";
  /** Human name of the contract family this bot is hard-wired to. */
  contractLabel: string;
  tagline: string;
  description: string;
  /** What the specialisation buys — shown on the card and in the console. */
  edge: string[];
  /** Accent used by the UI (theme-safe tailwind colour names). */
  accent: "cyan" | "violet" | "amber" | "emerald" | "rose" | "indigo";
  /**
   * Bots whose entire analysis happens ONCE, before deployment, and whose
   * contract pair is then frozen for the whole session (see the Dual-Lock
   * Range Sentinel). The UI renders a different console for these.
   */
  preLocked?: boolean;
  icon: string;
  /** Whether the user picks a side (over/under, rise/fall, even/odd). */
  hasSides: boolean;
  primaryLabel?: string;
  secondaryLabel?: string;
  /** Whether the user can lock the traded digit (match / differ). */
  hasDigitLock: boolean;
  digitLockHelp?: string;
  sides: BotSideOption[];
  /** Nominal win rate / payout, for the card's stat strip. */
  nominalWinRate: string;
  nominalPayout: string;
}

export const BOT_CATALOG: BotDefinition[] = [
  {
    id: "parity",
    name: "Parity Sentinel",
    code: "BOT-EVENODD",
    family: "parity",
    contractLabel: "Even / Odd",
    tagline: "Digit parity specialist",
    description:
      "Trades only Even and Odd. Reads parity as its own two-state process instead of summing five cells of a ten-state digit matrix, so every conditional probability carries roughly five times the evidence — and a Wald–Wolfowitz runs test tells it whether the stream clusters or alternates, which decides WHICH side to take.",
    edge: [
      "2-state parity Markov + 2nd-order parity chain (≈5× effective samples per state vs the 10-state digit matrix)",
      "Wald–Wolfowitz runs test — clustering ⇒ ride the open run, alternation ⇒ fade it",
      "Lag-2 / lag-3 cycle detection catches period-2 flip cycles a single lag reads as noise",
      "Marginal parity-bias test with a binomial confidence interval",
      "Break-even gate — trades only when p̂ clears 51.28% by 0.75σ, and the estimate self-calibrates on the bot's own track record",
    ],
    accent: "cyan",
    icon: "scale",
    hasSides: true,
    primaryLabel: "Even",
    secondaryLabel: "Odd",
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Even & Odd", contracts: ["DIGITEVEN", "DIGITODD"], desc: "Analyse both, execute the favoured side" },
      { id: "primary", label: "Even only", contracts: ["DIGITEVEN"], desc: "Only even digits are analysed and traded" },
      { id: "secondary", label: "Odd only", contracts: ["DIGITODD"], desc: "Only odd digits are analysed and traded" },
    ],
    nominalWinRate: "≈50%",
    nominalPayout: "1.95×",
  },
  {
    id: "differ",
    name: "Differ Guardian",
    code: "BOT-DIFF",
    family: "differ",
    contractLabel: "Differs",
    tagline: "Cold-digit avoidance specialist",
    description:
      "Trades only Differs. At a 1.09× payout the break-even win rate is 91.7%, so the only question that matters is the loss side: this bot ranks digits by the UPPER confidence bound of their appearance rate and refuses any digit whose worst plausible rate still breaks even. Hot runs are vetoed outright.",
    edge: [
      "Upper-confidence-bound tail risk — the trade must survive its own worst plausible outcome",
      "Benjamini–Hochberg FDR correction across all ten candidate digits (argmax-of-ten is biased)",
      "Hot-run veto: a digit repeating 3+ times in 6 ticks is never traded against",
      "Dormancy support from the digit's own gap history, not a fixed gap table",
      "Context-aware digit selection — P(digit | last) and P(digit | last 2) from the live transition structure, fused in inverse variance",
    ],
    accent: "emerald",
    icon: "shield",
    hasSides: false,
    hasDigitLock: true,
    digitLockHelp: "Auto picks the digit with the lowest worst-case appearance rate. Lock it to force one digit.",
    sides: [
      { id: "both", label: "Differs", contracts: ["DIGITDIFF"], desc: "The bot selects the safest digit" },
    ],
    nominalWinRate: "≈96%",
    nominalPayout: "1.09×",
  },
  {
    id: "match",
    name: "Match Sniper",
    code: "BOT-MATCH",
    family: "match",
    contractLabel: "Matches",
    tagline: "Hot-digit recovery specialist",
    description:
      "Trades only Matches. An 8.93× payout needs just an 11.2% win rate, so this bot hunts the single digit whose dormancy has reached its own historical breaking point — and it only believes a digit that survives a false-discovery-rate correction across all ten candidates.",
    edge: [
      "Dormancy hazard fitted from the chosen digit's OWN gap history (censored, Kaplan–Meier style)",
      "Benjamini–Hochberg FDR gate — no digit is traded on an inflated argmax estimate",
      "Gap-shape timing: the 4–12 tick dormancy band is the entry, sub-3-tick is refused",
      "Break-even gate: the chosen digit's p̂ must clear 11.2% by 1.5σ — the extra margin absorbs the argmax-of-ten selection bias",
      "Context-aware digit selection — P(digit | last) and P(digit | last 2) from the live transition structure, fused in inverse variance",
    ],
    accent: "amber",
    icon: "crosshair",
    hasSides: false,
    hasDigitLock: true,
    digitLockHelp: "Auto picks the most statistically significant hot digit. Lock it to force one digit.",
    sides: [
      { id: "both", label: "Matches", contracts: ["DIGITMATCH"], desc: "The bot selects the hottest significant digit" },
    ],
    nominalWinRate: "≈11%",
    nominalPayout: "8.93×",
  },
  {
    id: "barrier",
    name: "Barrier Architect",
    code: "BOT-OVERUNDER",
    family: "barrier",
    contractLabel: "Over / Under",
    tagline: "Digit barrier specialist",
    description:
      "Trades only Over and Under. It analyses the tail-membership series rather than raw digits, so the conditional estimate is far better conditioned, and it measures two things a generalist never does: how concentrated the winning mass is (edge fragility) and how much mass sits immediately on the losing side of the barrier (near-miss pressure).",
    edge: [
      "2-state tail-membership chain + 2nd-order tail chain conditioned on the last two outcomes",
      "Digit-mass drift against the barrier — is the distribution migrating toward the tail?",
      "Edge-fragility scoring: a tail edge carried by one digit is penalised",
      "Barrier-adjacency pressure detects near-miss instability before it costs a trade",
      "Two-sided arbitration with hysteresis when both Over and Under are armed",
      "Break-even gate — the tail's p̂ must clear the barrier's own 1/payout hurdle, with the margin growing as the tail shrinks (a 1-digit tail must clear 1.25σ)",
      "No falling knives — a losing streak that is not yet at this market's own breaking point is refused",
    ],
    accent: "violet",
    icon: "hash",
    hasSides: true,
    primaryLabel: "Over",
    secondaryLabel: "Under",
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Over & Under", contracts: ["DIGITOVER", "DIGITUNDER"], desc: "Analyse both, execute the favoured side" },
      { id: "primary", label: "Over only", contracts: ["DIGITOVER"], desc: "Only the over digit is analysed and traded" },
      { id: "secondary", label: "Under only", contracts: ["DIGITUNDER"], desc: "Only the under digit is analysed and traded" },
    ],
    nominalWinRate: "10–90%",
    nominalPayout: "1.09–8.93×",
  },
  {
    id: "momentum",
    name: "Vector Momentum",
    code: "BOT-RISEFALL",
    family: "momentum",
    contractLabel: "Rise / Fall",
    tagline: "Price-direction specialist",
    description:
      "Trades only Rise and Fall. A single lag-1 autocorrelation cannot tell a trend from a two-cycle, so this bot estimates the Hurst exponent by rescaled-range analysis and reads a lag-1..3 autocorrelation vector — then refuses to trade at all when realised volatility says the tape is dead chop.",
    edge: [
      "Hurst exponent (R/S analysis) — trending vs mean-reverting vs random walk",
      "Lag-1..3 autocorrelation vector exposes 2-cycles (ρ₁<0, ρ₂>0) invisible to one lag",
      "Tick-magnitude asymmetry: drift bias measured in price units, not tick counts",
      "Realised-volatility floor that explicitly refuses dead-chop regimes",
      "Break-even gate — direction p̂ must clear 52.08% by 0.75σ, with flat ticks counted as losses for BOTH sides",
    ],
    accent: "rose",
    icon: "trend",
    hasSides: true,
    primaryLabel: "Rise",
    secondaryLabel: "Fall",
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Rise & Fall", contracts: ["CALL", "PUT"], desc: "Analyse both, execute the favoured side" },
      { id: "primary", label: "Rise only", contracts: ["CALL"], desc: "Only rise is analysed and traded" },
      { id: "secondary", label: "Fall only", contracts: ["PUT"], desc: "Only fall is analysed and traded" },
    ],
    nominalWinRate: "≈50%",
    nominalPayout: "1.92×",
  },
  {
    id: "duallock",
    name: "Dual-Lock Range Sentinel",
    code: "BOT-DUALLOCK",
    family: "duallock",
    contractLabel: "Over / Under (dual-locked)",
    tagline: "Pre-locked pair · non-stop session",
    description:
      "The only bot that does ALL of its thinking before it starts. It searches every market for one triple — market, normal contract (Over 1 / Under 8 / Over 2 / Under 7) and recovery contract (Over 4 / Over 5 / Under 5 / Under 4) — that can survive an uninterrupted session, then freezes it. From the first trade to TP or SL there is no re-analysis, no market switching and no contract change: the pair was chosen precisely because it does not need any.",
    edge: [
      "Loss-clustering Markov chain — ξ = P(loss|loss)/P(loss); a market where losses attract losses is refused outright, because consecutive losses (not a low win rate) is what kills a non-stop session",
      "Conditional recovery estimand — the recovery leg is scored on P(win | last digit lost the normal contract) from Dirichlet-smoothed transition rows, not on its unconditional rate: recovery only ever trades from the post-loss state",
      "5th-percentile Beta posterior bounds on an autocorrelation-corrected effective sample size n_eff = n(1−ρ₁)/(1+ρ₁) — a locked session must be +EV in its WORST plausible case, not its expected one",
      "Pearson χ² block-homogeneity (Wilson–Hilferty z) rejects drifting markets — drift is the exact failure mode of a lock that cannot adapt",
      "Stationary block bootstrap of the real digit stream through the real engine rules (debt-driven recovery stake, max steps, TP, SL) returns the headline number: P(take-profit before stop-loss)",
      "Benjamini–Hochberg FDR across all ~320 market × pair candidates — the winner has to be genuinely good, not merely the luckiest of hundreds",
      "Geometric extreme-value loss-run forecast E[L_max] plus a live circuit breaker that halts if the realised ladder exceeds the modelled p95 depth",
    ],
    accent: "indigo",
    icon: "lock",
    preLocked: true,
    hasSides: false,
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Dual-locked pair", contracts: ["DIGITOVER", "DIGITUNDER"], desc: "The scan selects and freezes both the normal and the recovery contract" },
    ],
    nominalWinRate: "70–80% normal · 40–50% recovery",
    nominalPayout: "1.23–1.40× · 1.95–2.43×",
  },
];

export function getBotDefinition(botId: string): BotDefinition | undefined {
  return BOT_CATALOG.find(b => b.id === botId);
}
