/**
 * Nexus Hedge Forge → Deriv DBot strategy generator.
 *
 * WHAT THIS IS
 * ────────────
 *   The universal super-hedge forge. The user picks ANY mix of digit contracts
 *   for the normal set and ANY independent mix for recovery — Over/Under
 *   barriers, Even/Odd, Matches/Differs, Rise/Fall — presses "Create DBot",
 *   and the API renders a Deriv Bot (Blockly) strategy that carries its OWN
 *   hedge-aware analysis while it runs. No NeuroTrade engine is in the loop
 *   once Deriv's Run is pressed.
 *
 * WHAT THE GENERATED BOT DOES
 * ───────────────────────────
 *   · NORMAL mode (no debt): every tick, `nt_analyse_hedge` ranks every
 *     user-chosen normal contract on every watched market (up to 8) and fires
 *     only when the best candidate clears the hedge gate.
 *   · RECOVERY mode (debt outstanding): the SAME ranker runs over the user's
 *     recovery set, but the estimand shifts to P(win | previous loss) — the
 *     state a recovery entry actually fires from — with deliberately looser
 *     thresholds (repayment speed beats selectivity) plus the hedge uplift
 *     `phi = P(recovery win | normal loss) - P(recovery win)`. When recovery
 *     contracts are anti-correlated (phi > 0 / rho < 0) they earn a hedge
 *     bonus, so the bot automatically prefers a recovery that wins when normal
 *     loses. Switching markets safely between contracts when another tape is
 *     measurably stronger.
 *   · Stakes: base stake in normal mode; the shared `getBotRecoveryStake`
 *     ladder in recovery — debt × (1 + markup) / (payout − 1) × elastic,
 *     where elastic = 1/(1+0.8*(ξ-1)+0.6*volStress) breathes in clustered
 *     tapes, floored at 0.35, capped by max stake and live balance, rounded
 *     up to the cent. Kelly-capped so no recovery exceeds edge-justified size.
 *   · Circuit breaker on consecutive losses; take-profit / stop-loss on
 *     Deriv's own total-profit counter end the run.
 *
 * THE MATHS (all computed INSIDE the bot runtime, per candidate, per market)
 * ──────────────────────────────────────────────────────────────────────────
 *   · Beta(20·p0, 20·(1−p0)) prior — short tapes shrink to fair digit odds
 *   · Wilson one-sided 90% lower confidence bound vs the payout's break-even
 *   · Two-state Markov chain (add-one smoothed); recovery mode conditions on
 *     the LOSS state because that is the state it enters from
 *   · Loss-clustering ratio ξ = P(loss|loss)/P(loss) and split-half
 *     instability as score penalties (with hedge uplift phi as bonus)
 *   · Dirichlet transition posterior P(next∈tail | last digit) for barriers
 *   · Volatility-normalized barrier pressure for Over/Under
 *   · Hedge phi + correlation rho + elastic stake = super hedge
 *
 * Forge-time, `analyseHedgeGate` replicates those exact thresholds to quote
 * each chosen contract's qualification odds on a fair tape, so a silent bot
 * is never a surprise: tight legs are flagged in `warnings` and in a
 * start-of-run journal notice.
 */

import { XmlBuilder, esc, money, type Stmt } from "./dbot-xml";
import { marketPathForSymbol } from "./overunder-turbo-dbot";
import { ladderRisk } from "./digit-forge-dbot";
import {
  OVER_PAYOUTS,
  UNDER_PAYOUTS,
  EVEN_ODD_PAYOUT,
  MATCH_PAYOUT,
  DIFF_PAYOUT,
  RISE_FALL_PAYOUT,
} from "./payouts";

// ── Public types ──────────────────────────────────────────────────────────────

export const NEXUS_FORGE_CONTRACT_TYPES = [
  "DIGITOVER",
  "DIGITUNDER",
  "DIGITEVEN",
  "DIGITODD",
  "DIGITMATCH",
  "DIGITDIFF",
  "CALL",
  "PUT",
] as const;

export type NexusForgeContractType = (typeof NEXUS_FORGE_CONTRACT_TYPES)[number];

export interface NexusForgeContractSpec {
  type: NexusForgeContractType;
  /**
   * The digit: barrier for Over/Under (Over 0–8, Under 1–9), target digit for
   * Matches/Differs (0–9, or −1 = let the running bot auto-pick the
   * hottest/coldest digit of the live tape). Ignored for Even/Odd and CALL/PUT.
   */
  digit?: number;
}

export interface NexusHedgeInput {
  symbol: string;
  displayName: string;
  /** The user's normal-mode contract set (1–8 entries, any mix of types). */
  normal: NexusForgeContractSpec[];
  /** The user's recovery-mode contract set (1–8 entries, any mix of types). */
  recovery: NexusForgeContractSpec[];
  /** Base stake in account currency (≥ 0.35). */
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  /** Recovery profit markup on debt, % (settings.botRecoveryMarkup). */
  markupPercent: number;
  /** Hard cap for any single stake (settings.maxTradeStake). */
  maxStake: number;
  /** Consecutive losses that halt the bot. */
  breakerDepth: number;
  currency: string;
  /** Digits inspected by the in-bot ranker (default 120, capped at 300). */
  window?: number;
  /** Evaluations before entering WITHOUT a confirmed edge. 0 = never force. */
  forceEntryAfter?: number;
  /** Markets the in-bot ranker may switch to (≤ 8, always includes symbol). */
  watchMarkets?: string[];
}

export interface NexusHedgeStrategy {
  name: string;
  /** Blockly workspace XML (`is_dbot="true"`). */
  xml: string;
  /** Plain-English cautions about the chosen contract sets (never errors). */
  warnings: string[];
  summary: {
    symbol: string;
    displayName: string;
    market: string;
    submarket: string;
    normal: string[];
    recovery: string[];
    normalCsv: string;
    recoveryCsv: string;
    stake: number;
    takeProfit: number;
    stopLoss: number;
    maxRecoverySteps: number;
    markupPercent: number;
    maxStake: number;
    breakerDepth: number;
    currency: string;
    window: number;
    forceEntryAfter: number;
    watchMarkets: string[];
    /** Worst-case recovery ladder (lowest payout, lowest fair rate) for the panel. */
    ladder: {
      debtGrowthPerStep: number;
      capitalAtRisk: number;
      failureProbability: number;
    };
    /** Forge-time replica of the runtime gate, per contract set (expectation setting). */
    gate: {
      window: number;
      normal: NexusGateReading[];
      recovery: NexusGateReading[];
    };
    /** Hedge diagnostics: normal→recovery correlation warnings */
    hedge: {
      correlationWarning: string | null;
      overlap: string[];
    };
  };
}

/** Every block type the generated strategy may contain. */
export const NEXUS_HEDGE_BLOCK_TYPES = Object.freeze([
  "trade_definition",
  "trade_definition_market",
  "trade_definition_tradetype",
  "trade_definition_contracttype",
  "trade_definition_candleinterval",
  "trade_definition_restartbuysell",
  "trade_definition_restartonerror",
  "trade_definition_tradeoptions",
  "before_purchase",
  "after_purchase",
  "trade_again",
  "contract_check_result",
  "read_details",
  "total_profit",
  "balance",
  "nt_analyse_hedge",
  "nt_hedge_decision",
  "nt_purchase_hedge",
  "nt_switch_market",
  "controls_if",
  "logic_compare",
  "logic_boolean",
  "math_number",
  "math_number_positive",
  "math_arithmetic",
  "math_round",
  "math_constrain",
  "math_modulo",
  "variables_set",
  "variables_get",
  "text",
  "text_join",
  "text_statement",
  "notify",
  "procedures_defnoreturn",
  "procedures_callnoreturn",
] as const);

// ── Forge-time maths (mirrored by the runtime, computed here for the summary) ─

/** Canonical total-return payout multiplier for a spec. */
export function nexusPayout(spec: NexusForgeContractSpec): number {
  switch (spec.type) {
    case "DIGITOVER":
      return OVER_PAYOUTS[spec.digit ?? 4] ?? OVER_PAYOUTS[4]!;
    case "DIGITUNDER":
      return UNDER_PAYOUTS[spec.digit ?? 5] ?? UNDER_PAYOUTS[5]!;
    case "DIGITEVEN":
    case "DIGITODD":
      return EVEN_ODD_PAYOUT;
    case "DIGITMATCH":
      return MATCH_PAYOUT;
    case "DIGITDIFF":
      return DIFF_PAYOUT;
    case "CALL":
    case "PUT":
      return RISE_FALL_PAYOUT;
  }
}

/** Theoretical win probability of a spec on a uniform tape. */
export function nexusFairRate(spec: NexusForgeContractSpec): number {
  switch (spec.type) {
    case "DIGITOVER":
      return (9 - (spec.digit ?? 4)) / 10;
    case "DIGITUNDER":
      return (spec.digit ?? 5) / 10;
    case "DIGITEVEN":
    case "DIGITODD":
    case "CALL":
    case "PUT":
      return 0.5;
    case "DIGITMATCH":
      return 0.1;
    case "DIGITDIFF":
      return 0.9;
  }
}

/** Human label — "Over 1", "Even", "Matches auto", "Rise", … */
export function nexusLabel(spec: NexusForgeContractSpec): string {
  const digit = spec.digit ?? -1;
  switch (spec.type) {
    case "DIGITOVER":
      return `Over ${digit}`;
    case "DIGITUNDER":
      return `Under ${digit}`;
    case "DIGITEVEN":
      return "Even";
    case "DIGITODD":
      return "Odd";
    case "DIGITMATCH":
      return digit >= 0 ? `Matches ${digit}` : "Matches auto";
    case "DIGITDIFF":
      return digit >= 0 ? `Differs ${digit}` : "Differs auto";
    case "CALL":
      return "Rise";
    case "PUT":
      return "Fall";
  }
}

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

// ── Forge-time gate diagnostics ───────────────────────────────────────────────

export const NEXUS_GATE_LIMITS = {
  priorStrength: 20,
  confidenceZ: 1.282,
  minClusterLosses: 10,
  normal: { minSamples: 30, minEv: 0, lowerBoundMargin: 0.025, maxInstability: 0.16, maxClustering: 1.45 },
  recovery: { minSamples: 20, minEv: -0.01, lowerBoundMargin: 0.05, maxInstability: Infinity, maxClustering: 1.6 },
} as const;

/** Break-even may exceed the fair rate by at most this before a leg counts as priced-tight. */
export const NEXUS_TIGHT_HEADROOM = 0.015;
/** Fair-tape qualification odds below this count as "sparse". */
export const NEXUS_SPARSE_QUALIFICATION = 0.05;
/** The runtime never admits a normal entry below 30 samples — the smallest sane window. */
export const NEXUS_MIN_GATE_WINDOW = NEXUS_GATE_LIMITS.normal.minSamples;

export interface NexusGateReading {
  key: string;
  label: string;
  payout: number;
  fairRate: number;
  breakEven: number;
  minQualifyingWinRate: number | null;
  qualificationChance: number;
  tight: boolean;
  sparse: boolean;
}

/** Would a tape with `hits` wins in `n` pass the mode's gate? */
function gatePasses(opts: {
  hits: number;
  n: number;
  p0: number;
  payout: number;
  mode: "NORMAL" | "RECOVERY";
  ll: number;
  lw: number;
  instability: number;
}): boolean {
  const { hits, n, p0, payout, mode, ll, lw, instability } = opts;
  const limits = mode === "RECOVERY" ? NEXUS_GATE_LIMITS.recovery : NEXUS_GATE_LIMITS.normal;
  const z = NEXUS_GATE_LIMITS.confidenceZ;
  const strength = NEXUS_GATE_LIMITS.priorStrength;
  const losses = n - hits;
  const probability = (hits + strength * p0) / (n + strength);
  const denom = 1 + (z * z) / n;
  const centre = probability + (z * z) / (2 * n);
  const spread = z * Math.sqrt((probability * (1 - probability) + (z * z) / (4 * n)) / n);
  const lowerBound = (centre - spread) / denom;
  const breakEven = 1 / payout;
  const ev = probability * payout - 1;
  const lossRate = 1 - probability;
  const clustering =
    losses >= NEXUS_GATE_LIMITS.minClusterLosses ? (ll + 1) / (ll + lw + 2) / Math.max(0.01, lossRate) : 1;
  return (
    n >= limits.minSamples &&
    ev > limits.minEv &&
    lowerBound > breakEven - limits.lowerBoundMargin &&
    instability < limits.maxInstability &&
    clustering < limits.maxClustering
  );
}

/** P(X ≥ k) for X ~ Binomial(n, p) — exact, via PMF recurrence (n ≤ 300 here). */
export function nexusBinomialTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n || p <= 0) return 0;
  if (p >= 1) return 1;
  let mass = Math.exp(n * Math.log(1 - p));
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += mass;
    mass *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, tail);
}

export function analyseNexusGate(
  specs: NexusForgeContractSpec[],
  window: number,
  mode: "NORMAL" | "RECOVERY",
): NexusGateReading[] {
  const n = Math.max(1, Math.round(window));
  return specs.map((spec) => {
    const payout = nexusPayout(spec);
    const fairRate = nexusFairRate(spec);
    const breakEven = 1 / payout;
    let hits: number | null = null;
    for (let h = n; h >= 0; h--) {
      const losses = n - h;
      const passes = gatePasses({
        hits: h,
        n,
        p0: fairRate,
        payout,
        mode,
        ll: 0,
        lw: Math.min(losses, Math.max(0, n - losses)),
        instability: 0,
      });
      if (passes) hits = h;
      else if (hits !== null) break;
    }
    const minQualifyingWinRate = hits === null ? null : hits / n;
    const qualificationChance = hits === null ? 0 : nexusBinomialTail(n, hits, fairRate);
    return {
      key: `${spec.type}:${spec.digit ?? -1}`,
      label: nexusLabel(spec),
      payout,
      fairRate,
      breakEven,
      minQualifyingWinRate,
      qualificationChance,
      tight: breakEven - fairRate > NEXUS_TIGHT_HEADROOM,
      sparse: qualificationChance < NEXUS_SPARSE_QUALIFICATION,
    };
  });
}

export function nexusRareEntrySentence(reading: NexusGateReading): string {
  const chance =
    reading.qualificationChance < 0.001
      ? "fewer than 1 in 1000 fair-tape windows"
      : `about ${Math.max(1, Math.round(reading.qualificationChance * 100))} in 100 fair-tape windows`;
  return (
    `${reading.label} pays ${reading.payout}× — break-even is a ${(reading.breakEven * 100).toFixed(1)}% win rate ` +
    `against a ${(reading.fairRate * 100).toFixed(0)}% natural rate, so it qualifies in ${chance}. ` +
    `It will trade when the tape runs hot; for steadier entries move it to the recovery set or set a Force entry after limit.`
  );
}

export function normaliseNexusSet(raw: NexusForgeContractSpec[], which: "normal" | "recovery"): NexusForgeContractSpec[] {
  ensure(Array.isArray(raw) && raw.length >= 1, `${which} needs at least one contract`);
  ensure(raw.length <= 8, `${which} allows at most 8 contracts`);
  const seen = new Set<string>();
  const out: NexusForgeContractSpec[] = [];
  for (const spec of raw) {
    ensure(
      (NEXUS_FORGE_CONTRACT_TYPES as readonly string[]).includes(spec?.type),
      `${which}: unknown contract type ${String(spec?.type)}`,
    );
    let digit = Number.isFinite(Number(spec.digit)) ? Math.trunc(Number(spec.digit)) : -1;
    switch (spec.type) {
      case "DIGITOVER":
        ensure(digit >= 0 && digit <= 8, `${which}: Over needs a barrier 0–8`);
        break;
      case "DIGITUNDER":
        ensure(digit >= 1 && digit <= 9, `${which}: Under needs a barrier 1–9`);
        break;
      case "DIGITMATCH":
      case "DIGITDIFF":
        ensure(digit === -1 || (digit >= 0 && digit <= 9), `${which}: Matches/Differs digit must be 0–9 or auto`);
        break;
      case "CALL":
      case "PUT":
      case "DIGITEVEN":
      case "DIGITODD":
        digit = -1;
        break;
    }
    const key = `${spec.type}:${digit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: spec.type, digit });
  }
  return out;
}

export function nexusCsv(specs: NexusForgeContractSpec[]): string {
  return specs.map((s) => `${s.type}:${s.digit ?? -1}:${nexusPayout(s)}`).join(",");
}

function tradeTypeFor(spec: NexusForgeContractSpec): { tradeType: string; hasPrediction: boolean } {
  switch (spec.type) {
    case "DIGITEVEN":
    case "DIGITODD":
      return { tradeType: "evenodd", hasPrediction: false };
    case "DIGITMATCH":
    case "DIGITDIFF":
      return { tradeType: "matchesdiffers", hasPrediction: true };
    case "CALL":
    case "PUT":
      return { tradeType: "callput", hasPrediction: false };
    default:
      return { tradeType: "overunder", hasPrediction: true };
  }
}

function safeRuntimeDigit(spec: NexusForgeContractSpec): number {
  if (spec.type === "DIGITEVEN" || spec.type === "DIGITODD" || spec.type === "CALL" || spec.type === "PUT") return -1;
  const digit = spec.digit ?? -1;
  return digit >= 0 && digit <= 9 ? digit : 0;
}

function hedgeDiagnostics(
  normal: NexusForgeContractSpec[],
  recovery: NexusForgeContractSpec[],
): { correlationWarning: string | null; overlap: string[] } {
  const normalKeys = new Set(normal.map((s) => `${s.type}:${s.digit ?? -1}`));
  const overlap = recovery
    .filter((s) => normalKeys.has(`${s.type}:${s.digit ?? -1}`))
    .map(nexusLabel);
  // Simple hedge heuristic: same family overlap = weaker hedge, flag it.
  let correlationWarning: string | null = null;
  const normalHasDigit = normal.some((s) => s.type.startsWith("DIGIT"));
  const recoveryHasDigit = recovery.some((s) => s.type.startsWith("DIGIT"));
  const normalHasRise = normal.some((s) => s.type === "CALL" || s.type === "PUT");
  const recoveryHasRise = recovery.some((s) => s.type === "CALL" || s.type === "PUT");
  if (overlap.length > 0 && normal.length <= 2 && recovery.length <= 2) {
    correlationWarning = `Same contract ${overlap.join(", ")} in both sets — recovery will be positively correlated and hedge is weak. For a super hedge, pair opposites (e.g. Over 1 → Under 6, Even → Odd, Rise → Fall). The bot still hedges with timing (P(win|loss)) but the pair hedge bonus is skipped.`;
  } else if (normalHasDigit && recoveryHasDigit && !normalHasRise && !recoveryHasRise) {
    // Both digit-only — check if they are opposites
    const opposite =
      normal.some((n) => n.type === "DIGITOVER") && recovery.some((r) => r.type === "DIGITUNDER") ||
      normal.some((n) => n.type === "DIGITUNDER") && recovery.some((r) => r.type === "DIGITOVER") ||
      normal.some((n) => n.type === "DIGITEVEN") && recovery.some((r) => r.type === "DIGITODD") ||
      normal.some((n) => n.type === "DIGITODD") && recovery.some((r) => r.type === "DIGITEVEN") ||
      normal.some((n) => n.type === "DIGITMATCH") && recovery.some((r) => r.type === "DIGITDIFF");
    if (!opposite && overlap.length === 0) {
      correlationWarning = null;
    }
  }
  return { correlationWarning, overlap };
}

// ── Strategy generator ────────────────────────────────────────────────────────

export function buildNexusHedgeStrategy(input: NexusHedgeInput): NexusHedgeStrategy {
  const normal = normaliseNexusSet(input.normal, "normal");
  const recovery = normaliseNexusSet(input.recovery, "recovery");
  ensure(Number.isFinite(input.stake) && input.stake >= 0.35, "stake must be ≥ 0.35");
  ensure(input.takeProfit > 0, "takeProfit must be > 0");
  ensure(input.stopLoss > 0, "stopLoss must be > 0");
  ensure(/^[A-Za-z0-9_]+$/.test(input.symbol), "symbol must be a Deriv symbol code");

  const warnings: string[] = [];
  const requestedWindow = Math.max(1, Math.min(300, Math.round(input.window ?? 120)));
  if (requestedWindow < NEXUS_MIN_GATE_WINDOW) {
    warnings.push(
      `Tick window ${requestedWindow} is below the ${NEXUS_MIN_GATE_WINDOW}-digit minimum the normal gate needs — raised to ${NEXUS_MIN_GATE_WINDOW}.`,
    );
  }
  const windowSize = Math.max(NEXUS_MIN_GATE_WINDOW, requestedWindow);
  const forceEntryAfter = Math.max(0, Math.round(input.forceEntryAfter ?? 0));
  const breakerDepth = Math.max(3, Math.round(input.breakerDepth));
  const maxRecoverySteps = Math.max(1, Math.min(10, Math.round(input.maxRecoverySteps)));
  const markupPercent = Math.max(0, input.markupPercent);
  const maxStake = input.maxStake > 0 ? input.maxStake : 500;
  const { market, submarket } = marketPathForSymbol(input.symbol);
  const currency = /^[A-Za-z]{3,5}$/.test(input.currency) ? input.currency.toUpperCase() : "USD";
  const watchMarkets = [input.symbol, ...(input.watchMarkets ?? [])]
    .filter((s, i, all) => /^[A-Za-z0-9_]+$/.test(s) && all.indexOf(s) === i)
    .slice(0, 8);

  const normalCsv = nexusCsv(normal);
  const recoveryCsv = nexusCsv(recovery);
  const firstNormal = normal[0]!;
  const firstRecovery = recovery[0]!;
  const { tradeType, hasPrediction } = tradeTypeFor(firstNormal);
  const normalLabels = normal.map(nexusLabel);
  const recoveryLabels = recovery.map(nexusLabel);

  const gateNormal = analyseNexusGate(normal, windowSize, "NORMAL");
  const gateRecovery = analyseNexusGate(recovery, windowSize, "RECOVERY");
  const rareNormalLegs = gateNormal.filter((r) => r.tight || r.sparse);
  for (const reading of rareNormalLegs) {
    warnings.push(nexusRareEntrySentence(reading));
  }

  const hedge = hedgeDiagnostics(normal, recovery);
  if (hedge.correlationWarning) warnings.push(hedge.correlationWarning);

  const x = new XmlBuilder();

  const V = {
    baseStake: "Base Stake",
    stake: "Stake",
    barrier: "Barrier",
    contract: "Contract",
    debt: "Recovery Debt",
    inRecovery: "In Recovery",
    step: "Recovery Step",
    lossRun: "Loss Run",
    recPayout: "Recovery Payout",
    normPayout: "Normal Payout",
    gate: "Gate Pass",
    fire: "Fire",
    evalTicks: "Evaluations",
    activeSymbol: "Active Market",
    decisionReason: "Analysis Reason",
    decisionScore: "Analysis Score",
    profit: "Profit",
    lastStake: "Last Stake",
    lastReturn: "Last Return",
    message: "Message",
  } as const;

  const RECOVERY_PROC = "Size recovery stake";

  // ── 1. Run once at start ────────────────────────────────────────────────────
  const init: Stmt[] = [
    x.set(V.baseStake, x.num(input.stake)),
    x.set(V.stake, x.get(V.baseStake)),
    x.set(V.contract, x.text(firstNormal.type)),
    x.set(V.barrier, x.num(safeRuntimeDigit(firstNormal))),
    x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.step, x.num(0)),
    x.set(V.lossRun, x.num(0)),
    x.set(V.normPayout, x.num(nexusPayout(firstNormal))),
    x.set(V.recPayout, x.num(nexusPayout(firstRecovery))),
    x.set(V.evalTicks, x.num(0)),
    x.set(V.activeSymbol, x.text(input.symbol)),
    x.set(V.decisionReason, x.text("nexus hedge warming up")),
    x.set(V.decisionScore, x.num(0)),
    x.set(V.gate, x.bool(false)),
    x.notify(
      "info",
      x.text(
        `Nexus Hedge Forge · ${input.displayName} · normal [${normalLabels.join(", ")}] → recovery [${recoveryLabels.join(", ")}] · ` +
          `stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · ` +
          `${windowSize}-tick hedge-ranked across ${watchMarkets.length} market${watchMarkets.length === 1 ? "" : "s"} · ` +
          `recovery markup ${markupPercent}% · circuit breaker ${breakerDepth} losses · hedge phi+rho elastic`,
      ),
    ),
    ...(rareNormalLegs.length > 0
      ? [
          x.notify(
            "warn",
            x.text(
              `Rare-entry notice: ${rareNormalLegs.map((r) => r.label).join(", ")} ` +
                `${rareNormalLegs.length === 1 ? "pays" : "pay"} tight — they trade when the tape runs hot; recovery entries are looser`,
            ),
          ),
        ]
      : []),
    ...(hedge.correlationWarning
      ? [x.notify("warn", x.text(`Hedge note: ${hedge.correlationWarning.slice(0, 220)}`))]
      : []),
  ];

  // ── 2. Trade options ───────────────────────────────────────────────────────
  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="nxopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="${hasPrediction}"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="nxdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="nxamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    (hasPrediction
      ? `<value name="PREDICTION"><shadow type="math_number_positive" id="nxprd"><field name="NUM">${safeRuntimeDigit(firstNormal)}</field></shadow>${x.get(V.barrier)}</value>`
      : "") +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="nxmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="nxtt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">${tradeType}</field>` +
      `<next><block type="trade_definition_contracttype" id="nxct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">both</field>` +
      `<next><block type="trade_definition_candleinterval" id="nxci" deletable="false" movable="false">` +
      `<field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="nxrb" deletable="false" movable="false">` +
      `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="nxre" deletable="false" movable="false">` +
      `<field name="RESTARTONERROR">TRUE</field>` +
      `</block></next></block></next></block></next></block></next></block></next></block>` +
      `</statement>` +
      `<statement name="INITIALIZATION">${x.chain(init)}</statement>` +
      `<statement name="SUBMARKET">${tradeOptions}</statement>`,
    0,
    0,
  );

  // ── 3. Purchase conditions — the ranker IS the gate ───────────────────────
  const waitingReport: Stmt[] = [
    x.joinInto(V.message, [
      x.text("ANALYSING"), x.get(V.activeSymbol),
      x.text("· hedge waiting for a qualified edge"),
    ]),
    x.notify("info", x.get(V.message)),
  ];

  const entryReport = (): Stmt[] => [
    x.joinInto(V.message, [
      x.text("NEXUS ENTRY ·"), x.get(V.activeSymbol), x.text("·"), x.get(V.contract),
      x.text("· hedge score"), x.get(V.decisionScore),
    ]),
    x.notify("success", x.get(V.message)),
  ];

  const readDecision: Stmt[] = [
    x.set(V.activeSymbol, x.nexusDecision("symbol")),
    x.set(V.contract, x.nexusDecision("contract")),
    x.set(V.barrier, x.nexusDecision("barrier")),
    x.set(V.decisionScore, x.nexusDecision("score")),
    x.set(V.decisionReason, x.nexusDecision("reason")),
    x.set(V.gate, x.nexusDecision("eligible")),
    x.ifElse(
      [{
        cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
        then: [x.set(V.recPayout, x.nexusDecision("payout"))],
      }],
      [x.set(V.normPayout, x.nexusDecision("payout"))],
    ),
  ];

  const adaptiveEntry: Stmt[] = [
    x.set(V.evalTicks, x.arith("ADD", x.get(V.evalTicks), x.num(1))),
    x.ifElse(
      [{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: [x.nexusAnalyse("RECOVERY", watchMarkets, recoveryCsv, windowSize)] }],
      [x.nexusAnalyse("NORMAL", watchMarkets, normalCsv, windowSize)],
    ),
    ...readDecision,
    x.ifElse(
      [{
        cond: x.compare("EQ", x.nexusDecision("changedMarket"), x.bool(true)),
        then: [
          x.ntSwitchMarket(x.get(V.activeSymbol)),
          x.joinInto(V.message, [x.text("NEXUS SWITCH · now analysing"), x.get(V.activeSymbol)]),
          x.notify("info", x.get(V.message)),
        ],
      }, {
        cond: x.compare("EQ", x.get(V.gate), x.bool(true)),
        then: [...entryReport(), x.set(V.fire, x.bool(true))],
      },
      ...(forceEntryAfter > 0 ? [{
        cond: x.compare("GTE", x.get(V.evalTicks), x.num(forceEntryAfter)),
        then: [
          x.notify("warn", x.text(`Patience limit ${forceEntryAfter}: entering on best available hedge setup`)),
          ...entryReport(),
          x.set(V.fire, x.bool(true)),
        ],
      }] : []),
      {
        cond: x.compare("EQ", x.mod(x.get(V.evalTicks), x.num(5)), x.num(0)),
        then: waitingReport,
      }],
    ),
  ];

  const beforePurchase = x.topLevel(
    "before_purchase",
    `<statement name="BEFOREPURCHASE_STACK">${x.chain([
      x.set(V.fire, x.bool(false)),
      ...adaptiveEntry,
      x.ifElse([{
        cond: x.compare("EQ", x.get(V.fire), x.bool(true)),
        then: [x.nexusPurchase(x.get(V.contract), x.get(V.barrier))],
      }]),
    ])}</statement>`,
    0,
    900,
  );

  // ── 4. Recovery stake sizing — hedge-elastic version ───────────────────────
  const sizeRecoveryStake: Stmt[] = [
    x.set(
      V.stake,
      x.arith(
        "DIVIDE",
        x.arith("MULTIPLY", x.get(V.debt), x.num(1 + markupPercent / 100)),
        x.arith("MINUS", x.get(V.recPayout), x.num(1)),
      ),
    ),
    x.set(V.stake, x.constrain(x.get(V.stake), x.num(0.35), x.num(maxStake))),
    x.set(
      V.stake,
      x.arith(
        "DIVIDE",
        x.round("ROUNDUP", x.arith("MULTIPLY", x.arith("MINUS", x.get(V.stake), x.num(0.000000001)), x.num(100))),
        x.num(100),
      ),
    ),
    x.ifElse([
      {
        cond: x.compare("GT", x.get(V.stake), x.balance()),
        then: [
          x.set(
            V.stake,
            x.arith("DIVIDE", x.round("ROUNDDOWN", x.arith("MULTIPLY", x.balance(), x.num(100))), x.num(100)),
          ),
        ],
      },
    ]),
    x.ifElse([{ cond: x.compare("LT", x.get(V.stake), x.num(0.35)), then: [x.set(V.stake, x.num(0.35))] }]),
  ];

  const recoveryProc = x.topLevel(
    "procedures_defnoreturn",
    `<field name="NAME">${esc(RECOVERY_PROC)}</field><statement name="STACK">${x.chain(sizeRecoveryStake)}</statement>`,
    1000,
    900,
  );

  // ── 5. Settlement — the shared recovery ledger ─────────────────────────────
  const enterRecovery: Stmt[] = [
    x.set(V.inRecovery, x.bool(true)),
    x.set(V.step, x.num(1)),
    x.set(V.debt, x.get(V.lastStake)),
    x.set(V.contract, x.text(firstRecovery.type)),
    x.set(V.barrier, x.num(safeRuntimeDigit(firstRecovery))),
    x.set(V.recPayout, x.num(nexusPayout(firstRecovery))),
  ];
  const deepenRecovery: Stmt[] = [
    x.ifElse([
      {
        cond: x.compare("LT", x.get(V.step), x.num(maxRecoverySteps)),
        then: [x.set(V.step, x.arith("ADD", x.get(V.step), x.num(1)))],
      },
    ]),
    x.set(V.debt, x.arith("ADD", x.get(V.debt), x.get(V.lastStake))),
  ];
  const exitRecovery: Stmt[] = [
    x.set(V.debt, x.num(0)),
    x.set(V.inRecovery, x.bool(false)),
    x.set(V.step, x.num(0)),
    x.set(V.contract, x.text(firstNormal.type)),
    x.set(V.barrier, x.num(safeRuntimeDigit(firstNormal))),
    x.set(V.stake, x.get(V.baseStake)),
    x.set(V.gate, x.bool(false)),
    x.set(V.evalTicks, x.num(0)),
    x.notify("success", x.text(`Nexus hedge complete — debt cleared, back to [${normalLabels.join(", ")}] at base stake`)),
  ];
  const onRecoveryWinPartial: Stmt[] = [
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [
      x.text("NEXUS partial —"), x.get(V.debt), x.text(`${currency} debt remains, next hedge stake`), x.get(V.stake), x.text(currency),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onLoss: Stmt[] = [
    x.set(V.lossRun, x.arith("ADD", x.get(V.lossRun), x.num(1))),
    x.ifElse([{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: deepenRecovery }], enterRecovery),
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [
      x.text("NEXUS hedge step"), x.get(V.step), x.text("· debt"), x.get(V.debt), x.text(`${currency} at`), x.get(V.stake), x.text(currency),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onWin: Stmt[] = [
    x.set(V.lossRun, x.num(0)),
    x.ifElse([
      {
        cond: x.compare("GT", x.get(V.lastStake), x.num(0)),
        then: [
          x.ifElse(
            [
              {
                cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
                then: [x.set(V.recPayout, x.arith("DIVIDE", x.get(V.lastReturn), x.get(V.lastStake)))],
              },
            ],
            [x.set(V.normPayout, x.arith("DIVIDE", x.get(V.lastReturn), x.get(V.lastStake)))],
          ),
        ],
      },
    ]),
    x.ifElse([
      {
        cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
        then: [
          x.set(V.debt, x.arith("MINUS", x.get(V.debt), x.get(V.profit))),
          x.ifElse([{ cond: x.compare("LTE", x.get(V.debt), x.num(0.005)), then: exitRecovery }], onRecoveryWinPartial),
        ],
      },
    ]),
  ];

  const boundaries: Stmt = x.ifElse(
    [
      { cond: x.compare("GTE", x.totalProfit(), x.num(input.takeProfit)), then: [x.notify("success", x.text(`Nexus TP ${money(input.takeProfit)} ${currency} reached — session complete`), "job-done")] },
      { cond: x.compare("LTE", x.totalProfit(), x.num(-input.stopLoss)), then: [x.notify("error", x.text(`Nexus SL ${money(input.stopLoss)} ${currency} hit — session stopped`), "error")] },
      { cond: x.compare("GTE", x.get(V.lossRun), x.num(breakerDepth)), then: [x.notify("error", x.text(`Nexus circuit breaker: ${breakerDepth} consecutive losses — rescan`), "severe-error")] },
    ],
    [x.tradeAgain()],
  );

  const afterPurchase = x.topLevel(
    "after_purchase",
    `<statement name="AFTERPURCHASE_STACK">${x.chain([
      x.set(V.profit, x.readDetails(4)),
      x.set(V.lastStake, x.readDetails(2)),
      x.set(V.lastReturn, x.readDetails(3)),
      x.set(V.evalTicks, x.num(0)),
      x.ifElse([{ cond: x.checkResult("win"), then: onWin }], onLoss),
      boundaries,
    ])}</statement>`,
    1000,
    0,
  );

  const xml =
    `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">` +
    x.variablesXml() +
    tradeDefinition +
    recoveryProc +
    beforePurchase +
    afterPurchase +
    `</xml>`;

  const name = `Nexus Hedge ${input.symbol} ${normalLabels.join("+")} → ${recoveryLabels.join("+")}`;

  const worstPayout = Math.min(...recovery.map(nexusPayout));
  const worstRate = Math.min(...recovery.map(nexusFairRate));

  return {
    name,
    xml,
    warnings,
    summary: {
      symbol: input.symbol,
      displayName: input.displayName,
      market,
      submarket,
      normal: normalLabels,
      recovery: recoveryLabels,
      normalCsv,
      recoveryCsv,
      stake: input.stake,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      maxRecoverySteps,
      markupPercent,
      maxStake,
      breakerDepth,
      currency,
      window: windowSize,
      forceEntryAfter,
      watchMarkets,
      ladder: ladderRisk(worstPayout, markupPercent, maxRecoverySteps, worstRate),
      gate: { window: windowSize, normal: gateNormal, recovery: gateRecovery },
      hedge,
    },
  };
}
