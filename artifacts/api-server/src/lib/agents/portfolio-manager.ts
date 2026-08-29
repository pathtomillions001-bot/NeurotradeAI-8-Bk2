/**
 * Agent 10: Portfolio Manager
 *
 * RESPONSIBILITY: Enforce one-trade-at-a-time, track open exposure, and manage
 * concentration risk across market types. Prevents simultaneous correlated
 * positions and ensures orderly trade flow.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";

interface OpenPosition {
  symbol: string;
  contractType: string;
  openedAt: number;
  stake: number;
  expiresAt: number;  // estimated settlement time
}

const openPositions: OpenPosition[] = [];
const MAX_OPEN_POSITIONS = 1; // one-at-a-time for safety

export function registerOpenPosition(
  symbol: string,
  contractType: string,
  stake: number,
  durationTicks: number,
): void {
  const now = Date.now();
  // Assume roughly 1s per tick for safety window + 10s buffer
  openPositions.push({
    symbol, contractType, stake,
    openedAt: now,
    expiresAt: now + durationTicks * 1000 + 10_000,
  });
}

export function clearExpiredPositions(): void {
  const now = Date.now();
  const before = openPositions.length;
  openPositions.splice(0, openPositions.length, ...openPositions.filter(p => p.expiresAt > now));
}

export function clearPosition(symbol: string): void {
  const idx = openPositions.findIndex(p => p.symbol === symbol);
  if (idx >= 0) openPositions.splice(idx, 1);
}

export function runPortfolioManagerAgent(
  ctx: ScanContext,
): AgentOutput & { hasOpenPosition: boolean; openCount: number } {
  const t0 = Date.now();

  clearExpiredPositions();

  const openCount = openPositions.length;
  const hasOpenPosition = openPositions.some(p => p.symbol === ctx.symbol);
  const totalOpenCount = openPositions.length;
  const atLimit = totalOpenCount >= MAX_OPEN_POSITIONS;

  const openExposure = openPositions.reduce((s, p) => s + p.stake, 0);
  const exposurePct = ctx.balance > 0 ? (openExposure / ctx.balance) * 100 : 0;

  const blockers: string[] = [];
  if (hasOpenPosition) blockers.push(`${ctx.symbol} already has an open position`);
  if (atLimit) blockers.push(`Max concurrent positions reached (${MAX_OPEN_POSITIONS})`);
  if (exposurePct > 15) blockers.push(`Portfolio exposure ${exposurePct.toFixed(1)}% exceeds 15% limit`);

  const score = blockers.length > 0 ? 10 : 75;

  const reasoning = [
    `Open positions: ${totalOpenCount}/${MAX_OPEN_POSITIONS}.`,
    `Exposure: $${openExposure.toFixed(2)} (${exposurePct.toFixed(1)}% of balance).`,
    blockers.length > 0 ? `Blockers: ${blockers.join("; ")}.` : "Portfolio clear — ready to trade.",
  ].join(" ");

  return {
    agentId: "portfolioManager",
    score,
    confidence: 100,
    signal: scoreToSignal(score),
    reasoning,
    data: { openCount: totalOpenCount, hasOpenPosition, atLimit, exposurePct },
    executionTimeMs: Date.now() - t0,
    hasOpenPosition,
    openCount,
  };
}
