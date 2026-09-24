/**
 * AI Bot catalogue.
 *
 * Family specialists spend their analysis budget on one contract family (see
 * `lib/specialist-analysis.ts`). Omni Sentinel instead obeys the user's
 * multi-contract allowlist in BOTH normal and recovery mode. Dedicated console
 * ids and route guards keep those execution contracts separate.
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
  family: SpecialistFamily | "duallock" | "killshot" | "multi";
  /** Human-readable contract scope advertised by this bot. */
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
   * Echo Apex: the institutional Matches engine (echo spectrum, Hawkes heat,
   * suffix memory, log-pool fusion, pacing valve). Deploys from its own
   * console and its own /apex endpoints, never the generic specialist route.
   */
  apex?: boolean;
  /**
   * Barrier Bastion: the recovery-first Over/Under engine (Over 1 / Under 8
   * normal, Over 3 / Under 6 recovery, four-lens log-pool fusion, loss-pair
   * utility, STATIC recovery bar). Deploys from its own console and its own
   * /bastion endpoints, never the generic specialist route.
   */
  bastion?: boolean;
  /**
   * Parity Forge: the Even/Odd recovery-first engine (Even/Odd normal,
   * Even/Odd recovery, four parity lenses, loss-pair-aware utility, STATIC
   * break-even bar, pacing valve). Deploys from its own console and its own
   * /parity-forge endpoints, never the generic specialist route.
   */
  parityForge?: boolean;
  /**
   * Vector Surge: the Rise/Fall recovery-first engine (Rise/Fall normal,
   * Rise/Fall recovery, four momentum lenses, loss-pair-aware utility, STATIC
   * break-even bar, pacing valve). Deploys from its own console and its own
   * /surge endpoints, never the generic specialist route.
   */
  surge?: boolean;
  /** Over/Under Navigator: four user-selected normal/recovery barriers. */
  navigator?: boolean;
  /**
   * Over/Under Turbo: the continuous-fire Over/Under engine. Scans every digit
   * market × the fixed normal (Over 1/2, Under 7/8) and recovery (Over 4/5,
   * Under 4/5) barrier sets ONCE, locks the best market + barriers, then trades
   * non-stop (arm-once, no mid-session gating or re-scanning) to TP/SL, with an
   * optional market-only switching rescue. Deploys from its own console and its
   * own /overunder-turbo endpoints.
   */
  turbo?: boolean;
  /** Omni Sentinel: allowlisted multi-contract, cross-market recovery. */
  omni?: boolean;
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
    id: "omni",
    name: "Omni Sentinel",
    code: "BOT-OMNI",
    family: "multi",
    omni: true,
    contractLabel: "Rise/Fall · Even/Odd · Matches/Differs · Over/Under",
    tagline: "Your contracts. Every opportunity. Recovery without ratchets.",
    description:
      "A multi-contract opportunity hunter. Enable any combination of Rise, Fall, Even, Odd, Matches, Differs, Over and Under; the AI chooses the digit, barrier and supported automated market. The same allowlist binds recovery. A quote-aware tournament ranks expected log return, uncertainty, debt payment and loss-pair risk, without raising a threshold or adding cooldowns after losses. Lock one market or allow switching for both normal and recovery trades. If no positive estimated opportunity exists, it waits. Recovery can still lose money; estimates are not guarantees.",
    edge: [
      "Five causal Bayesian experts: fair prior, slow/fast marginals and order-1/2 Markov backoff, weighted by past log loss",
      "One allowlist for both phases; all valid enabled digits and barriers compete on the app's supported automated markets",
      "Debt-aware expected-log-return ranking with uncertainty shrinkage, loss-pair risk and live-payout stake sizing",
      "Fixed utility floor at zero: no loss-run ratchets, forced recovery trades or progressively longer cooldowns",
      "Fresh-tick socket-send guards, broker-confirmed settlement and one shared live recovery ledger",
      "Connected-account execution, chronological replay diagnostics and a transparent cross-contract opportunity radar",
    ],
    accent: "indigo",
    icon: "shield",
    hasSides: false,
    hasDigitLock: false,
    sides: [],
    nominalWinRate: "estimated, not guaranteed",
    nominalPayout: "live quote",
  },
  {
    id: "overunder-navigator",
    name: "Over/Under Navigator",
    code: "BOT-NAVIGATOR",
    family: "barrier",
    navigator: true,
    contractLabel: "Custom Over / Under → custom recovery",
    tagline: "Your digits. A frozen recovery bar. Best shot hunts.",
    description:
      "A dedicated Over/Under engine where you choose every barrier: normal Over and Under digits plus separate recovery Over and Under digits. You can reuse the same digit in both legs, arm one side or both, and lock a market or let the Market Scout steer. Six independent statistical lenses — the four classic contexts plus an EW-drift recency rate and a 2-state regime HMM — are fused with a calibrated log opinion pool, while recovery selection prices loss-pair risk and never hardens after a recovery loss.",
    edge: [
      "Separate normal and recovery contracts — Over 1 / Under 8 can recover as Over 6 / Under 3, or the same digit can be used for both",
      "Six-lens log pool: order-1/2 digit Markov, band-state Markov, censored hole hazard, decayed suffix memory, EW drift (recency-weighted rate, fair-prior shrunk) and a Baum–Welch 2-state regime HMM — skill-weighted and temperature-calibrated",
      "Normal timing uses a soft quantile pacing valve; it is a budget, not a stack of hard vetoes",
      "Recovery radar scores both selected recovery sides every tick with expected value minus contextual loss-pair risk (order-2 band chain, not the loss run)",
      "The recovery bar is each contract's STATIC payout-aware break-even, clamped to [fair, fair+0.02] — a function of the contract only; no recovery step can ever move it",
      "Market Scout (switching mode): every allowed market is scored per $ on live tape edge + held-out re-fit card + own fired outcomes, with margin/cooldown/dwell hysteresis and a flee clause for dead tapes — it redirects the fire budget, never vetoes a shot",
      "Walk-forward scan reports unseen normal hits, recovery hits, loss pairs and time in debt before deployment",
    ],
    accent: "fuchsia",
    icon: "crosshair",
    hasSides: true,
    primaryLabel: "Over",
    secondaryLabel: "Under",
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Over & Under", contracts: ["DIGITOVER", "DIGITUNDER"], desc: "Score both armed sides and let the policy time the best one" },
      { id: "primary", label: "Over only", contracts: ["DIGITOVER"], desc: "Normal and recovery can still use your selected Over barriers" },
      { id: "secondary", label: "Under only", contracts: ["DIGITUNDER"], desc: "Normal and recovery can still use your selected Under barriers" },
    ],
    nominalWinRate: "measured walk-forward",
    nominalPayout: "barrier quote",
  },
  {
    id: "overunder-turbo",
    name: "Over/Under Turbo",
    code: "BOT-OU-TURBO",
    family: "barrier",
    turbo: true,
    contractLabel: "Over 1/2 · Under 7/8 → recovery Over 4/5 · Under 4/5",
    tagline: "Scan once. Lock the best tape. Fire non-stop.",
    description:
      "The continuous-fire Over/Under specialist. One deep scan subjects every digit market to all four normal barriers (Over 1, Over 2, Under 7, Under 8) crossed with all four recovery barriers (Over 4, Over 5, Under 4, Under 5) and returns the single best market with its best normal and best recovery contract, ranked by simulated survival — the honest probability that an uninterrupted session reaches take-profit before stop-loss. Deploy it LOCKED (never move) or SWITCHING (leave the market only when it turns measurably unfavorable — the barriers never change). Then it arms once on a good entry tick and trades non-stop, one 1-tick contract settling straight into the next, with zero mid-session re-analysis or re-scanning, through wins and losses alike, until TP or SL.",
    edge: [
      "Non-stop cadence — the whole analysis budget is spent ONCE up front; after arming there is no gating, no green-light waiting and no re-scanning between trades, so one contract flows directly into the next like a turbo bot",
      "Fixed barrier sets, exhaustively scanned: normal Over 1 / Over 2 / Under 7 / Under 8 × recovery Over 4 / Over 5 / Under 4 / Under 5 across every digit market — the best triple wins",
      "Survival-first selection: loss-clustering Markov (ξ = P(loss|loss)/P(loss)), the CONDITIONAL recovery estimand P(recovery wins | last digit ∈ normal-loss set), autocorrelation-corrected lower-confidence bounds, χ² stationarity and a stationary block-bootstrap replay of the real engine rules → P(TP before SL), then a Benjamini–Hochberg FDR screen",
      "Arm-once entry: waits for the locked normal contract to be at/above break-even over the live window, then starts the uninterrupted run",
      "Switching rescue: leaves the market ONLY when it turns unfavorable (worst-case rate under break-even, losses clustering, or drifting) and only for a measurably better tape — continuous trading is never paused for a healthy market",
      "Same shared recovery ledger and debt-driven stake formula as every other bot, with a circuit breaker if the live loss run exceeds the modelled depth",
    ],
    accent: "sky",
    icon: "zap",
    hasSides: false,
    hasDigitLock: false,
    sides: [],
    nominalWinRate: "simulated survival",
    nominalPayout: "barrier quote",
  },
  {
    id: "apex",
    name: "Echo Apex",
    code: "BOT-APEX",
    family: "match",
    apex: true,
    contractLabel: "Matches only",
    tagline: "Repeat rhythm, measured. No gates, just edge.",
    description:
      "The institutional Matches engine. It listens to each market's repeat rhythm through three independent lenses — a 48-lag echo spectrum, a fitted Hawkes heat process and a decaying suffix memory — fuses them in a logarithmic opinion pool, and fires on a pacing budget instead of a stack of vetoes. Scan first, then lock your market or let it migrate to the best-measured edge. Normal and recovery contracts are always Matches, on the shared debt-driven ledger.",
    edge: [
      "48-lag echo spectrum with per-lag sample sizes — digits are tilted by their own characteristic repeat rhythm, up AND down",
      "Hawkes self-excitation fit per market by maximum likelihood — reads which digit is hot RIGHT NOW and how fast heat decays here",
      "Decayed longest-match suffix memory (orders 1–5): what followed this exact context every time it printed before",
      "Logarithmic opinion pool with skill-weighted lenses + temperature calibration — agreement across lenses is what makes a shot safe",
      "Pacing valve, zero vetoes: the bar holds the budgeted fire rate (Brisk/Steady/Patient) instead of filtering trades through gate stacks",
      "Honest held-out measurement — every parameter fits on the first 60% of history and the verdict replays the exact live policy on the final 40%",
    ],
    accent: "lime",
    icon: "activity",
    hasSides: false,
    hasDigitLock: true,
    digitLockHelp: "Let the AI pick the hottest digit per market, or lock one digit and let the valve time it.",
    sides: [{ id: "both", label: "Matches", contracts: ["DIGITMATCH"], desc: "One digit, one tick — Matches in normal and recovery mode" }],
    nominalWinRate: "measured held-out",
    nominalPayout: "8.93×",
  },
  {
    id: "bastion",
    name: "Barrier Bastion",
    code: "BOT-BASTION",
    family: "barrier",
    bastion: true,
    contractLabel: "Over 1 / Under 8 → Over 3 / Under 6",
    tagline: "Recovery-first bands. Bars that never harden.",
    description:
      "The recovery-first Over/Under engine. Normal trades ride the outer 80% bands (Over 1 or Under 8 — the AI picks the side the tape is leaning to); a loss drops straight into the inner 60% recovery bands (Over 3 or Under 6) and fires the BEST shot the market offers the moment it shows tilt. The recovery bar is a frozen, payout-aware break-even — it can never tighten after a recovery loss, so debt is never left waiting on a hardening gate. Six lenses (the four classic contexts plus EW drift and a regime HMM) feed the probability, side choice minimises loss PAIRS (the thing that actually kills a recovery ladder) with a clustering-aware utility, and in switching mode the Market Scout steers BOTH normal and recovery to the best-scored market with anti-flap hysteresis.",
    edge: [
      "Six-lens log-pool fusion: 2-state band Markov (≈5× samples/state), order-2 digit Markov, Kaplan–Meier hole hazard, decayed suffix memory, EW drift (recency-weighted band rate, fair-prior shrunk) and a Baum–Welch 2-state regime HMM",
      "Loss-pair-aware side utility: expected value minus the priced risk that this shot extends a recovery loss run — now contextual (order-2 band chain P(loss|last two band states), blended with order-1)",
      "STATIC recovery bar at the payout-aware break-even (1/payout), clamped to [fair, fair+0.02] — no post-loss tightening, no ratchets, no cool-down ladders (structurally impossible: the bar is a frozen function of the contract only)",
      "Recovery fires the best Over 3 / Under 6 shot the next tick it shows tilt — and if none exists here, the Market Scout migrates to the best-scored market for one",
      "Market Scout: live tape edge + held-out re-fit card (age-decayed) + own fired outcomes (Beta-shrunk) per market, with margin/cooldown/dwell hysteresis and a flee clause when the active tape is dead — it redirects the fire budget, never vetoes a shot",
      "Post-loss conditioning: the losing digit is the Markov state — the exact predictor the next recovery shot is chosen on",
      "Honest walk-forward per market: the exact live policy replayed on unseen ticks, reporting recovery hit rate, loss pairs and ticks spent in debt",
    ],
    accent: "orange",
    icon: "shield",
    hasSides: true,
    primaryLabel: "Over 1",
    secondaryLabel: "Under 8",
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Over 1 & Under 8", contracts: ["DIGITOVER", "DIGITUNDER"], desc: "Analyse both bands, execute the favoured side (recovery always uses both)" },
      { id: "primary", label: "Over 1 only", contracts: ["DIGITOVER"], desc: "Normal trades stay on Over 1 — recovery still picks the best of Over 3 / Under 6" },
      { id: "secondary", label: "Under 8 only", contracts: ["DIGITUNDER"], desc: "Normal trades stay on Under 8 — recovery still picks the best of Over 3 / Under 6" },
    ],
    nominalWinRate: "80% normal / 60% recovery",
    nominalPayout: "1.23× / 1.63×",
  },
  {
    id: "parity-forge",
    name: "Parity Forge",
    code: "BOT-PARITY-FORGE",
    family: "parity",
    parityForge: true,
    contractLabel: "Even / Odd → Even / Odd recovery",
    tagline: "Even/Odd, recovery-first. Bars frozen, best shot hunts.",
    description:
      "The Even/Odd recovery-first engine. Normal trades are Even/Odd parity at 1.95×, timed by a pacing valve that budgets selectivity instead of stacking gates. A loss drops into recovery — still Even/Odd, but the selection is top-tier: four parity lenses (2-state + order-2 Markov at ~5× evidence, run-length hazard, digit-conditioned parity, decayed suffix memory) fuse in a log-pool, temperature-calibrated, and the side with the best loss-pair-adjusted utility fires the MOMENT it clears the frozen 52% break-even bar. No post-loss hardening — the bar cannot move with the loss run, so debt is never left waiting. If the bar is cold here, switching mode migrates and hunts every market for a clean Even/Odd shot; locked mode holds and waits. Every market is scored on an honest walk-forward of the exact live policy, reporting recovery hit rate, loss pairs and ticks in debt.",
    edge: [
      "Four-lens parity log-pool: 2-state Markov (order1–2, Jeffreys + shrinkage, ~5× samples/state), Kaplan–Meier run-hazard, digit-conditioned parity Dirichlet, decayed suffix memory (orders 2–5, half-life 550)",
      "Loss-pair-aware utility: expected value minus priced consecutive-loss risk using the 2-state q_LL — recovery penalty 0.45, normal 0.15, fixed, never indexed to the live loss run",
      "STATIC recovery bar at 52% (break-even 51.28% + cushion) — no post-loss tightening, no ratchets, no cool-down ladders (structurally impossible: the bar is a frozen const, decideRecovery takes no loss-run argument)",
      "Best-shot execution: BOTH Even and Odd scored every tick, utilities ranked, the single best fires the next tick it clears the bar — intelligent timing, not a forced trade",
      "If no side clears, the bot waits; switching mode HUNTS all digit markets and migrates to the best bar-clearing Even/Odd shot — locked mode holds ground",
      "Pacing valve for normal (0.20 shots/tick, zero floor) — selectivity is a budget, never a stack of vetoes",
      "Post-loss conditioning via parity Markov + digit parity: the losing parity and losing digit are the conditioning states the next recovery shot is chosen on",
      "Honest walk-forward per market: the exact live policy replayed on unseen ticks, reporting recovery hit rate, recovery loss pairs and avg ticks in debt — verdicts are labels, never gates",
    ],
    accent: "teal",
    icon: "zap",
    hasSides: true,
    primaryLabel: "Even",
    secondaryLabel: "Odd",
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Even & Odd", contracts: ["DIGITEVEN", "DIGITODD"], desc: "Analyse both, execute the favoured side (recovery always picks the best)" },
      { id: "primary", label: "Even only", contracts: ["DIGITEVEN"], desc: "Normal stays on Even — recovery still scores both and fires the best" },
      { id: "secondary", label: "Odd only", contracts: ["DIGITODD"], desc: "Normal stays on Odd — recovery still scores both and fires the best" },
    ],
    nominalWinRate: "≈52% normal / ≥56% recovery",
    nominalPayout: "1.95×",
  },
  {
    id: "surge",
    name: "Vector Surge",
    code: "BOT-SURGE",
    family: "momentum",
    surge: true,
    contractLabel: "Rise / Fall → Rise / Fall recovery",
    tagline: "Rise/Fall, recovery-first. Bars frozen, vectors hunt.",
    description:
      "The Rise/Fall recovery-first engine. Normal trades are Rise/Fall at 1.92×, timed by a pacing valve that budgets selectivity instead of stacking gates. A loss drops into recovery — still Rise/Fall, but the selection is top-tier: four momentum lenses (2-state + order-2 direction Markov with Jeffreys + shrinkage, Kaplan–Meier streak hazard, Hurst R/S regime + EMA drift t-stat, decayed suffix memory over ternary direction patterns) fuse in a log-pool, temperature-calibrated, and the side with the best loss-pair-adjusted utility fires the MOMENT it clears the frozen 53% break-even bar. No post-loss hardening — the bar cannot move with the loss run, so debt is never left waiting. If the bar is cold here, switching mode migrates and hunts every market for a clean Rise/Fall shot; locked mode holds and waits. Every market is scored on an honest walk-forward of the exact live policy, reporting recovery hit rate, loss pairs and ticks in debt.",
    edge: [
      "Four-lens momentum log-pool: 2-state direction Markov (order1–2, Jeffreys + shrinkage, one chain per side), Kaplan–Meier hazard over Rise/Fall runs, Hurst R/S + EMA drift with split-half agreement and multi-scale direction consistency, decayed suffix memory over rose/fall/flat patterns (orders 2–5, half-life 600)",
      "Loss-pair-aware utility: expected value minus priced consecutive-loss risk using q_LL per side — recovery penalty 0.45, normal 0.15, fixed, never indexed to the live loss run",
      "STATIC recovery bar at 53% (break-even 52.08% + cushion) — no post-loss tightening, no ratchets, no cool-down ladders (structurally impossible: the bar is a frozen const, decideRecovery takes no loss-run argument)",
      "Best-shot execution: BOTH Rise and Fall scored every tick, utilities ranked, the single best fires the next tick it clears the bar — intelligent timing, not a forced trade",
      "If no side clears, the bot waits; switching mode HUNTS all markets and migrates to the best bar-clearing Rise/Fall shot — locked mode holds ground",
      "Pacing valve for normal (0.20 shots/tick, zero floor) — selectivity is a budget, never a stack of vetoes",
      "Post-loss conditioning via direction Markov: the losing direction is the conditioning state the next recovery shot is chosen on",
      "Honest walk-forward per market: the exact live policy replayed on unseen ticks, reporting recovery hit rate, recovery loss pairs and avg ticks in debt — verdicts are labels, never gates",
    ],
    accent: "rose",
    icon: "trend",
    hasSides: true,
    primaryLabel: "Rise",
    secondaryLabel: "Fall",
    hasDigitLock: false,
    sides: [
      { id: "both", label: "Rise & Fall", contracts: ["CALL", "PUT"], desc: "Analyse both, execute the favoured side (recovery always picks the best)" },
      { id: "primary", label: "Rise only", contracts: ["CALL"], desc: "Normal stays on Rise — recovery still scores both and fires the best" },
      { id: "secondary", label: "Fall only", contracts: ["PUT"], desc: "Normal stays on Fall — recovery still scores both and fires the best" },
    ],
    nominalWinRate: "≈52% normal / ≥56% recovery",
    nominalPayout: "1.92×",
  },
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
]

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
  if (bot.omni) return "omni@2";
  if (bot.apex) return "apex@1";
  if (bot.bastion) return "bastion@1";
  if (bot.parityForge) return "parity-forge@1";
  if (bot.surge) return "surge@1";
  if (bot.navigator) return "overunder-navigator@1";
  if (bot.turbo) return "overunder-turbo@1";
  if (bot.preLocked) return "dual-lock@1";
  if (bot.oneShot) return "killshot@1";
  if (bot.killShotFamily) return "killshot-family@1";
  return "specialist@1";
}

/** Every console id this catalogue can ask a web bundle to render. */
export function botConsoleIds(): string[] {
  return [...new Set(BOT_CATALOG.map(botConsoleId))].sort();
}
