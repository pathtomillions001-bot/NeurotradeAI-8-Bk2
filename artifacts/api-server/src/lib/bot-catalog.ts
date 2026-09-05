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

export type BotAccent = "cyan" | "violet" | "amber" | "emerald" | "rose" | "indigo" | "sky";

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
  family: SpecialistFamily | "duallock" | "apex";
  /** Human name of the contract family this bot is hard-wired to. */
  contractLabel: string;
  tagline: string;
  description: string;
  /** What the specialisation buys — shown on the card and in the console. */
  edge: string[];
  /** Accent used by the UI (theme-safe tailwind colour names). */
  accent: BotAccent;
  /**
   * Bots whose entire analysis happens ONCE, before deployment, and whose
   * contract pair is then frozen for the whole session (see the Dual-Lock
   * Range Sentinel). The UI renders a different console for these.
   */
  preLocked?: boolean;
  /**
   * Bots that lock ONE market + ONE user-chosen contract, then simply wait for
   * the market, the context and the tick to all agree (the Apex One-Shot
   * Sniper). The UI renders a dedicated console for these.
   */
  oneShot?: boolean;
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
      "The only bot that does ALL of its thinking before it starts. It searches every market for the triple — market, normal contract (Over 1 / Under 8 / Over 2 / Under 7) and recovery contract (Over 4 / Over 5 / Under 5 / Under 4) — with the highest simulated survival, then freezes it. From the first trade to TP or SL there is no re-analysis, no market switching and no contract change.",
    edge: [
      "Survival is the ranking signal, not a veto — the block bootstrap's P(take-profit before stop-loss) decides WHICH market is locked and is printed on the scan card, but no market is refused merely for a modest survival figure (the old 90% floor admitted nothing and was lifted)",
      "Live Page–Hinkley change detector on the realised normal-leg win rate — tells you when the locked edge has measurably decayed, in real time, without any mid-session re-analysis",
      "Frozen risk parameters — stake, take-profit, stop-loss and recovery steps are committed once and cannot change on a re-scan, so the quoted survival figure always describes the session you are actually running",
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
  {
    id: "apex",
    name: "Apex One-Shot Sniper",
    code: "BOT-APEX",
    family: "apex",
    contractLabel: "One contract · your choice",
    tagline: "Analyse once · lock · wait for the one shot",
    description:
      "The certainty engine. You name ONE contract — Over 7, Under 2, Matches, Even or Odd (never both sides of a pair) — and the AI analyses every digit market and LOCKS the single best one for it. From that moment there is no market switching and no rotation, exactly like the Barrier Architect in locked mode; the bot simply waits, for as long as it takes, until the market, the context and the tick all agree, and then takes one shot. It does not price a promised win rate — it replays its own entry rule over each market's real digit history and reports what that rule actually produced.",
    edge: [
      "WALK-FORWARD REPLAY OF THE LIVE ENTRY RULE — the exact conditional rule the engine fires on is replayed tick-by-tick over each market's own history using only information available at that tick, so the quoted accuracy is measured on the decisions this bot really makes instead of on a statistic computed over the whole stream",
      "EXACT LADDER-RUIN PROBABILITY — the debt-driven recovery ladder grows geometrically (debt(k) = stake·(1+a)^(k−1)), so ladderDepthLimit solves in closed form for k*, the number of consecutive losses your stake, payout, markup, stake cap and stop loss can absorb, and finite Markov chain imbedding (Fu & Koutras) then gives P(a deeper run occurs) exactly — no Monte Carlo, no normal approximation",
      "CONSECUTIVE-LOSS MARKOV CHAIN as the objective, not a diagnostic — ξ = P(L|L)/P(L) is fitted to the REPLAYED SHOTS and gated on its one-sided 95% upper bound, so only demonstrated clustering is refused; a market that pairs its losses is vetoed however high its win rate, because depth (not accuracy) is what ruins a ladder",
      "CLOSED-FORM MEAN TIME TO LADDER BREAK — E[T_k] = [1 + r(1−q^(k−1))/(1−q)] / (r·q^(k−1)) for the fitted 2-state chain, so the console can say '≈240 shots before this ladder breaks' rather than only quoting a probability",
      "CONDITIONAL ENTRY, because the marginal can never carry it — every Deriv digit contract pays below its fair rate (Over 1 pays 1.23× against an 80% fair rate), so an unbiased stream is always −EV and the only honest edge is P(win | the digits that just came), estimated by a variable-order Markov model with Krichevsky–Trofimov mixing: a hot market is carried by the marginal term and a hot context by the deeper ones, under one rule",
      "MARKOV STATE TIMING — the same loss chain is used as an entry filter: if P(win | last tick lost) beats P(win | last tick won) by more than its own standard error the bot waits for the post-loss state, and vice versa. A genuine timing edge measured on the model that gates consecutive losses",
      "ANYTIME-VALID CONFIDENCE SEQUENCE (betting test supermartingale + Ville's inequality) — a bot that re-tests every tick and fires when the test passes will fire on pure noise eventually; this lower bound is valid simultaneously at every tick, including at the data-dependent moment the bot chooses to fire",
      "WALD SPRT on the market stream, H₁ = break-even + 2 ABSOLUTE points — the provably minimum-expected-sample-size test for 'be certain, take as long as you like'. A relative δ is a known trap: on Over 0 it puts H₁ at 97%, a rate no digit stream reaches, so the test could only abandon",
      "PAGE–HINKLEY DRIFT GUARD — a locked market cannot be rotated out of, so a sustained fall in its realised win rate stops the bot firing and, if it persists, ends the session and asks for a fresh analysis. It never quietly moves market",
      "Pearson χ² block homogeneity plus an explicit drift slope, and multi-horizon concordance across 60/120/240/480 ticks — hundreds of ticks of accumulated evidence only mean something if they came from one regime",
      "Benjamini–Hochberg FDR across every market × digit examined plus a log(#candidates) surcharge on the SPRT threshold — the locked market must be genuinely exceptional, not the luckiest of dozens",
      "THREE EXPLICIT CERTAINTY BARS (Elite / Strict / Balanced) instead of one hidden threshold — the previous version of this bot hard-coded a single severe bar and the practical result was a bot that never traded, which is indistinguishable from a broken one. The bar is now a user decision and every gate is printed when it blocks",
      "RECOVERY IS SNIPED TOO, on the same shared ledger and the same debt-driven stake formula as every other bot in this section — a recovery trade waits for all three gates, because a hurried recovery is how a two-loss streak becomes a five-loss streak",
    ],
    accent: "sky",
    icon: "zap",
    oneShot: true,
    hasSides: false,
    hasDigitLock: true,
    digitLockHelp: "For Matches you may name the digit or leave it to the AI — it scores all ten in every digit market and locks the strongest.",
    sides: [
      { id: "both", label: "Your single contract", contracts: ["DIGITOVER", "DIGITUNDER", "DIGITMATCH", "DIGITEVEN", "DIGITODD"], desc: "You choose exactly one — over, under, matches, even or odd" },
    ],
    nominalWinRate: "replayed, not promised",
    nominalPayout: "1.09–8.93×",
  },
];

export function getBotDefinition(botId: string): BotDefinition | undefined {
  return BOT_CATALOG.find(b => b.id === botId);
}
