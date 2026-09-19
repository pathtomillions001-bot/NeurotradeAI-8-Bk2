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

export type BotAccent = "cyan" | "violet" | "amber" | "emerald" | "rose" | "indigo" | "sky" | "teal" | "fuchsia" | "orange" | "lime";

/** The three Kill-Shot Oracle variants (each owns one contract family). */
export type KillShotFamily = "overunder" | "parity" | "matchdiffer";

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
  family: SpecialistFamily | "duallock" | "killshot" | "twinhedge" | "accumulator";
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
   * Bots that lock ONE market + ONE user-chosen contract, then wait for health,
   * edge, the post-loss shield and the tick to all agree (the Kill-Shot Oracle).
   * The UI renders a dedicated console for these.
   */
  oneShot?: boolean;
  /**
   * Kill-Shot Oracle variants that own a whole contract family and support
   * market-switching (auto-rescan) or a locked market whose EDGE may rotate.
   * The UI renders a dedicated console for these.
   */
  killShotFamily?: KillShotFamily;
  /**
   * The Twin-Lock Hedge Sentinel: two complementary contracts per round
   * (Over 4 + Under 5 normal, Over 5 + Under 4 recovery), always executed
   * simultaneously on one tick, recovery armed ONLY on a both-legs-lost
   * round. Contracts are hard-wired — the user chooses nothing about the
   * pair, and only LOCK vs SWITCH for the market, after the scan.
   * The UI renders a dedicated console for this bot.
   */
  twinHedge?: boolean;
  /** Accumulator console: broker-constrained compounding and knockout risk. */
  accumulator?: boolean;
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
    id: "killshot",
    name: "Kill-Shot Oracle",
    code: "BOT-KILLSHOT",
    family: "killshot",
    contractLabel: "One contract · your choice",
    tagline: "Measure the rule · lock the market · one shot",
    description:
      "The certainty engine, rebuilt. You name ONE contract — Over 7, Under 2, Matches, Even or Odd (never both sides of a pair) — and the AI pulls 4 999 real digits from every market, fits a five-model ensemble on the first half, then MEASURES its own entry rule on the second half it has never seen. The market with the best out-of-sample expectancy is LOCKED: no switching, no rotation, exactly like the Barrier Architect in locked mode. It does not quote a promised win rate; it quotes what the rule actually did on unseen data, and how its losses arrived.",
    edge: [
      "MEASURED OUT OF SAMPLE, NOT BACKTESTED — the ensemble, the calibration and the entry threshold are fitted on the first half of each market's history and every number you are shown comes from the second half, which the fit never touched. In-sample and out-of-sample accuracy are printed side by side so over-fitting is visible rather than hidden",
      "4 999 DIGITS PER MARKET, PULLED ON DEMAND — the predecessor analysed a 300-digit ring buffer, so a walk-forward with a burn-in had ~180 decisions and could never satisfy its own 24-shot requirement. That was arithmetic, not fussiness. Deep history from Deriv's ticks_history is now fetched per market before anything is computed",
      "THE ENTRY BAR IS A SELF-REFERENTIAL QUANTILE, NOT A CONSTANT — the live edge is standardised against the model's own trailing readings and compared to its top ~1.5% / 2.5% / 4% quantile, so SELECTIVITY is the design parameter and the rule keeps producing measurable shots in every regime. A fixed 'LCB ≥ break-even + 0.5pp' fires constantly on Even and never on Over 0, because its distance from break-even is a function of the contract's variance, not of setup quality",
      "FIVE ESTIMATORS WITH A REGRET BOUND — forgetting Dirichlet (drifting marginal), context-tree mixing to order 4 with Krichevsky–Trofimov estimators (competes with the best fixed-order Markov model in hindsight), a 2-state chain on the outcome series, a Kaplan–Meier renewal hazard for narrow win sets, and a 2-state HMM regime filter run forward tick by tick. Hedge / multiplicative weights on the log-loss aggregates them: the mixture cannot be much worse than whichever model was right",
      "PLATT CALIBRATION + BRIER SKILL — a fused score is not a probability until it is calibrated against observed frequencies. The logistic map is fitted on the training half by Newton–Raphson; its slope is the model's own confession, collapsing toward zero when the context carries no information. A market with no conditional skill is REFUSED with that number printed, instead of being sold an invented edge",
      "EVIDENCE IS AN ANYTIME-VALID e-VALUE ON THE SHOTS — a betting test supermartingale with Ville's inequality, valid simultaneously at every tick including the data-dependent one the bot fires on. Critically it tests the SHOT SEQUENCE, not the market-wide tick stream: the previous bot's SPRT asked whether the whole market beat break-even, needed thousands more ticks to answer, and blocked every candidate while it waited",
      "EXACT LADDER-RUIN PROBABILITY — the shared recovery ladder grows geometrically, debt(k) = stake·(1+a)^(k−1) with a = (1+markup)/(payout−1), so k* (the consecutive losses your stake, payout, markup, cap and stop loss can absorb) solves in closed form, and finite Markov chain imbedding (Fu & Koutras 1994) then gives P(a deeper run occurs) exactly — no Monte Carlo, no normal approximation",
      "THE POST-LOSS SHIELD, SIMULATED BEFORE IT IS TRUSTED — after every loss the entry bar rises by a fixed number of σ per step of the run and a tick cool-down is enforced. The scan replays that exact rule over the out-of-sample shots and reports what it did: loss pairs before → after, and the shots it cost. 'No consecutive losses' becomes a measured number instead of a promise",
      "CONSECUTIVE-LOSS MARKOV CHAIN AS THE OBJECTIVE — ξ = P(L|L)/P(L) is fitted to the out-of-sample shots and gated on the one-sided z of q against p, not on ξ itself: when losses are rare, ξ's bound is wide from sampling noise alone and an absolute ceiling would veto every high-win-rate contract",
      "DETECTABILITY IS PRICED — S = (break-even − fair) / √(fair·(1−fair)) is the hurdle's per-shot signal-to-noise, and (1.645/S)² is how many shots it takes to prove an edge that size. Over 0 scores 0.058, the highest in the family: the contract most traders think is 'easy' is the one that needs the FEWEST shots to certify, and the console says so",
      "FOUR VERDICTS, NOT A WALL — CERTIFIED / QUALIFIED / WATCH / REFUSED. The scan always returns a ranking and the single best market available with the exact reason it fell short; a WATCH market can still be locked deliberately. Only REFUSED is absolute, and it means the measured out-of-sample expectancy is negative",
      "LOCKED MEANS LOCKED, AND IT TELLS YOU WHEN IT BREAKS — the symbol is a const captured once; no branch can move it. A Page–Hinkley detector plus a live re-read of the verdict raises RESCAN REQUIRED, holds fire, and after five consecutive flags ends the session and asks for a fresh analysis. It never quietly changes market",
      "SAME SHARED RECOVERY AS EVERY OTHER BOT — one account-global ledger, one debt-driven stake formula, one single-executor arbiter. A recovery shot carries one extra step of post-loss tightening: the debt is already geometric, so a hurried recovery entry is the exact mechanism that turns two losses into five",
    ],
    accent: "sky",
    icon: "crosshair",
    oneShot: true,
    hasSides: false,
    hasDigitLock: true,
    digitLockHelp: "For Matches you may name the digit or leave it to the AI — it scores all ten in every market and Benjamini–Hochberg runs across the whole 190-candidate family.",
    sides: [
      { id: "both", label: "Your single contract", contracts: ["DIGITOVER", "DIGITUNDER", "DIGITMATCH", "DIGITEVEN", "DIGITODD"], desc: "You choose exactly one — over, under, matches, even or odd" },
    ],
    nominalWinRate: "measured out of sample",
    nominalPayout: "1.09–8.93×",
  },
  {
    id: "ks-overunder",
    name: "Over/Under Oracle",
    code: "BOT-KS-OVERUNDER",
    family: "killshot",
    killShotFamily: "overunder",
    contractLabel: "Over / Under",
    tagline: "Kill-Shot measurement · one digit, your side",
    description:
      "The Kill-Shot Oracle's measurement applied to Over/Under. Pick one digit and choose Over only, Under only, or both. Run it locked to a single market (the edge may move, the market won't) or let it switch to the best market when this one cools — either way it keeps trading until your stop, target or you stop it.",
    edge: [
      "Same five-model ensemble and out-of-sample walk-forward as the Kill-Shot Oracle",
      "Over only, Under only, or both — your digit, your side",
      "Locked market or auto-switching: the edge rotates, never a dead-end rescan",
    ],
    accent: "teal",
    icon: "hash",
    hasSides: false,
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Over / Under", contracts: ["DIGITOVER", "DIGITUNDER"], desc: "Pick a digit and Over only, Under only, or both" },
    ],
    nominalWinRate: "10–90%",
    nominalPayout: "1.09–8.93×",
  },
  {
    id: "ks-parity",
    name: "Even/Odd Oracle",
    code: "BOT-KS-PARITY",
    family: "killshot",
    killShotFamily: "parity",
    contractLabel: "Even / Odd",
    tagline: "Kill-Shot measurement · parity, your side",
    description:
      "The Kill-Shot Oracle's measurement applied to Even/Odd. Choose Even only, Odd only, or both. Lock one market and let the edge rotate inside it, or allow market switching when the current one cools — it runs to your stop, target or until you stop it.",
    edge: [
      "Same five-model ensemble and out-of-sample walk-forward as the Kill-Shot Oracle",
      "Even only, Odd only, or both",
      "Locked market or auto-switching: the edge rotates, never a dead-end rescan",
    ],
    accent: "fuchsia",
    icon: "scale",
    hasSides: false,
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Even / Odd", contracts: ["DIGITEVEN", "DIGITODD"], desc: "Even only, Odd only, or both" },
    ],
    nominalWinRate: "≈50%",
    nominalPayout: "1.95×",
  },
  {
    id: "ks-matchdiff",
    name: "Matches/Differs Oracle",
    code: "BOT-KS-MATCHDIFF",
    family: "killshot",
    killShotFamily: "matchdiffer",
    contractLabel: "Matches / Differs",
    tagline: "Kill-Shot measurement · hot or cold digit",
    description:
      "The Kill-Shot Oracle's measurement applied to Matches and Differs. Trade Matches, Differs, or both, with your own digit or let the AI pick. Locked to one market the bot moves to the next best digit in that same market; in switching mode it moves to the next best market — until your stop, target or you stop it.",
    edge: [
      "Same five-model ensemble and out-of-sample walk-forward as the Kill-Shot Oracle",
      "Matches, Differs, or both — your digit or the AI's pick",
      "Locked market or auto-switching: the edge rotates, never a dead-end rescan",
    ],
    accent: "orange",
    icon: "crosshair",
    hasSides: false,
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Matches / Differs", contracts: ["DIGITMATCH", "DIGITDIFF"], desc: "Matches, Differs, or both — your digit or the AI's" },
    ],
    nominalWinRate: "≈11% / ≈90%",
    nominalPayout: "8.93× / 1.09×",
  },
  {
    id: "match-nexus",
    name: "Match Nexus — Quantum Singularity",
    code: "BOT-MATCH-NEXUS",
    family: "killshot",
    killShotFamily: "matchdiffer",
    contractLabel: "Matches (Quantum Singularity)",
    tagline: "6-model singularity · gap-distribution aware · match-tuned shield",
    description:
      "The first Matches bot built ONLY for Matches — not a generic tail model. It pulls 4 999 deep digits per market, fits a 6-expert ensemble (forgetting Dirichlet, context-tree mixing to order 4, outcome chain, digit-specific renewal hazard, regime HMM, transition row) with Hedge regret bound, calibrates with Platt + Brier skill, and measures its own quantile gate out-of-sample. Entry needs hazard ×1.25, gap at its own p60-p95, percentile ≥60% and geometric overdue <0.32 — not a fixed 4-12 band. Post-loss shield is match-tuned: after a loss gap resets to 0, so it enforces gap≥4, hazard≥1.4 and cool-down 8-18 ticks, plus anti-pattern veto if a digit lost 2/5 recently. Locked mode freezes market but rotates edge to next best digit; switching mode moves to best market when Page-Hinkley fires. Same shared recovery ledger as Match Sniper (debt + markup profit).",
    edge: [
      "6 EXPERTS WITH REGRET BOUND — forgetting Dirichlet (drifting marginal), context-tree mixing 0-4 KT (best Markov in hindsight), 2-state outcome chain P(win|last outcome), digit-specific Kaplan-Meier hazard h(gap) from THIS digit's own gaps, 2-state HMM regime filter, exact Dirichlet transition row P(digit|last digit). Hedge on log-loss.",
      "GAP DISTRIBUTION AWARENESS — not fixed 4-12. For each digit it builds its inter-arrival gap CDF, median, p70, p90, p95, current gap percentile and hazard × baseline. Entry needs gap ≥p60 and ≤p95, percentile ≥60%, hazardRelative ≥1.25 and geo-overdue (1-p̂)^gap <0.32.",
      "PLATT + BRIER SKILL + E-VALUE — fused score calibrated on training half; slope collapses to 0 when no skill, Brier skill vs base printed. Evidence is anytime-valid betting e-value on SHOT sequence (Ville), valid at data-dependent stop.",
      "MATCH-TUNED POST-LOSS SHIELD, SIMULATED BEFORE TRUSTED — for Matches a loss resets gap to 0, worst entry. Shield enforces gap≥4, hazard≥1.4, cool-down 8/12/18 ticks and is simulated over OOS shots: pairs before→after and cost in shots reported. Anti-pattern: digit losing 2/5 vetoed 25s.",
      "EXACT LADDER-RUIN via FMCI — debt(k)=stake·(1+a)^(k-1), a=(1+markup)/(payout-1), k* solves closed-form, absorption P(deeper run) exact via Fu&Koutras, no Monte Carlo.",
      "LOCKED = EDGE ROTATES, SWITCHING = MARKET ROTATES — locked freezes market but moves to next best digit when current cools (EV margin 0.015). Switching re-measures all 19 markets ×10 digits =190 candidates with BH FDR q=0.10 when PH fires. Never dead-end rescan.",
      "ENTROPY + STATIONARITY + CONCORDANCE GATES — Shannon entropy >3.275b = white noise refuse, χ² block homogeneity z>3 or drift slope>0.06 refuse, concordance needs 2/4 horizons above BE, Page-Hinkley live health.",
      "SAME SHARED RECOVERY AS MATCH SNIPER — one account-global ledger, debt-driven stake stake(k)=debt·(1+markup)/(payout-1), markup user-configurable, single-executor arbiter.",
    ],
    accent: "fuchsia",
    icon: "zap",
    hasSides: false,
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Matches — AI picks best digit", contracts: ["DIGITMATCH"], desc: "AI scores all 10 digits in every market with 6-model singularity and BH FDR" },
    ],
    nominalWinRate: "measured OOS 12-18%",
    nominalPayout: "8.93×",
  },
  {
    id: "accumulators",
    name: "Accumulator Edge Navigator",
    code: "BOT-ACCU",
    family: "accumulator",
    contractLabel: "ACCU · compounded growth",
    tagline: "Survive the range · compound carefully",
    description:
      "A dedicated Accumulator console for Deriv ACCU contracts. It measures price-return volatility, a two-state safe/knockout Markov model, block-bootstrap survival, regime heat and the compounded break-even line before it allows an entry. Growth rate, contract duration and take-profit are kept distinct: the broker's dynamic barrier is discovered at runtime, and a knockout is booked as a full-stake loss.",
    edge: [
      "Broker-aware ACCU flow: contracts_for → proposal with growth_rate and exchange-side take_profit → live open-contract monitor → pooled-socket sell",
      "Compounded economics: target ticks use (1 + growth rate)^ticks, so the gate compares conservative survival with 1 / compounded factor rather than a digit-bot payout multiplier",
      "Dynamic-barrier screening with broker quote preferred and an explicitly labelled fallback estimate when metadata is unavailable",
      "Block bootstrap preserves short-range dependence; a safe/knockout Markov read catches hazard after a recent shock and a hot-volatility regime pauses entries",
      "Early close and market switching are risk controls, not profit guarantees; a full-stake knockout, account limits and stale-feed conditions stop the loop",
      "Accumulator recovery sizes against actual compounded net return and records the actual net profit or full-stake loss into the shared account ledger",
    ],
    accent: "orange",
    icon: "trend",
    accumulator: true,
    hasSides: false,
    hasDigitLock: false,
    sides: [
      { id: "both", label: "ACCU growth contract", contracts: ["ACCU"], desc: "The engine selects a broker-supported growth rate and market after survival analysis" },
    ],
    nominalWinRate: "survival measured live",
    nominalPayout: "compounds per tick",
  },
  {
    id: "twinhedge",
    name: "Twin-Lock Hedge Sentinel",
    code: "BOT-TWINHEDGE",
    family: "twinhedge",
    contractLabel: "Over 4 + Under 5 · recovery Over 5 + Under 4",
    tagline: "Two legs, one tick, zero boundary exposure",
    twinHedge: true,
    description:
      "The paired-hedge bot. Normal rounds fire TWO contracts on the SAME tick with the SAME stake — Over 4 and Under 5 — so one leg wins every round by construction and the round only reaches the ladder if a broker half-tick drops both legs on opposite sides of the 4|5 boundary (a 4-then-5 up-crossing). That both-lose round, and ONLY that round, arms recovery: the mirrored pair Over 5 + Under 4, again both legs on one tick, staked to digest the TOTAL lost amount of the round that fell through (lose $2 across two $1 legs → attack $2). A split round is deliberately ignored — its small payout-vs-stakes tax never triggers a ladder. Every design decision in this bot therefore reduces to one number: P(next exit digit is 4 or 5). The scan measures that hazard per market — three fused estimators on an autocorrelation-corrected sample, worst-case posterior bounds, crossing-rate and clustering tests — and the live gate refuses boundary entries tick by tick: never enter from a 4 or a 5, never fire while the last tick crossed the boundary, never fire while the stream hovers. The recovery pair's own break-even is printed and enforced: at 2.43× per leg the ladder digests debt only while gap-avoidance q̂ clears 82.3%, so a market whose worst-case q̂ sits under that line is refused for recovery work — the honest number behind the promise, not a hope.",
    edge: [
      "SAME-TICK EXECUTION IS THE WHOLE GAME — both legs ride the shared bulk executor: every proposal burst is sent on one socket in one tick, entries are taken only on a FRESH tick arrival (never on a timer), and the loop refuses to fire on stale or stalled feeds, so leg A and leg B settle on the same exit tick by construction, not by luck",
      "BOUNDARY-DIGIT HAZARD AS THE SINGLE STATE VARIABLE — P(next digit ∈ {4,5}) estimated three ways (Dirichlet marginal, first-order Markov row on the current digit, boundary-side chain) and fused in inverse variance on n_eff = n(1−ρ₁)/(1+ρ₁); the gate reads the 95th-percentile posterior bound, so it trades the worst plausible hazard, not the flattering one",
      "THE SPLIT ROUND IS SILENTLY IGNORED — exactly the product rule: one win + one loss is the hedge doing its job, it never enters the recovery ledger, and the tax it pays (≈ |payout−2|·stake per round) is booked honestly in P&L, where TP/SL can still see it",
      "RECOVERY FIRES ON TOTALS, NOT LEGS — a both-lose round records ONE ledger event with the ROUND's total stake (2 × stake), and the recovery stake is the shared debt-driven formula fed the PAIR's net-profit rate (min-leg payout − 1), so the recovery ROUND — whichever of its two legs wins — digests debt + markup; the same one-account ledger and arbiter every other bot shares",
      "THE 82.3% DIGEST LINE IS THE VETO — a recovery pair at 2.43× per leg breaks even at gap-avoidance q* = 2/2.43 = 82.3%; the scan computes each market's worst-case q̂ and marks recovery on it unworkable below the line — a market that can only win the recovery pair by averaging past 82.3% is telling you the ladder will eat the account",
      "UP-CROSSINGS ARE THE DISASTER, DOWN-CROSSINGS THE WINDFALL — the side-flip rate and its asymmetry are measured per market; a stream that crosses up through 4|5 more than it crosses down is penalised (that is the microstructure where a half-tick of broker jitter turns a hedge into a double loss), and a tick that JUST crossed the boundary is never entered on",
      "POST-GAP COOL-DOWN — after any settlement on 4 or 5 the gate stands down for 3 clean ticks, because the digit stream that touched the boundary tends to keep touching it, and the next round's legs would enter it mid-hover",
      "RECOVERY IS PATIENT BUT NEVER STUCK — the same boundary gates apply, tightened, but debt must be digested: after 12 refused ticks a recovery round fires FORCED and the message says so, instead of letting a perfect entry become a stranded debt",
      "A BROKER REJECTS ONE LEG? THE ROUND NEVER ARMS RECOVERY — a leg that never traded cannot 'lose', so the round settles on the confirmed leg alone and recovery only ever triggers when both legs actually traded and actually lost; the hedge is never allowed to grow debt out of a socket hiccup",
      "LOCK OR SWITCH — AFTER THE SCAN, NOT IN THE SETTINGS — the scan ranks the whole digit universe on the boundary statistics; you then choose: LOCK freezes the chosen market for the engagement (hazards only warn), SWITCH lets the engine rotate to the next-best scanned market when the live hazard measurably decays. Contracts NEVER rotate — the pair is the product",
      "CIRCUIT BREAKERS WITH A MODELLED NUMBER — consecutive recovery failures beyond the max-steps ladder halt the session, and the bootstrap's p95 recovery depth + 2 is armed against the realised loss run; the breaker quotes the scan's own prediction, not a magic constant",
    ],
    accent: "lime",
    icon: "layers",
    hasSides: false,
    hasDigitLock: false,
    sides: [
      {
        id: "both",
        label: "Twin pair (auto-configured)",
        contracts: ["DIGITOVER", "DIGITUNDER"],
        desc: "Normal Over 4 + Under 5 · recovery Over 5 + Under 4 — both legs, one tick, no contract choice",
      },
    ],
    nominalWinRate: "100% one-leg-wins normal · ≈80%+ recovery pair",
    nominalPayout: "1.95× · 2.43×",
  },
];

export function getBotDefinition(botId: string): BotDefinition | undefined {
  return BOT_CATALOG.find(b => b.id === botId);
}

// ── Bot console contract ──────────────────────────────────────────────────────
//
// Every bot is driven by a dedicated console component in the web bundle. The
// web service and the API service deploy INDEPENDENTLY, so the API has to state
// which console each bot needs; an out-of-date web bundle then detects that it
// cannot render a bot and says so instead of quietly opening the generic
// specialist console.
//
// The `@N` suffix is a REVISION: bump it whenever a console's behaviour or
// layout changes materially, so bundles built before the change are detected
// even though the bot id itself never changed.

/** Console id + revision the web bundle must implement to drive this bot. */
export function botConsoleId(bot: BotDefinition): string {
  if (bot.accumulator) return "accumulator@1";
  if (bot.twinHedge) return "twin-hedge@1";
  if (bot.preLocked) return "dual-lock@1";
  if (bot.oneShot) return "killshot@1";
  if (bot.killShotFamily) return "killshot-family@1";
  return "specialist@1";
}

/** Every console id this catalogue can ask a web bundle to render. */
export function botConsoleIds(): string[] {
  return [...new Set(BOT_CATALOG.map(botConsoleId))].sort();
}
