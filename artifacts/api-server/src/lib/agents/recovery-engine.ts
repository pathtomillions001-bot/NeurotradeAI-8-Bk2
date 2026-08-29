/**
 * Recovery Intelligence Engine
 *
 * SINGLE GLOBAL RECOVERY STATE — recovery applies regardless of which contract
 * type (Rise/Fall, Over/Under, Even/Odd) caused the loss. A loss on ANY
 * contract type puts the whole engine into recovery; the very next trade —
 * whatever contract type the AI picks — is treated as the recovery attempt.
 *
 * The Over/Under barrier used while trading is NOT chosen by scanning
 * candidates here. It is fixed by user-configured settings:
 *   - Normal mode:   settings.normalOverDigit   / settings.normalUnderDigit
 *   - Recovery mode: settings.recoveryOverDigit / settings.recoveryUnderDigit
 * (wired in ai.ts → ScanContext.recoveryBarrierOverride, consumed by
 * digit-probability.ts). This module only tracks recovery STATE and STAKE.
 *
 * Partial recovery: each win pays loss debt first. Optional target profit may
 * absorb leftover profit after debt is cleared, and it may still be used to
 * size the next recovery stake, but recovery completes the instant debt is
 * repaid. A $0.01 leftover target must never keep recovery active.
 *
 * State persisted to DB (recoveryStateJson) so recovery survives restarts.
 */

import { getLocalTodayKey } from "../tz";
import {
  addMoney,
  applyRecoveryStakeLimits,
  calculateRecoveryStakeRequest,
  settleRecoveryWin,
  toCents,
} from "../recovery-math";

export {
  applyRecoveryStakeLimits,
  calculateExactRecoveryStake,
  calculateRecoveryStakeRequest,
  roundRecoveryStakeUp,
  settleRecoveryWin,
} from "../recovery-math";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecoveryState {
  inRecovery:               boolean;
  recoveryStep:             number;       // 0 = not in recovery; increments per consecutive recovery loss
  unrecoveredAmount:        number;       // mandatory loss debt — recovery ends when this is 0
  baseStake:                number;       // normal stake the engine recovers back to
  streakLossCount:          number;       // consecutive losses in the current streak (drives dashboard + cooldown gate)
  streakStartAmount:        number;       // total lost in this streak (display)
  targetProfit:             number;       // original expected net profit of the normal trade that started recovery (sizing only)
  remainingTargetProfit:    number;       // leftover optional sizing target — never a completion condition
  originPayoutMultiplier:   number;       // total-return multiplier of that original normal trade
  resetDate:                string;       // local YYYY-MM-DD this state belongs to — drives the daily auto-reset
  consecutiveMatchLosses:   number;       // DIGITMATCH losses in a row while in recovery — triggers DIFF fallback at ≥3
}

/** Local calendar date in user's timezone in YYYY-MM-DD. Uses the tz offset stored in lib/tz so it agrees with the daily stats on the frontend. */
function todayKey(): string {
  return getLocalTodayKey();
}

function freshState(): RecoveryState {
  return {
    inRecovery:               false,
    recoveryStep:             0,
    unrecoveredAmount:        0,
    baseStake:                0,
    streakLossCount:          0,
    streakStartAmount:        0,
    targetProfit:             0,
    remainingTargetProfit:    0,
    originPayoutMultiplier:   1,
    resetDate:                todayKey(),
    consecutiveMatchLosses:   0,
  };
}

let state: RecoveryState = freshState();

/**
 * Inner new-day transition: resets state and applies 50%-debt carry-over.
 * Extracted so both `ensureFreshDay` (lazy check) and `forceNewDay`
 * (midnight scheduler) share identical logic.
 */
function applyNewDay(): void {
  const prevDebt             = state.unrecoveredAmount;
  const prevBaseStake        = state.baseStake;
  const prevTargetProfit     = state.targetProfit;
  const prevRemainingTarget  = state.remainingTargetProfit;
  const prevOriginPayout     = state.originPayoutMultiplier;
  const hadCarryOver         = state.inRecovery || prevDebt > 0 || state.streakLossCount > 0;

  state = freshState();

  // Carry 50% of any unrecovered debt into the new day (capped at 3× base stake).
  // A hard wipe would silently discard real account losses from late-night trades.
  // Half-carry enters at step 1 so previous escalating multipliers don't compound.
  if (prevDebt > 0 && prevBaseStake > 0) {
    const carryDebt = Math.min(prevDebt * 0.5, prevBaseStake * 3);
    if (carryDebt >= 0.35) {
      state.inRecovery        = true;
      state.unrecoveredAmount = carryDebt;
      state.baseStake         = prevBaseStake;
      state.recoveryStep      = 1;
      state.streakLossCount         = 1;
      state.streakStartAmount       = carryDebt;
      state.targetProfit            = Math.max(0, prevTargetProfit);
      state.remainingTargetProfit   = Math.max(0, prevRemainingTarget);
      state.originPayoutMultiplier  = Math.max(1, prevOriginPayout);
    }
  }

  if (hadCarryOver) persistToDb().catch(() => {});
}

/**
 * Every day starts on a clean slate — no unrecovered debt, streak, or recovery
 * mode carries over from a previous day, regardless of whether it was fully
 * covered or not. Called at the top of every read/write entry point so the
 * rollover is detected the instant the calendar day changes, whether the engine
 * is idle, mid-recovery, or mid-loop.
 */
function ensureFreshDay(): void {
  if (state.resetDate !== todayKey()) applyNewDay();
}

/**
 * Force an immediate new-day transition without checking the date.
 * Called by the midnight scheduler exactly at 00:00 in the user's local
 * timezone — avoids any lag waiting for the next trade/request to arrive.
 */
export function forceNewDay(): void {
  applyNewDay();
}

// ── DB persistence (auto, on every outcome) ────────────────────────────────────
// Persistence is triggered automatically inside recordOutcome() so it can never be
// forgotten by a call site (manual trade route, autonomous loop, etc). Lazily import
// the db module to avoid a hard circular/startup dependency on the db package for
// pure in-memory consumers/tests of this module.
let persistFn: ((snapshot: string) => Promise<void>) | null = null;
let persistGeneration = 0;

/**
 * Persist a snapshot taken at call time. A generation counter drops superseded
 * writes so an in-flight persist of a completed cycle cannot be overwritten by
 * an earlier (stale) in-recovery snapshot.
 */
async function persistToDb(): Promise<void> {
  const snapshot = JSON.stringify(state);
  const generation = ++persistGeneration;
  try {
    if (!persistFn) {
      const { db, settingsTable } = await import("@workspace/db");
      persistFn = async (json: string) => {
        await db.update(settingsTable).set({ recoveryStateJson: json, updatedAt: new Date() });
      };
    }
    if (generation !== persistGeneration) return;
    await persistFn(snapshot);
  } catch {
    /* best-effort — in-memory state remains authoritative for the running process */
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Contract types the recovery engine tracks outcomes for. */
const TRACKED_CONTRACT_TYPES = new Set([
  "CALL", "PUT", "RISE", "FALL", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD",
  "DIGITMATCH", "DIGITDIFF",
]);

export function isTrackedContract(contractType: string): boolean {
  return TRACKED_CONTRACT_TYPES.has(contractType);
}

export function getState(): RecoveryState {
  ensureFreshDay();
  return state;
}

export function isInRecovery(): boolean {
  ensureFreshDay();
  return state.inRecovery;
}

// ── Stake calculation ─────────────────────────────────────────────────────────


/**
 * Compute the next recovery stake.
 *
 * AUTO
 * - Instant: use the exact debt-plus-target formula. This is the smallest stake whose net
 *   profit clears all current debt and preserves the original normal trade's
 *   expected profit.
 * - Split: use the same exact calculation, capped at one normal base stake.
 *   Remaining debt stays in recovery and is recalculated after every result.
 *
 * MANUAL
 * - The user-entered multiplier is never payout-calibrated, raised to a hidden
 *   floor, or replaced by an automatic multiplier.
 * - The configured multiplier compounds per consecutive recovery loss up to
 *   maxRecoverySteps. In Split mode it acts as a cap on the exact target; in
 *   Instant mode the manual amount is used directly.
 *
 * All modes still respect the explicit Max Stake Per Trade and available-balance
 * hard limits. Deriv's $0.35 minimum may necessarily produce a small overshoot.
 */
function computeDynamicStake(
  unrecoveredAmount: number,
  remainingTargetProfit: number,
  payout: number,
  _blendedWinP: number,
  balance: number,
  maxTradeStake: number,
  _riskProfile: "conservative" | "moderate" | "aggressive",
  baseStake: number,
  recoveryMultiplier: number,
  recoveryMethod: "split" | "instant",
  recoveryStep: number,
  maxRecoverySteps: number,
  recoveryAutoMode: boolean,
): number {
  const requestedStake = calculateRecoveryStakeRequest({
    unrecoveredAmount,
    remainingTargetProfit,
    payoutMultiplier: payout,
    baseStake,
    recoveryAutoMode,
    recoveryMethod,
    recoveryMultiplier,
    recoveryStep,
    maxRecoverySteps,
  });
  return applyRecoveryStakeLimits(requestedStake, maxTradeStake, balance);
}

/**
 * Get the stake for the next trade. Outside of recovery, this is just the
 * AI-computed base stake. Inside recovery, the stake is sized to recover the
 * accumulated unrecovered amount given the payout/win-probability of whatever
 * contract type the AI has selected for this trade (recovery is not tied to a
 * specific contract type).
 *
 * @param recoveryMultiplier  Used only in Manual mode. It is never substituted or
 *                            payout-calibrated by Auto mode.
 * @param recoveryMethod      Auto Split caps each attempt at the normal base stake;
 *                            Auto Instant targets complete debt + remaining target in one win.
 */
export function getDynamicRecoveryStake(
  baseStakeFromAI: number,
  maxTradeStake: number,
  balance: number,
  payoutMultiplier: number,
  winProbability01: number,
  riskProfile: "conservative" | "moderate" | "aggressive",
  recoveryMultiplier = 1.62,
  recoveryMethod: "split" | "instant" = "split",
  maxRecoverySteps = 3,
  recoveryAutoMode = true,
): number {
  ensureFreshDay();
  if (!state.inRecovery) {
    if (baseStakeFromAI > 0 && isFinite(baseStakeFromAI)) state.baseStake = baseStakeFromAI;
    return baseStakeFromAI;
  }

  const raw = computeDynamicStake(
    state.unrecoveredAmount, state.remainingTargetProfit, payoutMultiplier, winProbability01,
    balance, maxTradeStake, riskProfile, state.baseStake, recoveryMultiplier,
    recoveryMethod, state.recoveryStep, maxRecoverySteps, recoveryAutoMode,
  );
  return Math.max(0.35, Math.min(raw, maxTradeStake));
}

// ── Outcome recording ─────────────────────────────────────────────────────────

/**
 * Record the outcome of ANY trade (regardless of contract type) against the
 * single global recovery state.
 *
 * - Loss: enters/extends recovery. The debt (unrecoveredAmount) and streak
 *   accumulate regardless of what contract type just lost.
 * - Win while in recovery: applies Deriv/net profit to debt first. Recovery
 *   completes as soon as remaining debt is zero at account-currency precision.
 *   Leftover target profit is optional and is cleared on completion.
 * - Win while NOT in recovery: no-op (already normal).
 */
export function recordOutcome(
  won: boolean,
  profit: number,
  stakeUsed: number,
  maxRecoverySteps: number,
  contractType?: string,
  payoutMultiplier = 1,
): RecoveryState {
  ensureFreshDay();
  const isMatch = contractType === "DIGITMATCH";

  if (won) {
    if (state.inRecovery) {
      const settlement = settleRecoveryWin({
        unrecoveredAmount: state.unrecoveredAmount,
        remainingTargetProfit: state.remainingTargetProfit,
        actualNetProfit: profit,
      });

      if (settlement.recoveryComplete) {
        // Debt cleared — exit recovery immediately, even if target is $0.01 short.
        const preservedBaseStake = state.baseStake;
        state = freshState();
        state.baseStake = preservedBaseStake;
      } else {
        state.unrecoveredAmount = settlement.remainingDebt;
        state.remainingTargetProfit = settlement.remainingTargetProfit;
        // A partial win breaks the loss streak, but recovery stays active until
        // the remaining loss debt itself is repaid.
        state.streakLossCount = 0;
        state.consecutiveMatchLosses = 0;
      }
    }
  } else {
    if (!state.inRecovery) {
      state.inRecovery               = true;
      state.recoveryStep             = 1;
      state.baseStake                = state.baseStake > 0 ? state.baseStake : stakeUsed;
      state.unrecoveredAmount        = addMoney(stakeUsed);
      state.streakLossCount          = 1;
      state.streakStartAmount        = addMoney(stakeUsed);
      // Preserve the profit the lost NORMAL trade was expected to earn. Auto
      // recovery may size the next stake to debt + this amount, but the target
      // is aspirational only — it never keeps recovery active after debt is paid.
      const originPayout = Number.isFinite(payoutMultiplier) && payoutMultiplier > 1
        ? payoutMultiplier
        : 1;
      state.originPayoutMultiplier   = originPayout;
      state.targetProfit             = addMoney(stakeUsed * (originPayout - 1));
      state.remainingTargetProfit    = state.targetProfit;
      // If the very first loss was a MATCH trade, start the counter
      state.consecutiveMatchLosses   = isMatch ? 1 : 0;
    } else {
      const cap                = maxRecoverySteps > 0 ? maxRecoverySteps : 3;
      state.recoveryStep       = Math.min(state.recoveryStep + 1, cap);
      state.unrecoveredAmount  = addMoney(state.unrecoveredAmount, stakeUsed);
      state.streakLossCount++;
      state.streakStartAmount  = addMoney(state.streakStartAmount, stakeUsed);
      // Track consecutive MATCH losses during recovery for the DIFF fallback gate.
      // Reset to 0 when any non-MATCH trade loses (we're already on a DIFF attempt).
      if (isMatch) {
        state.consecutiveMatchLosses++;
      } else {
        // A non-MATCH loss during recovery — reset the MATCH counter so the next
        // recovery cycle restarts with MATCH before falling back to DIFF again.
        state.consecutiveMatchLosses = 0;
      }
    }
  }

  // Persist on EVERY outcome (win or loss, manual or autonomous) — fire-and-forget so
  // callers never block on DB latency, but the call itself can never be forgotten since
  // it lives here rather than at each call site.
  persistToDb().catch(() => {});

  return state;
}

// ── State management ──────────────────────────────────────────────────────────

function collapseIfDebtCleared(): void {
  if (!state.inRecovery) return;
  if (toCents(state.unrecoveredAmount) > 0) return;
  const preservedBaseStake = state.baseStake;
  state = freshState();
  state.baseStake = preservedBaseStake;
}

export function resetAll(): void {
  state = freshState();
}

/** Overwrite the entire recovery state (used when syncing from the Deriv journal). */
export function seedState(data: RecoveryState): void {
  state = { ...data };
  collapseIfDebtCleared();
}

export function serializeState(): string {
  return JSON.stringify(state);
}

export function loadState(json: string): void {
  try {
    const parsed = JSON.parse(json);
    // Backward compatibility: older versions stored an array of per-family states.
    // Collapse them into a single global state so a saved-before-migration DB row
    // doesn't crash — sum unrecovered amounts / streaks across all former families.
    if (Array.isArray(parsed)) {
      const inRecovery = parsed.some((s: any) => s?.inRecovery);
      state = {
        inRecovery,
        recoveryStep:      Math.max(0, ...parsed.map((s: any) => Number(s?.recoveryStep) || 0)),
        unrecoveredAmount: parsed.reduce((sum: number, s: any) => sum + (Number(s?.unrecoveredAmount) || 0), 0),
        baseStake:         Math.max(0, ...parsed.map((s: any) => Number(s?.baseStake) || 0)),
        streakLossCount:   parsed.reduce((sum: number, s: any) => sum + (Number(s?.streakLossCount) || 0), 0),
        streakStartAmount:        parsed.reduce((sum: number, s: any) => sum + (Number(s?.streakStartAmount) || 0), 0),
        // The original normal-trade payout was not stored by the legacy format.
        // Zero is the safest target: recover existing debt without inventing profit.
        targetProfit:             0,
        remainingTargetProfit:    0,
        originPayoutMultiplier:   1,
        // Legacy per-family rows predate this feature — always treat as "not today".
        resetDate:                "",
        consecutiveMatchLosses:   0,
      };
      if (!inRecovery) state = freshState();
      collapseIfDebtCleared();
      ensureFreshDay();
      return;
    }

    state = {
      inRecovery:               !!parsed.inRecovery,
      recoveryStep:             Number(parsed.recoveryStep)       || 0,
      unrecoveredAmount:        Number(parsed.unrecoveredAmount)  || 0,
      baseStake:                Number(parsed.baseStake)          || 0,
      streakLossCount:          Number(parsed.streakLossCount)    || 0,
      streakStartAmount:        Number(parsed.streakStartAmount)  || 0,
      targetProfit:             Math.max(0, Number(parsed.targetProfit) || 0),
      remainingTargetProfit:    Math.max(0, Number(parsed.remainingTargetProfit ?? parsed.targetProfit) || 0),
      originPayoutMultiplier:   Math.max(1, Number(parsed.originPayoutMultiplier) || 1),
      // Older/legacy saved rows never had resetDate — treat as "not today" so a
      // pre-existing carry-over debt from before this feature existed is cleared
      // immediately on load rather than silently resurrected.
      resetDate:                typeof parsed.resetDate === "string" ? parsed.resetDate : "",
      // New field — default to 0 for rows saved before this feature existed
      consecutiveMatchLosses:   Number(parsed.consecutiveMatchLosses) || 0,
    };
  } catch {
    /* ignore malformed state — start fresh */
  }
  // A persisted row from the old debt+target completion rule can have
  // unrecoveredAmount === 0 while still marked inRecovery because a $0.01
  // leftover target was treated as unpaid. Collapse that to normal.
  collapseIfDebtCleared();
  // Collapse anything loaded from a previous calendar day back to a clean slate —
  // covers server restarts/deploys that happen to land after midnight.
  ensureFreshDay();
}

export function getLossStreakSummary(): {
  active: boolean;
  totalUnrecovered: number;
  totalStreakLosses: number;
  totalStreakAmount: number;
  remainingTargetProfit: number;
} {
  ensureFreshDay();
  return {
    active:            state.inRecovery,
    totalUnrecovered:  state.unrecoveredAmount,
    totalStreakLosses: state.streakLossCount,
    totalStreakAmount: state.streakStartAmount,
    remainingTargetProfit: state.remainingTargetProfit,
  };
}
