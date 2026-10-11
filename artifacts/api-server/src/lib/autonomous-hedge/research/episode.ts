/**
 * Recovery research harness — full episode simulator.
 *
 * Runs the REAL shipped functions on a seeded i.i.d. tape, end to end:
 *   buildMarketCandidates → decideHedge (gate, confirmations, rematch) →
 *   calculateRecoveryStakeRequest → applyRecoveryStakeLimits →
 *   reduceRecoveryOutcome, with the shipped settlement/cooldown semantics
 *   (loss-limit stop → cooldown pause → streakLossCount reset, exactly what
 *   resumeAfterCooldown does — which is precisely the counter defect D6).
 *
 * Two arms are comparable under identical seeds:
 *   selector "engine": the shipped ranker + gate pick the recovery contract.
 *   selector "random": a uniform random contract from the same set, same
 *                      stake formula, same cooldown rules.
 * The null test (engine ≈ random on i.i.d. data) is the acceptance gate for
 * any claim that recovery "selection" adds skill.
 */

import {
  buildMarketCandidates,
  hedgePayout,
  type HedgeContractType,
  type HedgeMode,
} from "../hedge-analysis";
import { decideHedge } from "../contest";
import { applySettlement, type HedgeMemory } from "../hedge-state";
import { recoveryEscalation } from "../recovery-risk";
import {
  createRecoveryState,
  reduceRecoveryOutcome,
  type RecoveryState,
} from "../../agents/recovery-engine";
import {
  applyRecoveryStakeLimits,
  calculateRecoveryStakeRequest,
} from "../../recovery-math";
import {
  familySpecsForSet,
  type AutonomousContractSpec,
} from "../contract-sets";
import { HEDGE_MIN_TICKS, HEDGE_WINDOW } from "../constants";
import { scoreRecoveryCandidates } from "../rci";
import type { Rng } from "./rng";
import { createTapeGenerator, type TapeGeneratorOptions } from "./tape";
import { MIN_DERIV_STAKE } from "./ladder";
import type { EpisodeRecord } from "./metrics";

export interface EpisodeSimConfig {
  recoverySpecs: AutonomousContractSpec[];
  /**
   * When set, the episode begins in NORMAL mode trading these specs and
   * recovery starts on the first settled loss. When absent the episode starts
   * already in recovery with one base-stake loss booked (the focused null-test
   * geometry — recovery selection is what we measure).
   */
  normalSpecs?: AutonomousContractSpec[];
  capital: number;
  baseStake: number;
  maxTradeStake: number;
  method: "instant" | "split";
  recoveryAutoMode?: boolean;
  recoveryMultiplier?: number;
  maxRecoverySteps?: number;
  consecutiveLossLimit?: number;
  /** Cooldown pause in ticks (1 tick ≈ 1s of a Volatility index). */
  cooldownTicks?: number;
  maxTicks?: number;
  tape?: TapeGeneratorOptions;
}

export interface EpisodeRunResult extends EpisodeRecord {
  recoveryTrades: number;
  hitRate: number;
  firedByEngine: number;
  ticks: number;
  /** Total $ staked on recovery trades (denominator of the margin metric). */
  stakedInRecovery: number;
  /** Total margin (house edge) paid: Σ stake_c × margin_c. WP3 acceptance. */
  marginPaid: number;
}

/** True per-tick win probability of a spec on i.i.d. data (no lookahead). */
export function specTrueP0(spec: AutonomousContractSpec): number {
  switch (spec.type) {
    case "DIGITOVER": return (9 - spec.digit) / 10;
    case "DIGITUNDER": return spec.digit / 10;
    case "DIGITMATCH": return 0.1;
    case "DIGITDIFF": return 0.9;
    default: return 0.5; // Even, Odd, Rise, Fall
  }
}

const contractTypeOf = (t: HedgeContractType): string => t;

export type EpisodeSelector = "engine" | "random" | "rci";

export function runEpisode(
  rng: Rng,
  cfg: EpisodeSimConfig,
  selector: EpisodeSelector,
): EpisodeRunResult {
  const maxTicks = cfg.maxTicks ?? 4000;
  const lossLimit = cfg.consecutiveLossLimit ?? 4;
  const cooldownTicks = cfg.cooldownTicks ?? 60;
  const autoMode = cfg.recoveryAutoMode ?? true;
  const multiplier = cfg.recoveryMultiplier ?? 1.62;
  const maxSteps = cfg.maxRecoverySteps ?? 3;

  const tape = createTapeGenerator(rng, cfg.tape);
  tape.steps(HEDGE_MIN_TICKS); // warm-up before the ranker may look at anything

  const recoveryFamilySpecs = familySpecsForSet(cfg.recoverySpecs, true);
  const normalFamilySpecs = cfg.normalSpecs ? familySpecsForSet(cfg.normalSpecs, true) : null;

  let balance = cfg.capital;
  let recState: RecoveryState = createRecoveryState();
  let everInRecovery = false;

  if (!normalFamilySpecs) {
    // Start one base-stake loss deep: exactly the state reduceRecoveryOutcome
    // produces when the first normal trade loses.
    const origin = cfg.recoverySpecs[0];
    const originType = origin ? origin.type : "DIGITEVEN";
    balance -= cfg.baseStake;
    recState = reduceRecoveryOutcome(recState, false, -cfg.baseStake, cfg.baseStake, maxSteps, contractTypeOf(originType), hedgePayout(originType, origin?.digit ?? -1));
  }
  if (recState.inRecovery) everInRecovery = true;

  const memory: HedgeMemory = {};
  let trades = 0;
  let recoveryTrades = 0;
  let winsInRecovery = 0;
  let firedByEngine = 0;
  let peakDebt = recState.unrecoveredAmount;

  // TRUE loss run: reset only by a win — never by a cooldown resume (D6).
  let trueRun = recState.streakLossCount;
  let maxTrueRun = trueRun;

  let cooldownRemaining = 0;
  let ticksSinceLastSettlement = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let cappedSeen = false;
  let capTrap = false;
  let stakedInRecovery = 0;
  let marginPaid = 0;
  let tick = 0;

  for (;; tick++) {
    if (tick >= maxTicks) {
      return finish("unresolved");
    }
    tape.step();

    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      if (cooldownRemaining === 0) {
        // resumeAfterCooldown semantics: the gate counter resets, the debt does
        // not, and the TRUE run keeps counting (which the dashboard never saw).
        recState = { ...recState, streakLossCount: 0 };
        memory.confirmation = undefined;
        // A cooldown is a RISK-MANAGER pause, not selector latency. The latency
        // clock restarts when the pause ends so we measure how fast the selector
        // fires once it is allowed to look, not how long the pause lasted.
        ticksSinceLastSettlement = 0;
      }
      continue;
    }

    const mode: HedgeMode = recState.inRecovery ? "RECOVERY" : "NORMAL";
    if (mode === "RECOVERY") everInRecovery = true;

    // ── Pick the contract ────────────────────────────────────────────────
    let chosen: { type: HedgeContractType; barrier: number; p0: number; payout: number; key: string } | null = null;

    if (mode === "RECOVERY" && selector === "random") {
      const spec = recoveryFamilySpecs[rng.nextInt(recoveryFamilySpecs.length)];
      const payout = hedgePayout(spec.type, spec.barrier);
      chosen = {
        type: spec.type,
        barrier: spec.barrier,
        p0: specTrueP0({ type: spec.type, digit: spec.barrier }),
        payout,
        key: `${spec.type}:${spec.barrier}`,
      };
    } else if (mode === "RECOVERY" && selector === "rci") {
      // WP3 RCI selection: no confirmation gate, no rematch penalty — fires on
      // the first tick a feasible contract exists. Stake stays the legacy
      // formula (WP4 swaps in adaptive sizing); only the CHOICE differs here.
      const candidates = recoveryFamilySpecs.map((spec) => ({
        spec: { type: spec.type, digit: spec.barrier },
        payout: hedgePayout(spec.type, spec.barrier),
        quoteSource: "fallback" as const,
        quoteAgeMs: 0,
        tapeAgeMs: 0,
        recentRejections: 0,
      }));
      const decision = scoreRecoveryCandidates({
        candidates,
        debt: recState.unrecoveredAmount,
        targetProfit: recState.remainingTargetProfit,
        headroomCap: cfg.maxTradeStake,
      });
      if (!decision.chosen) {
        // Nothing affordable this tick is a BUDGET fact (WP4's headroom makes it
        // a partial recovery instead), not selector latency — restart the clock.
        ticksSinceLastSettlement = 0;
        continue;
      }
      firedByEngine += 1;
      const chosenSpec = decision.chosen.spec;
      chosen = {
        type: chosenSpec.type,
        barrier: chosenSpec.digit,
        p0: decision.chosen.p0,
        payout: decision.chosen.payout,
        key: `${chosenSpec.type}:${chosenSpec.digit}`,
      };
    } else {
      const specs = mode === "RECOVERY" ? recoveryFamilySpecs : (normalFamilySpecs ?? []);
      if (specs.length === 0) { ticksSinceLastSettlement += 1; continue; }
      const digits = tape.digits().slice(-(HEDGE_WINDOW + 1));
      const prices = tape.prices().slice(-(HEDGE_WINDOW + 1));
      const lossRun = recState.streakLossCount;
      const escalation = recoveryEscalation(lossRun, recState.recoveryStep);
      const rows = buildMarketCandidates({
        symbol: "SIM",
        group: 0,
        digits,
        prices,
        tickSequence: tick,
        specs,
        mode,
        escalation,
      });
      const decision = decideHedge({ rows, mode, memory, lossRun, escalation });
      if (!decision || !decision.eligible) {
        ticksSinceLastSettlement += 1;
        continue;
      }
      firedByEngine += 1;
      chosen = {
        type: decision.best.contract,
        barrier: decision.best.barrier,
        p0: specTrueP0({ type: decision.best.contract, digit: decision.best.barrier }),
        payout: decision.best.payout,
        key: decision.best.key,
      };
    }
    if (!chosen) { ticksSinceLastSettlement += 1; continue; }

    // ── Stake (the shipped money path) ───────────────────────────────────
    let stake: number;
    if (mode === "RECOVERY") {
      const requested = calculateRecoveryStakeRequest({
        unrecoveredAmount: recState.unrecoveredAmount,
        remainingTargetProfit: recState.remainingTargetProfit,
        payoutMultiplier: chosen.payout,
        baseStake: recState.baseStake > 0 ? recState.baseStake : cfg.baseStake,
        recoveryAutoMode: autoMode,
        recoveryMethod: cfg.method,
        recoveryMultiplier: multiplier,
        recoveryStep: recState.recoveryStep,
        maxRecoverySteps: maxSteps,
      });
      stake = applyRecoveryStakeLimits(requested, cfg.maxTradeStake, balance);
    } else {
      stake = Math.min(cfg.baseStake, balance);
    }
    if (!Number.isFinite(stake) || stake < MIN_DERIV_STAKE || stake > balance) {
      if (balance < MIN_DERIV_STAKE) return finish("ruined");
      // An unaffordable stake is a budget fact, not selector latency.
      ticksSinceLastSettlement = 0;
      continue;
    }
    if (stake >= cfg.maxTradeStake - 1e-9 || stake >= balance - 1e-9) cappedSeen = true;

    // ── Resolve on the i.i.d. tape (no lookahead: p0 only) ──────────────
    const won = rng.next() < chosen.p0;
    const profit = won ? stake * (chosen.payout - 1) : -stake;
    balance += profit;
    trades += 1;
    if (mode === "RECOVERY") {
      recoveryTrades += 1;
      if (won) winsInRecovery += 1;
      latencySum += ticksSinceLastSettlement + 1;
      latencyCount += 1;
      // WP3 margin metric: house edge paid per $ staked on this recovery trade.
      stakedInRecovery += stake;
      marginPaid += stake * (1 - chosen.p0 * chosen.payout);
    }
    ticksSinceLastSettlement = 0;

    const wasInRecovery = recState.inRecovery;
    recState = reduceRecoveryOutcome(recState, won, profit, stake, maxSteps, contractTypeOf(chosen.type), chosen.payout);
    applySettlement(memory, {
      won,
      key: chosen.key,
      lossRun: recState.streakLossCount,
      decisionSequence: tick,
    });

    // Truthful counters.
    if (won) trueRun = 0;
    else {
      trueRun += 1;
      maxTrueRun = Math.max(maxTrueRun, trueRun);
    }
    peakDebt = Math.max(peakDebt, recState.unrecoveredAmount);
    if (wasInRecovery && won && recState.inRecovery && cappedSeen) {
      // A capped stake won but did not clear the debt: the cap trap (D2).
      capTrap = true;
    }

    // ── Terminal conditions ──────────────────────────────────────────────
    if (balance < MIN_DERIV_STAKE) return finish("ruined");
    if (everInRecovery && !recState.inRecovery) return finish("cleared");

    // ── Loss-limit stop → cooldown (the shipped semantics) ──────────────
    if (recState.streakLossCount >= lossLimit) {
      cooldownRemaining = cooldownTicks;
    }
  }

  function finish(outcome: EpisodeRecord["outcome"]): EpisodeRunResult {
    return {
      outcome,
      trades: recoveryTrades,
      // Net P&L vs the starting capital (paper convention).
      finalCash: balance - cfg.capital,
      peakDebt,
      maxTrueRun,
      capTrap,
      decisionLatencyTicks: latencyCount > 0 ? latencySum / latencyCount : 0,
      recoveryTrades,
      hitRate: recoveryTrades > 0 ? winsInRecovery / recoveryTrades : 0,
      firedByEngine,
      ticks: tick,
      stakedInRecovery,
      marginPaid,
    };
  }
}

export interface EpisodeSweepOptions {
  episodes: number;
  rng: Rng;
  cfg: EpisodeSimConfig;
  selector: EpisodeSelector;
}

/** Mean margin (house edge) paid per $1 staked on recovery trades. */
export function meanMarginPaid(records: EpisodeRunResult[]): number {
  const staked = records.reduce((s, r) => s + r.stakedInRecovery, 0);
  const margin = records.reduce((s, r) => s + r.marginPaid, 0);
  return staked > 0 ? margin / staked : 0;
}

export function runEpisodeSweep(options: EpisodeSweepOptions): EpisodeRunResult[] {
  const out: EpisodeRunResult[] = new Array(options.episodes);
  for (let i = 0; i < options.episodes; i++) {
    out[i] = runEpisode(options.rng, options.cfg, options.selector);
  }
  return out;
}
