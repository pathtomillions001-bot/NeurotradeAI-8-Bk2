/**
 * Omni Forge → Deriv DBot strategy generator.
 *
 * WHAT THIS IS
 * ────────────
 *   Digit Forge's sibling with TOTAL contract freedom. The user picks ANY mix
 *   of digit contracts for the normal set and ANY mix for the recovery set —
 *   Over/Under barriers, Even/Odd, Matches/Differs, one of them or several —
 *   presses "Create DBot", and the API renders a Deriv Bot (Blockly) strategy
 *   that carries its OWN analysis while it runs. No NeuroTrade engine, agent
 *   or AI is in the loop once Deriv's Run button is pressed.
 *
 * WHAT THE GENERATED BOT DOES
 * ───────────────────────────
 *   · NORMAL mode (no debt): every tick, `nt_analyse_contracts` ranks every
 *     user-chosen normal contract on every watched market (up to 8) and fires
 *     only when the best candidate clears the statistical gate.
 *   · RECOVERY mode (debt outstanding): the SAME ranker runs over the user's
 *     recovery set, but the estimand shifts to P(win | previous loss) — the
 *     state a recovery entry actually fires from — with deliberately looser
 *     thresholds (repayment speed beats selectivity) while still refusing
 *     tapes where losses cluster. When several recovery contracts are chosen
 *     (e.g. Even/Odd AND Over 4), the bot picks the best contract AND the
 *     best market for that moment, switching markets safely between
 *     contracts when another tape is measurably stronger. NO recovery trade
 *     may fire without a fresh post-settlement rescan: the runtime clears
 *     the confirmation state after every settled trade and the best recovery
 *     candidate must persist across two distinct fresh ticks; after a loss
 *     the exact losing tuple also starts from a decaying score deficit, so
 *     an alternate market/contract with a comparable edge wins the rescan
 *     (patience/force-entry never applies to recovery — debt-sized stakes
 *     always earn their entry).
 *   · Stakes: base stake in normal mode; the shared `getBotRecoveryStake`
 *     ladder in recovery — debt × (1 + markup) / (payout − 1), floored at
 *     0.35, capped by max stake and live balance, rounded up to the cent.
 *   · Circuit breaker on consecutive losses; take-profit / stop-loss on
 *     Deriv's own total-profit counter end the run.
 *
 * THE MATHS (all computed INSIDE the bot runtime, per candidate, per market)
 * ──────────────────────────────────────────────────────────────────────────
 *   · Beta(20·p0, 20·(1−p0)) prior — short tapes shrink to fair digit odds,
 *     so a lucky 30-tick streak cannot impersonate an edge.
 *   · Wilson one-sided 90% lower confidence bound vs the payout's break-even
 *     — the bot trades its worst plausible rate, never its point estimate.
 *   · Two-state Markov chain (add-one smoothed); recovery mode conditions on
 *     the LOSS state because that is the state it enters from — this is what
 *     times the recovery entry instead of firing blind.
 *   · Loss-clustering ratio ξ = P(loss|loss)/P(loss) and split-half
 *     instability as score penalties: clustered losses are what turn a
 *     depth-3 ladder into a depth-6 event. Below 10 observed losses the
 *     clustering estimate is pure add-one smoothing noise divided by a
 *     near-zero loss rate, so it is treated as unmeasurable (neutral) —
 *     without that guard, ~1.09× legs (Over 0 / Under 9 / Differs) could
 *     never pass normal mode at all; see analyseForgeGate below.
 *
 * Forge-time, `analyseForgeGate` replicates those exact thresholds to quote
 * each chosen contract's qualification odds on a fair tape, so a silent bot
 * is never a surprise: tight legs are flagged in `warnings` and in a
 * start-of-run journal notice.
 *
 * NEUROTRADE ADAPTIVE BLOCKS
 * ──────────────────────────
 *   The generated strategy uses four blocks registered by our vendored
 *   builder: `nt_analyse_contracts`, `nt_contract_decision`,
 *   `nt_purchase_contract` (any contract type + just-in-time digit, so one
 *   workspace can buy DIGITOVER and DIGITEVEN in the same session) and
 *   `nt_switch_market`. This XML therefore runs in NeuroTrade's builder, not
 *   the unmodified app.deriv.com builder.
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
} from "./payouts";

// ── Public types ──────────────────────────────────────────────────────────────

export const FORGE_CONTRACT_TYPES = [
  "DIGITOVER",
  "DIGITUNDER",
  "DIGITEVEN",
  "DIGITODD",
  "DIGITMATCH",
  "DIGITDIFF",
] as const;

export type ForgeContractType = (typeof FORGE_CONTRACT_TYPES)[number];

export interface ForgeContractSpec {
  type: ForgeContractType;
  /**
   * The digit: barrier for Over/Under (Over 0–8, Under 1–9), target digit for
   * Matches/Differs (0–9, or −1 = let the running bot auto-pick the
   * hottest/coldest digit of the live tape). Ignored for Even/Odd.
   */
  digit?: number;
}

export interface OmniForgeInput {
  symbol: string;
  displayName: string;
  /** The user's normal-mode contract set (1–6 entries, any mix of types). */
  normal: ForgeContractSpec[];
  /** The user's recovery-mode contract set (1–6 entries, any mix of types). */
  recovery: ForgeContractSpec[];
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

export interface OmniForgeStrategy {
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
      normal: ForgeGateReading[];
      recovery: ForgeGateReading[];
    };
  };
}

/** Every block type the generated strategy may contain. */
export const OMNI_FORGE_BLOCK_TYPES = Object.freeze([
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
  "nt_analyse_contracts",
  "nt_contract_decision",
  "nt_purchase_contract",
  "nt_switch_market",
  "controls_if",
  "logic_compare",
  "logic_boolean",
  "logic_operation",
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
export function forgePayout(spec: ForgeContractSpec): number {
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
  }
}

/** Theoretical win probability of a spec on a uniform tape. */
export function forgeFairRate(spec: ForgeContractSpec): number {
  switch (spec.type) {
    case "DIGITOVER":
      return (9 - (spec.digit ?? 4)) / 10;
    case "DIGITUNDER":
      return (spec.digit ?? 5) / 10;
    case "DIGITEVEN":
    case "DIGITODD":
      return 0.5;
    case "DIGITMATCH":
      return 0.1;
    case "DIGITDIFF":
      return 0.9;
  }
}

/** Human label — "Over 1", "Even", "Matches auto", "Differs 3", … */
export function forgeLabel(spec: ForgeContractSpec): string {
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
  }
}

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

// ── Forge-time gate diagnostics ───────────────────────────────────────────────
// The generated bot gates every entry on statistics computed INSIDE the bot
// runtime (omni-forge-analysis.js in the vendored builder). Exactly the same
// thresholds are replicated here so the forge can tell the user — before they
// burn a session — how often each chosen contract can hope to qualify on a
// fair tape. KEEP IN PARITY with
// artifacts/dbot-builder/src/external/bot-skeleton/services/tradeEngine/trade/omni-forge-analysis.js

export const OMNI_GATE_LIMITS = {
  priorStrength: 20,
  confidenceZ: 1.282,
  /**
   * Losses needed before the add-one-smoothed P(loss|loss) carries more
   * signal than smoothing noise. Below this the runtime reports clustering
   * as neutral (1.0) — without the guard, Over 0 / Under 9 / Differs could
   * never clear normal mode at all (their ~1.09× price only admits ≤ 8%-loss
   * tapes, where the raw ratio read 4–35× against any layout).
   */
  minClusterLosses: 10,
  normal: { minSamples: 30, minEv: 0, lowerBoundMargin: 0.025, maxInstability: 0.16, maxClustering: 1.45 },
  recovery: { minSamples: 20, minEv: -0.01, lowerBoundMargin: 0.05, maxInstability: Infinity, maxClustering: 1.6 },
} as const;

/** Break-even may exceed the fair rate by at most this before a leg counts as priced-tight. */
export const TIGHT_HEADROOM = 0.015;
/** Fair-tape qualification odds below this count as "sparse". */
export const SPARSE_QUALIFICATION = 0.05;
/** The runtime never admits a normal entry below 30 samples — the smallest sane window. */
export const MIN_GATE_WINDOW = OMNI_GATE_LIMITS.normal.minSamples;

export interface ForgeGateReading {
  key: string;
  label: string;
  payout: number;
  fairRate: number;
  /** The win rate the gate prices: 1 / payout. */
  breakEven: number;
  /** Lowest tape win rate that would qualify (most flattering loss layout); null if unreachable at this window. */
  minQualifyingWinRate: number | null;
  /** Exact binomial P(a fair tape of `window` digits qualifies). */
  qualificationChance: number;
  /** The price leaves < ~1.5pt of headroom over natural odds — inherently rare-entry. */
  tight: boolean;
  /** Qualifies on < 5% of fair tapes at this window. */
  sparse: boolean;
}

/** Would a tape with `hits` wins in `n` pass the mode's gate? Mirrors analyseOmniForgeCandidate. */
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
  const limits = mode === "RECOVERY" ? OMNI_GATE_LIMITS.recovery : OMNI_GATE_LIMITS.normal;
  const z = OMNI_GATE_LIMITS.confidenceZ;
  const strength = OMNI_GATE_LIMITS.priorStrength;
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
    losses >= OMNI_GATE_LIMITS.minClusterLosses ? (ll + 1) / (ll + lw + 2) / Math.max(0.01, lossRate) : 1;
  return (
    n >= limits.minSamples &&
    ev > limits.minEv &&
    lowerBound > breakEven - limits.lowerBoundMargin &&
    instability < limits.maxInstability &&
    clustering < limits.maxClustering
  );
}

/** P(X ≥ k) for X ~ Binomial(n, p) — exact, via PMF recurrence (n ≤ 300 here). */
export function binomialTail(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n || p <= 0) return 0;
  if (p >= 1) return 1;
  let mass = Math.exp(n * Math.log(1 - p)); // P(X = 0)
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += mass;
    mass *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, tail);
}

/**
 * Forge-time qualification odds for a chosen set. For each contract we find
 * the LOWEST qualifying win rate at this window (most flattering loss layout:
 * losses scattered, no split-half drift — i.e. an upper bound on how easy the
 * leg is to qualify), then the exact binomial chance of seeing that on a fair
 * tape. This is expectation setting, not a promise: auto Matches/Differs
 * resolve their digit from the live tape, which only helps.
 */
export function analyseForgeGate(
  specs: ForgeContractSpec[],
  window: number,
  mode: "NORMAL" | "RECOVERY",
): ForgeGateReading[] {
  const n = Math.max(1, Math.round(window));
  return specs.map((spec) => {
    const payout = forgePayout(spec);
    const fairRate = forgeFairRate(spec);
    const breakEven = 1 / payout;
    // p0 for the Beta prior = the fair rate for every contract kind.
    let hits: number | null = null;
    for (let h = n; h >= 0; h--) {
      const losses = n - h;
      const passes = gatePasses({
        hits: h,
        n,
        p0: fairRate,
        payout,
        mode,
        ll: 0, // most flattering layout: losses scattered, never back-to-back
        lw: Math.min(losses, Math.max(0, n - losses)),
        instability: 0,
      });
      if (passes) hits = h;
      else if (hits !== null) break; // wins only ever help — first failure after a pass is the boundary
    }
    const minQualifyingWinRate = hits === null ? null : hits / n;
    const qualificationChance = hits === null ? 0 : binomialTail(n, hits, fairRate);
    return {
      key: `${spec.type}:${spec.digit ?? -1}`,
      label: forgeLabel(spec),
      payout,
      fairRate,
      breakEven,
      minQualifyingWinRate,
      qualificationChance,
      tight: breakEven - fairRate > TIGHT_HEADROOM,
      sparse: qualificationChance < SPARSE_QUALIFICATION,
    };
  });
}

/** One plain-English sentence per rare-entry leg (shared by warnings and the journal heads-up). */
export function rareEntrySentence(reading: ForgeGateReading): string {
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

/** Validate + canonicalise a user contract set. Throws on anything illegal. */
export function normaliseForgeSet(raw: ForgeContractSpec[], which: "normal" | "recovery"): ForgeContractSpec[] {
  ensure(Array.isArray(raw) && raw.length >= 1, `${which} needs at least one contract`);
  ensure(raw.length <= 6, `${which} allows at most 6 contracts`);
  const seen = new Set<string>();
  const out: ForgeContractSpec[] = [];
  for (const spec of raw) {
    ensure(
      (FORGE_CONTRACT_TYPES as readonly string[]).includes(spec?.type),
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
      default:
        digit = -1; // Even/Odd carry no digit.
    }
    const key = `${spec.type}:${digit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: spec.type, digit });
  }
  return out;
}

/** Wire format the vendored `nt_analyse_contracts` block parses at runtime. */
export function forgeCsv(specs: ForgeContractSpec[]): string {
  return specs.map((s) => `${s.type}:${s.digit ?? -1}:${forgePayout(s)}`).join(",");
}

/** The trade type the workspace declares — from the FIRST normal contract. */
function tradeTypeFor(spec: ForgeContractSpec): { tradeType: string; hasPrediction: boolean } {
  switch (spec.type) {
    case "DIGITEVEN":
    case "DIGITODD":
      return { tradeType: "evenodd", hasPrediction: false };
    case "DIGITMATCH":
    case "DIGITDIFF":
      return { tradeType: "matchesdiffers", hasPrediction: true };
    default:
      return { tradeType: "overunder", hasPrediction: true };
  }
}

/**
 * `-1` is Omni Forge's CSV sentinel for "auto-pick", not a legal Deriv
 * prediction. Keep it in the analyser wire format, but seed the live Trade
 * Definition with digit 0 until the first analysis resolves a concrete digit.
 * This prevents an invalid `barrier: -1` quote from blocking BEFORE_PURCHASE.
 */
function safeRuntimeDigit(spec: ForgeContractSpec): number {
  if (spec.type === "DIGITEVEN" || spec.type === "DIGITODD") return -1;
  const digit = spec.digit ?? -1;
  return digit >= 0 && digit <= 9 ? digit : 0;
}

// ── Strategy generator ────────────────────────────────────────────────────────

export function buildOmniForgeStrategy(input: OmniForgeInput): OmniForgeStrategy {
  const normal = normaliseForgeSet(input.normal, "normal");
  const recovery = normaliseForgeSet(input.recovery, "recovery");
  ensure(Number.isFinite(input.stake) && input.stake >= 0.35, "stake must be ≥ 0.35");
  ensure(input.takeProfit > 0, "takeProfit must be > 0");
  ensure(input.stopLoss > 0, "stopLoss must be > 0");
  ensure(/^[A-Za-z0-9_]+$/.test(input.symbol), "symbol must be a Deriv symbol code");

  // The runtime never admits a NORMAL entry below 30 digit samples, so a
  // 20–29 digit window would hold every normal leg forever (a quiet failure
  // of the same family as the Over 0 / Under 9 dead zone). Floor it loudly.
  const warnings: string[] = [];
  const requestedWindow = Math.max(1, Math.min(300, Math.round(input.window ?? 120)));
  if (requestedWindow < MIN_GATE_WINDOW) {
    warnings.push(
      `Tick window ${requestedWindow} is below the ${MIN_GATE_WINDOW}-digit minimum the normal gate needs — raised to ${MIN_GATE_WINDOW}.`,
    );
  }
  const windowSize = Math.max(MIN_GATE_WINDOW, requestedWindow);
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

  const normalCsv = forgeCsv(normal);
  const recoveryCsv = forgeCsv(recovery);
  const firstNormal = normal[0]!;
  const firstRecovery = recovery[0]!;
  const { tradeType, hasPrediction } = tradeTypeFor(firstNormal);
  const normalLabels = normal.map(forgeLabel);
  const recoveryLabels = recovery.map(forgeLabel);

  // Qualification diagnostics against the SAME thresholds the bot enforces.
  // Tight legs (price leaves under ~1.5pt of headroom over natural odds —
  // the classic Over 0 / Under 9 / Differs trap) earn a forge-time warning
  // and a start-of-run journal notice, so "no trades being taken" is never
  // a silent surprise again.
  const gateNormal = analyseForgeGate(normal, windowSize, "NORMAL");
  const gateRecovery = analyseForgeGate(recovery, windowSize, "RECOVERY");
  const rareNormalLegs = gateNormal.filter((r) => r.tight || r.sparse);
  for (const reading of rareNormalLegs) {
    warnings.push(rareEntrySentence(reading));
  }

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
    x.set(V.normPayout, x.num(forgePayout(firstNormal))),
    x.set(V.recPayout, x.num(forgePayout(firstRecovery))),
    x.set(V.evalTicks, x.num(0)),
    x.set(V.activeSymbol, x.text(input.symbol)),
    x.set(V.decisionReason, x.text("analysis warming up")),
    x.set(V.decisionScore, x.num(0)),
    x.set(V.gate, x.bool(false)),
    x.notify(
      "info",
      x.text(
        `NeuroTrade Omni Forge · ${input.displayName} · normal [${normalLabels.join(", ")}] → recovery [${recoveryLabels.join(", ")}] · ` +
          `stake ${money(input.stake)} · TP ${money(input.takeProfit)} · SL ${money(input.stopLoss)} · ` +
          `${windowSize}-digit window ranked across ${watchMarkets.length} market${watchMarkets.length === 1 ? "" : "s"} · ` +
          `recovery markup ${markupPercent}% · circuit breaker ${breakerDepth} losses`,
      ),
    ),
    // Rare-entry notice: names the user's own contract choice and its own
    // price — a static property of the legs they chose, never the model's
    // per-tick statistics (the journal stays minimal by design).
    ...(rareNormalLegs.length > 0
      ? [
          x.notify(
            "warn",
            x.text(
              `Rare-entry notice: ${rareNormalLegs.map((r) => r.label).join(", ")} ` +
                `${rareNormalLegs.length === 1 ? "pays" : "pay"} tight enough that normal entries qualify only on ≥ ` +
                `${(Math.max(...rareNormalLegs.map((r) => r.breakEven)) * 100).toFixed(1)}% tapes — they trade when the tape runs hot, and recovery entries are unaffected`,
            ),
          ),
        ]
      : []),
  ];

  // ── 2. Trade options ───────────────────────────────────────────────────────
  // The declared trade type follows the FIRST normal contract so the workspace
  // loads with a coherent Trade Definition; at runtime `nt_purchase_contract`
  // sets or removes the prediction just-in-time for whichever contract the
  // ranker actually buys, so one workspace can trade every chosen type.
  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="ofopts">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="${hasPrediction}"></mutation>` +
    `<field name="DURATIONTYPE_LIST">t</field>` +
    `<field name="CURRENCY_LIST">${currency}</field>` +
    `<value name="DURATION"><shadow type="math_number_positive" id="ofdur"><field name="NUM">1</field></shadow></value>` +
    `<value name="AMOUNT"><shadow type="math_number_positive" id="ofamt"><field name="NUM">${esc(input.stake)}</field></shadow>${x.get(V.stake)}</value>` +
    (hasPrediction
      ? `<value name="PREDICTION"><shadow type="math_number_positive" id="ofprd"><field name="NUM">${safeRuntimeDigit(firstNormal)}</field></shadow>${x.get(V.barrier)}</value>`
      : "") +
    `</block>`;

  const tradeDefinition = x.topLevel(
    "trade_definition",
    `<statement name="TRADE_OPTIONS">` +
      `<block type="trade_definition_market" id="ofmkt" deletable="false" movable="false">` +
      `<field name="MARKET_LIST">${market}</field><field name="SUBMARKET_LIST">${submarket}</field><field name="SYMBOL_LIST">${esc(input.symbol)}</field>` +
      `<next><block type="trade_definition_tradetype" id="oftt" deletable="false" movable="false">` +
      `<field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">${tradeType}</field>` +
      `<next><block type="trade_definition_contracttype" id="ofct" deletable="false" movable="false">` +
      `<field name="TYPE_LIST">both</field>` +
      `<next><block type="trade_definition_candleinterval" id="ofci" deletable="false" movable="false">` +
      `<field name="CANDLEINTERVAL_LIST">60</field>` +
      `<next><block type="trade_definition_restartbuysell" id="ofrb" deletable="false" movable="false">` +
      `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
      `<next><block type="trade_definition_restartonerror" id="ofre" deletable="false" movable="false">` +
      `<field name="RESTARTONERROR">TRUE</field>` +
      `</block></next></block></next></block></next></block></next></block></next></block>` +
      `</statement>` +
      `<statement name="INITIALIZATION">${x.chain(init)}</statement>` +
      // The trade options MUST be unconditional: the interpreter's loop spins
      // on sleep(1) forever while BinaryBotPrivateHasCalledTradeOptions is false.
      `<statement name="SUBMARKET">${tradeOptions}</statement>`,
    0,
    0,
  );

  // ── 3. Purchase conditions — the ranker IS the gate ───────────────────────
  // ── Journal transparency (deliberately minimal) ───────────────────────────
  // The user asked to SEE that the bot is thinking, not to read its model. So
  // the Journal carries the state and the subject only — which market, which
  // contract, holding vs entering — and never the score, EV, lower bound,
  // Markov row or clustering ratio that make up the decision.
  const waitingReport: Stmt[] = [
    x.joinInto(V.message, [
      x.text("ANALYSING"), x.get(V.activeSymbol),
      x.text("· no qualified setup yet — holding"),
    ]),
    x.notify("info", x.get(V.message)),
  ];

  // A factory, not a shared array: every emission needs its own block ids.
  const entryReport = (): Stmt[] => [
    x.joinInto(V.message, [
      x.text("ENTRY ·"), x.get(V.activeSymbol), x.text("·"), x.get(V.contract),
      x.text("· setup qualified"),
    ]),
    x.notify("success", x.get(V.message)),
  ];

  const readDecision: Stmt[] = [
    x.set(V.activeSymbol, x.ntForgeDecision("symbol")),
    x.set(V.contract, x.ntForgeDecision("contract")),
    x.set(V.barrier, x.ntForgeDecision("barrier")),
    x.set(V.decisionScore, x.ntForgeDecision("score")),
    x.set(V.decisionReason, x.ntForgeDecision("reason")),
    x.set(V.gate, x.ntForgeDecision("eligible")),
    x.ifElse(
      [{
        cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)),
        then: [x.set(V.recPayout, x.ntForgeDecision("payout"))],
      }],
      [x.set(V.normPayout, x.ntForgeDecision("payout"))],
    ),
  ];

  const adaptiveEntry: Stmt[] = [
    x.set(V.evalTicks, x.arith("ADD", x.get(V.evalTicks), x.num(1))),
    x.ifElse(
      [{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: [x.ntAnalyseContracts("RECOVERY", watchMarkets, recoveryCsv, windowSize)] }],
      [x.ntAnalyseContracts("NORMAL", watchMarkets, normalCsv, windowSize)],
    ),
    ...readDecision,
    x.ifElse(
      [{
        cond: x.compare("EQ", x.ntForgeDecision("changedMarket"), x.bool(true)),
        then: [
          x.ntSwitchMarket(x.get(V.activeSymbol)),
          x.joinInto(V.message, [x.text("SWITCHED MARKET · now analysing"), x.get(V.activeSymbol)]),
          x.notify("info", x.get(V.message)),
        ],
      }, {
        cond: x.compare("EQ", x.get(V.gate), x.bool(true)),
        then: [...entryReport(), x.set(V.fire, x.bool(true))],
      },
      // Patience (force entry) is a NORMAL-mode privilege only — identical to
      // the Digit Forge and Nexus Hedge rules. A debt-sized recovery must
      // always earn its entry through the runtime gate: fresh post-settlement
      // rescan + fresh-tick confirmations. A patience-fired recovery would
      // bypass exactly the rescan rule that keeps recovery stakes honest.
      ...(forceEntryAfter > 0 ? [{
        cond: x.logic(
          "AND",
          x.compare("EQ", x.get(V.inRecovery), x.bool(false)),
          x.compare("GTE", x.get(V.evalTicks), x.num(forceEntryAfter)),
        ),
        then: [
          x.notify("warn", x.text(`Patience limit ${forceEntryAfter}: entering on the best available setup`)),
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
        then: [x.ntPurchaseContract(x.get(V.contract), x.get(V.barrier))],
      }]),
    ])}</statement>`,
    0,
    900,
  );

  // ── 4. Recovery stake sizing — the shared bot formula, verbatim ────────────
  //   raw   = debt × (1 + markup/100) / (recovery payout − 1)
  //   stake = roundUp₂( clamp(raw, 0.35, maxStake) ), then never above balance
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
    // Defaults until the next analysis cycle re-ranks the recovery set.
    x.set(V.contract, x.text(firstRecovery.type)),
    x.set(V.barrier, x.num(safeRuntimeDigit(firstRecovery))),
    x.set(V.recPayout, x.num(forgePayout(firstRecovery))),
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
    // Back to normal means back behind the gate: the next entry must re-qualify.
    x.set(V.gate, x.bool(false)),
    x.set(V.evalTicks, x.num(0)),
    x.notify("success", x.text(`Recovery complete — debt cleared, back to your normal set [${normalLabels.join(", ")}] at base stake behind the gate`)),
  ];
  const onRecoveryWinPartial: Stmt[] = [
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [
      x.text("Partial recovery —"),
      x.get(V.debt),
      x.text(`${currency} debt remains, next recovery stake`),
      x.get(V.stake),
      x.text(currency),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onLoss: Stmt[] = [
    x.set(V.lossRun, x.arith("ADD", x.get(V.lossRun), x.num(1))),
    x.ifElse([{ cond: x.compare("EQ", x.get(V.inRecovery), x.bool(true)), then: deepenRecovery }], enterRecovery),
    x.call(RECOVERY_PROC),
    x.joinInto(V.message, [
      x.text("Recovery step"),
      x.get(V.step),
      x.text("— best of your recovery set at"),
      x.get(V.stake),
      x.text(`${currency} to clear`),
      x.get(V.debt),
      x.text(currency),
    ]),
    x.notify("warn", x.get(V.message)),
  ];
  const onWin: Stmt[] = [
    x.set(V.lossRun, x.num(0)),
    // Refresh the realised payout multiplier of the leg that just won, so the
    // ladder always divides by the price Deriv actually paid.
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
      {
        cond: x.compare("GTE", x.totalProfit(), x.num(input.takeProfit)),
        then: [x.notify("success", x.text(`Take profit ${money(input.takeProfit)} ${currency} reached — session complete`), "job-done")],
      },
      {
        cond: x.compare("LTE", x.totalProfit(), x.num(-input.stopLoss)),
        then: [x.notify("error", x.text(`Stop loss ${money(input.stopLoss)} ${currency} hit — session stopped`), "error")],
      },
      {
        cond: x.compare("GTE", x.get(V.lossRun), x.num(breakerDepth)),
        then: [
          x.notify(
            "error",
            x.text(
              `Circuit breaker: ${breakerDepth} consecutive losses — the ladder is past the depth this session was sized for`,
            ),
            "severe-error",
          ),
        ],
      },
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

  // Definitions first so every caller resolves its procedure on load.
  const xml =
    `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false">` +
    x.variablesXml() +
    tradeDefinition +
    recoveryProc +
    beforePurchase +
    afterPurchase +
    `</xml>`;

  const name = `NeuroTrade Omni Forge ${input.symbol} ${normalLabels.join("+")} to ${recoveryLabels.join("+")}`;

  // Worst-case ladder disclosure: the lowest recovery payout grows debt the
  // fastest and the lowest fair rate fails the most often.
  const worstPayout = Math.min(...recovery.map(forgePayout));
  const worstRate = Math.min(...recovery.map(forgeFairRate));

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
      gate: {
        window: windowSize,
        normal: gateNormal,
        recovery: gateRecovery,
      },
    },
  };
}
