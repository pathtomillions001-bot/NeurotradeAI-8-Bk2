/**
 * Shared types and presentation constants for the Specialist AI Bots section.
 *
 * The bot catalogue itself lives on the server (`lib/bot-catalog.ts`) and is
 * fetched from `GET /api/bots`; these types mirror it for the UI, and the accent
 * table keeps every bot on the app's existing neon-cyan-on-navy theme while
 * giving each specialist its own hue.
 */

import type { PrismTelemetry } from "./prism-match";

import { Activity, Hash, Scale, Crosshair, TrendingUp, ShieldCheck, Lock, Target, Zap } from "lucide-react";

export type AccentKey = "cyan" | "violet" | "amber" | "emerald" | "rose" | "indigo" | "sky" | "teal" | "fuchsia" | "orange" | "lime";

export interface BotSideOption {
  id: "both" | "primary" | "secondary";
  label: string;
  contracts: string[];
  desc: string;
}

export interface BotCardData {
  id: string;
  name: string;
  code: string;
  family: string;
  contractLabel: string;
  tagline: string;
  description: string;
  edge: string[];
  accent: AccentKey;
  icon: string;
  hasSides: boolean;
  primaryLabel?: string;
  secondaryLabel?: string;
  hasDigitLock: boolean;
  digitLockHelp?: string;
  sides: BotSideOption[];
  nominalWinRate: string;
  nominalPayout: string;
  /** Pre-locked bots analyse once, then freeze their pair for the session. */
  preLocked?: boolean;
  /** One-shot bots lock one market + one contract and wait for the one shot. */
  oneShot?: boolean;
  /** Kill-Shot Oracle variants that own a whole contract family. */
  killShotFamily?: "overunder" | "parity" | "matchdiffer";
  prismMatch?: boolean;
  /**
   * Console id + revision the API expects this bot to be driven by
   * (e.g. "dual-lock@1"). The web bundle only renders bots whose console it
   * implements; anything else is reported as a stale bundle instead of being
   * silently drawn with the generic specialist console.
   */
  console?: string;
  session: BotSessionStatus | null;
}

export interface BotSessionStatus {
  /** Prism Match runner: prismatic probabilities, execution integrity and paper/live mode. */
  prism?: PrismTelemetry;
  running: boolean;
  botId: string | null;
  botName: string | null;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  consecutiveRecoveryLosses: number;
  /** Dual-Lock only: deepest realised consecutive-loss run this session. */
  deepestLossRun?: number;
  /** Dual-Lock only: the frozen triple + its pre-deploy telemetry. */
  lock?: {
    symbol: string;
    displayName: string;
    normal: string;
    recovery: string;
    survival: number;
    ruin: number;
    clusterRatio: number;
    normalLcb: number;
    recoveryConditional: number;
    expectedMaxLossRun: number;
    recoveryDepthP95: number;
    signals: string[];
  };
  /** Kill-Shot only: the market has changed and the user must re-analyse. */
  needsRescan?: boolean;
  /**
   * Kill-Shot only: the frozen lock (market + the user's single contract) and
   * the out-of-sample measurement that chose it.
   */
  killshotLock?: {
    symbol: string;
    displayName: string;
    contract: string;
    /** The plan's contracts, individually labelled. */
    contracts: string[];
    /** "locked" (default) or user-allowed "switching". */
    marketMode: string;
    certainty: string;
    verdict: string;
    confidence: number;
    payout: number;
    breakEven: number;
    /** Accuracy of the frozen rule on ticks the fit never saw. */
    oosWinRate: number;
    oosWinRateLower: number;
    oosShots: number;
    oosTicks: number;
    edgePerDollar: number;
    evidenceE: number;
    brierSkill: number;
    tau: number;
    ladderSafety: number;
    ladderLimit: number;
    expectedShotsToBreak: number;
    xi: number;
    pairsBefore: number;
    pairsAfter: number;
    forced: boolean;
    signals: string[];
  };
  /** Kill-Shot only: what the bot is waiting for right now. */
  watch?: {
    phase: "watching" | "armed" | "firing" | "settling";
    confidence: number;
    verdict: string;
    /** Calibrated P(win) at the live context, the decision statistic and the raw edge. */
    p: number;
    z: number;
    edgeZ: number;
    bar: number;
    tau: number;
    marginZ: number;
    leader: string;
    contextOrder: number;
    contextCount: number;
    regimeHot: number;
    experts: Array<{ name: string; p: number; n: number; weight: number }>;
    blockers: string[];
    ticksWatched: number;
    setupsRejected: number;
    health: {
      ph: number;
      threshold: number;
      fired: boolean;
      consecutive: number;
      needsRescan: boolean;
      note: string;
    };
    shield: {
      lossRun: number;
      barBoost: number;
      ticksSinceLoss: number;
      coolTicks: number;
      active: boolean;
    };
    entry: {
      ready: boolean;
      score: number;
      waitTicks: number;
      reason: string;
      momentumPP: number;
      gapRatio: number;
      preferredState: "after-loss" | "after-win" | "none";
      stateEdgePP: number;
    };
  };
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  entropyBits?: number;
  expectedValue?: number;
  specialist?: {
    family: string;
    bonus: number;
    confidence: number;
    favoured?: string;
    metrics: Record<string, number>;
    signals: string[];
  };
  digitCandidates?: Array<{
    digit: number;
    p: number;
    sigma: number;
    upper: number;
    gap: number;
    hazardRelative: number;
    recent6: number;
    significant: boolean;
  }>;
  topMarkets?: Array<{
    symbol: string;
    displayName: string;
    contractType: string;
    barrier?: number;
    score: number;
    winProbability: number;
    expectedValue?: number;
    entropyBits?: number;
    reason: string;
  }>;
  config?: {
    stake: number;
    stopLoss: number;
    takeProfit: number;
    recoveryAutoMode: boolean;
    recoveryMultiplier: number;
    recoveryMethod: string;
    maxRecoverySteps: number;
    contractTypes: string[];
    barriers: number[];
    lockedBarrier?: number;
    marketMode?: string;
    lockedSymbol?: string;
  };
  /** Kill-Shot family bots: the active (possibly rotated) lock. */
  deployed?: {
    symbol: string;
    displayName: string;
    contract: string;
    verdict: string;
    confidence: number;
    edgePerDollar: number;
    oosWinRate: number;
    oosShots: number;
    breakEven: number;
    payout: number;
  };
  /**
   * Twin-Rail only: the two frozen rails, the live quotes and the measurement
   * behind the running session (carrier toll, break-even dead-rail rate, the
   * context the gate is conditioning on).
   */
  rail?: {
    symbol: string;
    displayName: string;
    normal: string;
    recovery: string;
    marketMode: string;
    trigger: string;
    discipline: string;
    quotesLive: boolean;
    normalQuote: { overPayout: number; underPayout: number };
    recoveryQuote: { overPayout: number; underPayout: number };
    carrierToll: number;
    quota: number;
    deadRate: number;
    contextualDeadRate: number;
    context: string;
    samples: number;
    verdict: string;
    score: number;
    reason: string;
    signals: string[];
    forced: boolean;
  };
  /** Twin-Rail only: the gate and the next fire window. */
  twinWatch?: {
    phase: string;
    gateOpen: boolean;
    gateReason: string;
    cycleLcb: number;
    cycleMean: number;
    carrierToll: number;
    railMean: number;
    railLcb: number;
    tickPeriodMs: number;
    tickAgeMs: number;
    headroomMs: number;
    budgetMs: number;
    waitReason: string;
    holds: number;
  };
  /** Twin-Rail only: same-tick execution integrity, per session. */
  twinLedger?: {
    roundCount: number;
    cycleCount: number;
    syncedRounds: number;
    deadRailHits: number;
    splitRounds: number;
    nakedRepairs: number;
    doubleLosses: number;
    syncRate: number;
    burstP50Ms: number;
    burstP95Ms: number;
    lastBurstMs: number;
    lastHeadroomMs: number;
    lastDigit: number | null;
    lastSync: string | null;
    legStake: number;
    pairExposure: number;
  };
  /** Kill-Shot family bots: compact live watch state. */
  familyWatch?: {
    phase: "watching" | "armed" | "firing" | "settling";
    p: number;
    z: number;
    bar: number;
    reason: string;
    switched: boolean;
    confidence: number;
    verdict: string;
    ticksWatched: number;
  };
}

/**
 * Per-accent Tailwind classes. Written out in full (never interpolated) so the
 * Tailwind scanner can see every literal class name.
 */
export const ACCENTS: Record<AccentKey, {
  text: string;
  dot: string;
  grad: string;
  iconBg: string;
  iconBorder: string;
  badgeBg: string;
  activeBg: string;
  activeBorder: string;
  panelBg: string;
  panelBorder: string;
  headerGrad: string;
  outlineBtn: string;
  solidBtn: string;
  focusBorder: string;
  cardGlow: string;
}> = {
  cyan: {
    text: "text-cyan-300",
    dot: "bg-cyan-400",
    grad: "from-cyan-600 to-blue-600",
    iconBg: "bg-cyan-500/15",
    iconBorder: "border border-cyan-500/30",
    badgeBg: "bg-cyan-500/20",
    activeBg: "bg-cyan-500/15",
    activeBorder: "border-cyan-500/50",
    panelBg: "bg-cyan-500/[0.06]",
    panelBorder: "border-cyan-500/20",
    headerGrad: "from-cyan-950/50 via-blue-950/25 to-transparent",
    outlineBtn: "border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10",
    solidBtn: "bg-cyan-600 hover:bg-cyan-500",
    focusBorder: "focus:border-cyan-500/50",
    cardGlow: "shadow-cyan-950/40",
  },
  violet: {
    text: "text-violet-300",
    dot: "bg-violet-400",
    grad: "from-violet-600 to-purple-600",
    iconBg: "bg-violet-500/15",
    iconBorder: "border border-violet-500/30",
    badgeBg: "bg-violet-500/20",
    activeBg: "bg-violet-500/15",
    activeBorder: "border-violet-500/50",
    panelBg: "bg-violet-500/[0.06]",
    panelBorder: "border-violet-500/20",
    headerGrad: "from-violet-950/50 via-purple-950/25 to-transparent",
    outlineBtn: "border-violet-500/30 text-violet-300 hover:bg-violet-500/10",
    solidBtn: "bg-violet-600 hover:bg-violet-500",
    focusBorder: "focus:border-violet-500/50",
    cardGlow: "shadow-violet-950/40",
  },
  amber: {
    text: "text-amber-300",
    dot: "bg-amber-400",
    grad: "from-amber-600 to-orange-600",
    iconBg: "bg-amber-500/15",
    iconBorder: "border border-amber-500/30",
    badgeBg: "bg-amber-500/20",
    activeBg: "bg-amber-500/15",
    activeBorder: "border-amber-500/50",
    panelBg: "bg-amber-500/[0.06]",
    panelBorder: "border-amber-500/20",
    headerGrad: "from-amber-950/50 via-orange-950/25 to-transparent",
    outlineBtn: "border-amber-500/30 text-amber-300 hover:bg-amber-500/10",
    solidBtn: "bg-amber-600 hover:bg-amber-500",
    focusBorder: "focus:border-amber-500/50",
    cardGlow: "shadow-amber-950/40",
  },
  emerald: {
    text: "text-emerald-300",
    dot: "bg-emerald-400",
    grad: "from-emerald-600 to-teal-600",
    iconBg: "bg-emerald-500/15",
    iconBorder: "border border-emerald-500/30",
    badgeBg: "bg-emerald-500/20",
    activeBg: "bg-emerald-500/15",
    activeBorder: "border-emerald-500/50",
    panelBg: "bg-emerald-500/[0.06]",
    panelBorder: "border-emerald-500/20",
    headerGrad: "from-emerald-950/50 via-teal-950/25 to-transparent",
    outlineBtn: "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10",
    solidBtn: "bg-emerald-600 hover:bg-emerald-500",
    focusBorder: "focus:border-emerald-500/50",
    cardGlow: "shadow-emerald-950/40",
  },
  indigo: {
    text: "text-indigo-300",
    dot: "bg-indigo-400",
    grad: "from-indigo-600 to-blue-700",
    iconBg: "bg-indigo-500/15",
    iconBorder: "border border-indigo-500/30",
    badgeBg: "bg-indigo-500/20",
    activeBg: "bg-indigo-500/15",
    activeBorder: "border-indigo-500/50",
    panelBg: "bg-indigo-500/[0.06]",
    panelBorder: "border-indigo-500/20",
    headerGrad: "from-indigo-950/50 via-blue-950/25 to-transparent",
    outlineBtn: "border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/10",
    solidBtn: "bg-indigo-600 hover:bg-indigo-500",
    focusBorder: "focus:border-indigo-500/50",
    cardGlow: "shadow-indigo-950/40",
  },
  sky: {
    text: "text-sky-300",
    dot: "bg-sky-400",
    grad: "from-sky-600 to-cyan-700",
    iconBg: "bg-sky-500/15",
    iconBorder: "border border-sky-500/30",
    badgeBg: "bg-sky-500/20",
    activeBg: "bg-sky-500/15",
    activeBorder: "border-sky-500/50",
    panelBg: "bg-sky-500/[0.06]",
    panelBorder: "border-sky-500/20",
    headerGrad: "from-sky-950/50 via-cyan-950/25 to-transparent",
    outlineBtn: "border-sky-500/30 text-sky-300 hover:bg-sky-500/10",
    solidBtn: "bg-sky-600 hover:bg-sky-500",
    focusBorder: "focus:border-sky-500/50",
    cardGlow: "shadow-sky-950/40",
  },
  rose: {
    text: "text-rose-300",
    dot: "bg-rose-400",
    grad: "from-rose-600 to-pink-600",
    iconBg: "bg-rose-500/15",
    iconBorder: "border border-rose-500/30",
    badgeBg: "bg-rose-500/20",
    activeBg: "bg-rose-500/15",
    activeBorder: "border-rose-500/50",
    panelBg: "bg-rose-500/[0.06]",
    panelBorder: "border-rose-500/20",
    headerGrad: "from-rose-950/50 via-pink-950/25 to-transparent",
    outlineBtn: "border-rose-500/30 text-rose-300 hover:bg-rose-500/10",
    solidBtn: "bg-rose-600 hover:bg-rose-500",
    focusBorder: "focus:border-rose-500/50",
    cardGlow: "shadow-rose-950/40",
  },
  teal: {
    text: "text-teal-300",
    dot: "bg-teal-400",
    grad: "from-teal-600 to-cyan-700",
    iconBg: "bg-teal-500/15",
    iconBorder: "border border-teal-500/30",
    badgeBg: "bg-teal-500/20",
    activeBg: "bg-teal-500/15",
    activeBorder: "border-teal-500/50",
    panelBg: "bg-teal-500/[0.06]",
    panelBorder: "border-teal-500/20",
    headerGrad: "from-teal-950/50 via-cyan-950/25 to-transparent",
    outlineBtn: "border-teal-500/30 text-teal-300 hover:bg-teal-500/10",
    solidBtn: "bg-teal-600 hover:bg-teal-500",
    focusBorder: "focus:border-teal-500/50",
    cardGlow: "shadow-teal-950/40",
  },
  fuchsia: {
    text: "text-fuchsia-300",
    dot: "bg-fuchsia-400",
    grad: "from-fuchsia-600 to-purple-700",
    iconBg: "bg-fuchsia-500/15",
    iconBorder: "border border-fuchsia-500/30",
    badgeBg: "bg-fuchsia-500/20",
    activeBg: "bg-fuchsia-500/15",
    activeBorder: "border-fuchsia-500/50",
    panelBg: "bg-fuchsia-500/[0.06]",
    panelBorder: "border-fuchsia-500/20",
    headerGrad: "from-fuchsia-950/50 via-purple-950/25 to-transparent",
    outlineBtn: "border-fuchsia-500/30 text-fuchsia-300 hover:bg-fuchsia-500/10",
    solidBtn: "bg-fuchsia-600 hover:bg-fuchsia-500",
    focusBorder: "focus:border-fuchsia-500/50",
    cardGlow: "shadow-fuchsia-950/40",
  },
  orange: {
    text: "text-orange-300",
    dot: "bg-orange-400",
    grad: "from-orange-600 to-amber-600",
    iconBg: "bg-orange-500/15",
    iconBorder: "border border-orange-500/30",
    badgeBg: "bg-orange-500/20",
    activeBg: "bg-orange-500/15",
    activeBorder: "border-orange-500/50",
    panelBg: "bg-orange-500/[0.06]",
    panelBorder: "border-orange-500/20",
    headerGrad: "from-orange-950/50 via-amber-950/25 to-transparent",
    outlineBtn: "border-orange-500/30 text-orange-300 hover:bg-orange-500/10",
    solidBtn: "bg-orange-600 hover:bg-orange-500",
    focusBorder: "focus:border-orange-500/50",
    cardGlow: "shadow-orange-950/40",
  },
  lime: {
    text: "text-lime-300",
    dot: "bg-lime-400",
    grad: "from-lime-600 to-emerald-600",
    iconBg: "bg-lime-500/15",
    iconBorder: "border border-lime-500/30",
    badgeBg: "bg-lime-500/20",
    activeBg: "bg-lime-500/15",
    activeBorder: "border-lime-500/50",
    panelBg: "bg-lime-500/[0.06]",
    panelBorder: "border-lime-500/20",
    headerGrad: "from-lime-950/50 via-emerald-950/25 to-transparent",
    outlineBtn: "border-lime-500/30 text-lime-300 hover:bg-lime-500/10",
    solidBtn: "bg-lime-600 hover:bg-lime-500",
    focusBorder: "focus:border-lime-500/50",
    cardGlow: "shadow-lime-950/40",
  },
};

export const BOT_ICON: Record<string, typeof Hash> = {
  hash: Hash,
  scale: Scale,
  crosshair: Crosshair,
  trend: TrendingUp,
  shield: ShieldCheck,
  lock: Lock,
  target: Target,
  zap: Zap,
  activity: Activity,
};

/** Synthetic markets a bot may be locked to (same catalogue the FAB offers). */
export const SCAN_MARKETS: { symbol: string; short: string; name: string; group: string }[] = [
  { symbol: "R_10",    short: "V10",  name: "Volatility 10 Index",       group: "V"  },
  { symbol: "R_25",    short: "V25",  name: "Volatility 25 Index",       group: "V"  },
  { symbol: "R_50",    short: "V50",  name: "Volatility 50 Index",       group: "V"  },
  { symbol: "R_75",    short: "V75",  name: "Volatility 75 Index",       group: "V"  },
  { symbol: "R_100",   short: "V100", name: "Volatility 100 Index",      group: "V"  },
  { symbol: "1HZ10V",  short: "1s10", name: "Volatility 10 (1s) Index",  group: "1s" },
  { symbol: "1HZ15V",  short: "1s15", name: "Volatility 15 (1s) Index",  group: "1s" },
  { symbol: "1HZ25V",  short: "1s25", name: "Volatility 25 (1s) Index",  group: "1s" },
  { symbol: "1HZ30V",  short: "1s30", name: "Volatility 30 (1s) Index",  group: "1s" },
  { symbol: "1HZ50V",  short: "1s50", name: "Volatility 50 (1s) Index",  group: "1s" },
  { symbol: "1HZ75V",  short: "1s75", name: "Volatility 75 (1s) Index",  group: "1s" },
  { symbol: "1HZ90V",  short: "1s90", name: "Volatility 90 (1s) Index",  group: "1s" },
  { symbol: "1HZ100V", short: "1s1",  name: "Volatility 100 (1s) Index", group: "1s" },
  { symbol: "JD10",    short: "J10",  name: "Jump 10 Index",             group: "J"  },
  { symbol: "JD25",    short: "J25",  name: "Jump 25 Index",             group: "J"  },
  { symbol: "JD50",    short: "J50",  name: "Jump 50 Index",             group: "J"  },
  { symbol: "JD75",    short: "J75",  name: "Jump 75 Index",             group: "J"  },
  { symbol: "RDBULL",  short: "Bull", name: "Bull Market Index",         group: "I"  },
  { symbol: "RDBEAR",  short: "Bear", name: "Bear Market Index",         group: "I"  },
];

export const SCAN_MARKET_COUNT = SCAN_MARKETS.length;
