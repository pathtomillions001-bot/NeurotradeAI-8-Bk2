/**
 * Autonomous engine — recovery v2 shadow logger (WP7).
 *
 * While `recoveryV2Mode = "shadow"` the engine keeps trading the LEGACY
 * decision but records, on every recovery tick, what the v2 selector WOULD
 * have done beside it. The comparison is the rollout's evidence base: ≥ 2
 * weeks of side-by-side decisions before anyone opts in.
 *
 * The log is a bounded in-memory ring (no DB writes, no growth without bound)
 * plus per-session counters. It never influences a trade: recording is a pure
 * side effect of the shadow branch in runCycle.
 */

export interface ShadowSide {
  /** Contract key ("TYPE:digit") when the side wanted to trade, else null. */
  contract: string | null;
  symbol: string | null;
  eligible: boolean;
  reason: string;
}

export interface ShadowComparison {
  at: number;
  sessionId: string;
  mode: "NORMAL" | "RECOVERY";
  lossRun: number;
  legacy: ShadowSide | null;
  v2: ShadowSide | null;
  /** True when both sides agree on whether to trade (contract may differ). */
  agreesOnAction: boolean;
}

const CAPACITY = 1000;

class ShadowLog {
  private ring: ShadowComparison[] = [];
  private counters = new Map<string, { ticks: number; agrees: number; legacyTrades: number; v2Trades: number }>();

  record(c: Omit<ShadowComparison, "at" | "agreesOnAction">): ShadowComparison {
    const legacyTrades = c.legacy?.eligible ?? false;
    const v2Trades = c.v2 !== null;
    const entry: ShadowComparison = {
      ...c,
      at: Date.now(),
      agreesOnAction: legacyTrades === v2Trades,
    };
    this.ring.push(entry);
    if (this.ring.length > CAPACITY) this.ring.splice(0, this.ring.length - CAPACITY);
    const ctr = this.counters.get(c.sessionId) ?? { ticks: 0, agrees: 0, legacyTrades: 0, v2Trades: 0 };
    ctr.ticks += 1;
    if (entry.agreesOnAction) ctr.agrees += 1;
    if (legacyTrades) ctr.legacyTrades += 1;
    if (v2Trades) ctr.v2Trades += 1;
    this.counters.set(c.sessionId, ctr);
    return entry;
  }

  /** Newest-first recent comparisons (optionally for one session). */
  recent(limit = 50, sessionId?: string): ShadowComparison[] {
    const rows = sessionId ? this.ring.filter((r) => r.sessionId === sessionId) : this.ring;
    return rows.slice(-limit).reverse();
  }

  summary(sessionId?: string): { ticks: number; agrees: number; agreementRate: number; legacyTrades: number; v2Trades: number } {
    let ticks = 0, agrees = 0, legacyTrades = 0, v2Trades = 0;
    for (const [sid, c] of this.counters) {
      if (sessionId && sid !== sessionId) continue;
      ticks += c.ticks; agrees += c.agrees; legacyTrades += c.legacyTrades; v2Trades += c.v2Trades;
    }
    return { ticks, agrees, agreementRate: ticks > 0 ? agrees / ticks : 0, legacyTrades, v2Trades };
  }

  /** Test/rollout helper — never call from the trading path. */
  clear(): void {
    this.ring = [];
    this.counters.clear();
  }
}

export const shadowLog = new ShadowLog();
