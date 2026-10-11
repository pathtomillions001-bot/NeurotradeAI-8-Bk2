/**
 * Multi-Asset Desk — risk governor.
 *
 * Everything here exists to answer one question before any plan is armed:
 * "is this account allowed to take another trade right now, and if so, how
 * big?"
 *
 * THE LOSS POLICY IS DE-ESCALATION, NOT MARTINGALE.
 *
 * Increasing stake after a loss converts a long series of small wins into one
 * total loss. At a 55% win rate a 7-loss streak arrives roughly every 1 200
 * trades; a 1→2→4→8% progression is wiped out by it. Worse, a losing streak
 * is usually evidence that the regime has changed — which is precisely the
 * moment size must come down, not up.
 *
 * So after consecutive losses this module reduces risk, raises the quality
 * bar, cools the symbol down and ultimately halts the session. "Recovery"
 * means controlled re-entry once conditions are re-confirmed.
 */

import { aggregateExposure, currencyLegs } from "./sizing";
import { clamp } from "./math";
import type { AccountSnapshot, Position, SymbolSpec } from "./types";

export interface RiskPolicy {
  baseRiskPct: number;
  maxRiskPct: number;
  /** Daily loss limit as a percentage of start-of-day equity. */
  maxDailyLossPct: number;
  /** Maximum drawdown from peak equity before the desk halts. */
  maxDrawdownPct: number;
  maxOpenPositions: number;
  maxPositionsPerSymbol: number;
  /** Maximum netted risk on any single currency / asset class. */
  maxCurrencyExposurePct: number;
  /** Consecutive losses that trigger a full session halt. */
  haltAfterConsecutiveLosses: number;
  /** Minimum margin level (%) required before opening anything new. */
  minMarginLevelPct: number;
  /** Cool-down applied to a symbol after repeated losses on it. */
  symbolCooldownMs: number;
  /** Live trading must be explicitly enabled; demo is the default. */
  liveTradingEnabled: boolean;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  baseRiskPct: 0.5,
  maxRiskPct: 2,
  maxDailyLossPct: 3,
  maxDrawdownPct: 10,
  maxOpenPositions: 12,
  maxPositionsPerSymbol: 3,
  maxCurrencyExposurePct: 2,
  haltAfterConsecutiveLosses: 5,
  minMarginLevelPct: 500,
  symbolCooldownMs: 15 * 60 * 1000,
  liveTradingEnabled: false,
};

export interface TradeOutcome {
  symbol: string;
  profit: number;
  closedAt: number;
}

export interface RiskState {
  consecutiveLosses: number;
  /** Per-symbol consecutive losses, driving symbol-level suspension. */
  symbolLosses: Record<string, number>;
  /** Epoch ms until which a symbol must not be traded. */
  symbolCooldownUntil: Record<string, number>;
  /** Symbols suspended until a regime change is confirmed. */
  suspendedSymbols: string[];
  realisedPnlToday: number;
  tradesToday: number;
  haltedUntilNextSession: boolean;
  haltReason: string | null;
}

export function createRiskState(): RiskState {
  return {
    consecutiveLosses: 0,
    symbolLosses: {},
    symbolCooldownUntil: {},
    suspendedSymbols: [],
    realisedPnlToday: 0,
    tradesToday: 0,
    haltedUntilNextSession: false,
    haltReason: null,
  };
}

/**
 * The desk's per-trade risk BUDGET, as a percentage of equity.
 *
 * This is a ceiling, not a size. The agent decides what to actually risk inside
 * it — scaled down by the measured edge (fractional Kelly), by how confident
 * the regime call is, and by the loss ladder below — so most trades risk less
 * than this. What the number guarantees is the thing a small account actually
 * needs: a setup is never refused because the adaptive target could not afford
 * the broker's smallest lot, as long as the smallest lot fits HERE.
 *
 * The user's own policy can lower it (`maxRiskPct` in settings); it can never
 * raise it. Reported on every decision so the desk and the EA agree on it.
 */
export const PER_TRADE_RISK_BUDGET_PCT = 0.5;

/**
 * De-escalation ladder. Index = consecutive losses.
 *
 * `riskMultiplier` shrinks size; `scoreBump` raises the confluence bar so only
 * better setups get through while the system is out of sync with the market.
 */
export const LOSS_LADDER: { riskMultiplier: number; scoreBump: number }[] = [
  { riskMultiplier: 1.0, scoreBump: 0 }, // 0 losses
  { riskMultiplier: 1.0, scoreBump: 0 }, // 1 loss  — noise, no change
  { riskMultiplier: 0.75, scoreBump: 5 }, // 2 losses
  { riskMultiplier: 0.5, scoreBump: 10 }, // 3 losses
  { riskMultiplier: 0.35, scoreBump: 15 }, // 4 losses — symbol suspended too
];

export function ladderFor(consecutiveLosses: number): { riskMultiplier: number; scoreBump: number } {
  const index = clamp(Math.floor(consecutiveLosses), 0, LOSS_LADDER.length - 1);
  return LOSS_LADDER[index];
}

/** Fold a closed trade into the risk state. */
export function recordOutcome(
  state: RiskState,
  outcome: TradeOutcome,
  policy: RiskPolicy = DEFAULT_RISK_POLICY,
): RiskState {
  const next: RiskState = {
    ...state,
    symbolLosses: { ...state.symbolLosses },
    symbolCooldownUntil: { ...state.symbolCooldownUntil },
    suspendedSymbols: [...state.suspendedSymbols],
    realisedPnlToday: state.realisedPnlToday + outcome.profit,
    tradesToday: state.tradesToday + 1,
  };

  if (outcome.profit < 0) {
    next.consecutiveLosses = state.consecutiveLosses + 1;
    const symbolCount = (state.symbolLosses[outcome.symbol] ?? 0) + 1;
    next.symbolLosses[outcome.symbol] = symbolCount;

    if (symbolCount >= 3) {
      next.symbolCooldownUntil[outcome.symbol] = outcome.closedAt + policy.symbolCooldownMs;
    }
    if (symbolCount >= 4 && !next.suspendedSymbols.includes(outcome.symbol)) {
      // Four losses on one instrument is not variance — the model's read of
      // this market is wrong until a regime change says otherwise.
      next.suspendedSymbols.push(outcome.symbol);
    }
    if (next.consecutiveLosses >= policy.haltAfterConsecutiveLosses) {
      next.haltedUntilNextSession = true;
      next.haltReason = `${next.consecutiveLosses} consecutive losses — desk halted for the session.`;
    }
  } else {
    // A win clears the account-wide streak and this symbol's counter, but not
    // a suspension: that is lifted only by a confirmed regime change.
    next.consecutiveLosses = 0;
    next.symbolLosses[outcome.symbol] = 0;
  }

  return next;
}

/** Lift a symbol suspension once the regime has demonstrably changed. */
export function confirmRegimeChange(state: RiskState, symbol: string): RiskState {
  return {
    ...state,
    suspendedSymbols: state.suspendedSymbols.filter((s) => s !== symbol),
    symbolLosses: { ...state.symbolLosses, [symbol]: 0 },
    symbolCooldownUntil: { ...state.symbolCooldownUntil, [symbol]: 0 },
  };
}

export function resetForNewSession(state: RiskState): RiskState {
  return {
    ...createRiskState(),
    // Suspensions survive the day boundary; they are model-quality signals,
    // not daily-limit signals.
    suspendedSymbols: [...state.suspendedSymbols],
  };
}

export interface RiskDecision {
  allow: boolean;
  /**
   * The adaptive risk target for this trade, after de-escalation and caps.
   * This is what the desk WOULD risk with the edge it measured.
   */
  riskPct: number;
  /**
   * The per-trade risk ceiling that target works inside, after the user's
   * policy is applied. `riskPct` is always ≤ this. The difference between the
   * two is the sizing decision the agent makes below the budget.
   */
  riskCeilingPct: number;
  /** Added to the confluence threshold while the desk is out of sync. */
  scoreBump: number;
  reasons: string[];
  breaches: string[];
}

export function evaluateRisk(input: {
  symbol: string;
  spec: SymbolSpec;
  account: AccountSnapshot;
  positions: Position[];
  specs: Map<string, SymbolSpec>;
  state: RiskState;
  policy?: Partial<RiskPolicy>;
  now?: number;
}): RiskDecision {
  const policy = { ...DEFAULT_RISK_POLICY, ...(input.policy ?? {}) };
  const now = input.now ?? Date.now();
  const { account, positions, state, symbol } = input;

  const breaches: string[] = [];
  const reasons: string[] = [];

  // ── Hard gates ─────────────────────────────────────────────────────────────
  if (account.isLive && !policy.liveTradingEnabled) {
    breaches.push("Live trading is disabled for this account. Enable it explicitly in settings.");
  }

  if (state.haltedUntilNextSession) {
    breaches.push(state.haltReason ?? "Desk halted for the session.");
  }

  const dayStart = account.dayStartEquity ?? account.balance;
  if (dayStart > 0) {
    const dayLossPct = ((dayStart - account.equity) / dayStart) * 100;
    if (dayLossPct >= policy.maxDailyLossPct) {
      breaches.push(
        `Daily loss ${dayLossPct.toFixed(2)}% has reached the ${policy.maxDailyLossPct}% limit.`,
      );
    } else if (dayLossPct > 0) {
      reasons.push(`Daily P&L −${dayLossPct.toFixed(2)}% of the ${policy.maxDailyLossPct}% budget.`);
    }
  }

  const peak = account.peakEquity ?? Math.max(account.equity, account.balance);
  if (peak > 0) {
    const ddPct = ((peak - account.equity) / peak) * 100;
    if (ddPct >= policy.maxDrawdownPct) {
      breaches.push(
        `Drawdown ${ddPct.toFixed(2)}% from peak equity exceeds the ${policy.maxDrawdownPct}% limit.`,
      );
    }
  }

  if (positions.length >= policy.maxOpenPositions) {
    breaches.push(`${positions.length} positions open — the limit is ${policy.maxOpenPositions}.`);
  }

  const onSymbol = positions.filter((p) => p.symbol === symbol).length;
  if (onSymbol >= policy.maxPositionsPerSymbol) {
    breaches.push(
      `${onSymbol} position(s) already open on ${symbol} — the limit is ${policy.maxPositionsPerSymbol}.`,
    );
  }

  if (state.suspendedSymbols.includes(symbol)) {
    breaches.push(`${symbol} is suspended after repeated losses, pending a confirmed regime change.`);
  }

  const cooldownUntil = state.symbolCooldownUntil[symbol] ?? 0;
  if (cooldownUntil > now) {
    breaches.push(
      `${symbol} is cooling down for another ${Math.ceil((cooldownUntil - now) / 60000)} min.`,
    );
  }

  if (Number.isFinite(account.marginLevel) && account.marginLevel < policy.minMarginLevelPct) {
    breaches.push(
      `Margin level ${account.marginLevel.toFixed(0)}% is below the ${policy.minMarginLevelPct}% floor.`,
    );
  }

  // ── Correlated exposure ────────────────────────────────────────────────────
  // Three "1% trades" that are all short USD are one 3% trade.
  const exposure = aggregateExposure(positions, input.specs, account.equity);
  const legs = currencyLegs(input.spec);
  for (const entry of exposure) {
    if (!legs.includes(entry.key)) continue;
    if (entry.riskPct >= policy.maxCurrencyExposurePct) {
      breaches.push(
        `Open exposure on ${entry.key} is ${entry.riskPct.toFixed(2)}%, at the ${policy.maxCurrencyExposurePct}% cap.`,
      );
    }
  }

  // ── Sizing after de-escalation ─────────────────────────────────────────────
  const ladder = ladderFor(state.consecutiveLosses);
  if (ladder.riskMultiplier < 1) {
    reasons.push(
      `${state.consecutiveLosses} consecutive losses — risk reduced to ${(ladder.riskMultiplier * 100).toFixed(0)}% and the quality bar raised by ${ladder.scoreBump} points.`,
    );
  }

  // The budget every trade must live inside. The desk's own ceiling is the hard
  // bound — a settings value ABOVE it can make the ladder's number no larger,
  // only the ceiling smaller. The user can therefore only tighten the budget,
  // never widen it.
  const riskCeilingPct = Math.min(PER_TRADE_RISK_BUDGET_PCT, policy.maxRiskPct);
  // The governor's allowance, already expressed inside that budget. The agent
  // may only shrink it further (edge, regime); nothing downstream may raise it.
  const riskPct = clamp(policy.baseRiskPct * ladder.riskMultiplier, 0.05, riskCeilingPct);

  return {
    allow: breaches.length === 0,
    riskPct,
    riskCeilingPct,
    scoreBump: ladder.scoreBump,
    reasons,
    breaches,
  };
}

/**
 * Remaining daily risk budget in account currency — displayed in the terminal
 * as a depleting bar so the user can see how much room is left.
 */
export function remainingDailyBudget(
  account: AccountSnapshot,
  policy: RiskPolicy = DEFAULT_RISK_POLICY,
): { usedPct: number; remainingMoney: number; limitMoney: number } {
  const dayStart = account.dayStartEquity ?? account.balance;
  const limitMoney = dayStart * (policy.maxDailyLossPct / 100);
  const lost = Math.max(0, dayStart - account.equity);
  return {
    usedPct: limitMoney > 0 ? clamp((lost / limitMoney) * 100, 0, 100) : 0,
    remainingMoney: Math.max(0, limitMoney - lost),
    limitMoney,
  };
}
