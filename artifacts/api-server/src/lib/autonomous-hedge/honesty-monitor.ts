/**
 * Autonomous engine — honesty monitor (WP6).
 *
 * The stateful half of the statistical-honesty battery: it accumulates each
 * watched market's digit tape (deduplicated by tick sequence), maintains one
 * anytime-valid e-process per recovery contract, and decides — with hysteresis
 * — whether the bounded RCI margin-tilt is active for a contract.
 *
 * Guarantees this monitor must keep:
 *  - Tilt only ever REDUCES the RCI margin weight (factor ∈ [0.5, 1]); it can
 *    never raise a stake or manufacture positive expectation.
 *  - Activation needs BOTH e ≥ 20 (anytime-valid evidence that the contract's
 *    hit rate beats its fair p0) AND a Benjamini–Hochberg-significant tape
 *    battery for that market (q = 0.10). Deactivation is automatic below
 *    e < 1/20 or when the battery is clean again.
 *  - Kill switch: disabled ⇒ factor 1 for every contract, always.
 */

import {
  digitBattery,
  riseFallRunsTest,
  benjaminiHochberg,
  createEProcess,
  stepEProcess,
  tiltGate,
  BH_Q,
  MIN_BATTERY_TICKS,
  type BatteryReport,
  type EProcessState,
  type TiltDecision,
} from "./statistical-honesty";

const DIGIT_BUFFER_CAP = 12_000;
const BATTERY_REFRESH_TICKS = 500; // re-run the battery every N new ticks

/**
 * Fair (i.i.d. CSPRNG) win probability of a contract key like "DIGITOVER:3".
 * This is the p0 the e-process tests against — the expectation is NEGATIVE at
 * the broker's payout, and no selection rule changes that.
 */
export function fairP0ForContractKey(key: string): number {
  const [type, digitRaw] = key.split(":");
  const digit = Number(digitRaw);
  switch (type) {
    case "DIGITOVER": return (9 - digit) / 10;
    case "DIGITUNDER": return digit / 10;
    case "DIGITMATCH": return 0.1;
    case "DIGITDIFF": return 0.9;
    case "DIGITEVEN":
    case "DIGITODD":
    case "CALL":
    case "PUT":
    default: return 0.5;
  }
}

export interface HonestySnapshot {
  symbol: string;
  ticks: number;
  battery: BatteryReport | null;
  batterySignificant: boolean;
  contracts: Array<{ key: string; p0: number; n: number; hitRate: number; eValue: number; tiltActive: boolean }>;
}

interface MarketState {
  digits: number[];
  prices: number[];
  lastSequence: number;
  ticksSinceBattery: number;
  battery: BatteryReport | null;
  batterySignificant: boolean;
}

export class HonestyMonitor {
  private markets = new Map<string, MarketState>();
  private eProcesses = new Map<string, EProcessState>();
  private tiltActive = new Map<string, boolean>();

  constructor(private enabled: boolean) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.tiltActive.clear();
  }

  /** Feed the newest tape for a market; only ticks newer than the last seen. */
  ingestTape(symbol: string, digits: number[], prices: number[], tickSequence: number): void {
    let m = this.markets.get(symbol);
    if (!m) {
      m = { digits: [], prices: [], lastSequence: -1, ticksSinceBattery: Infinity, battery: null, batterySignificant: false };
      this.markets.set(symbol, m);
    }
    if (tickSequence <= m.lastSequence) return; // stale or duplicate snapshot
    // Tapes are rolling windows; append only the suffix newer than what we hold.
    const overlap = this.overlapSuffix(m.digits, digits);
    const appended = digits.slice(overlap);
    if (appended.length > 0) {
      m.digits.push(...appended);
      m.prices.push(...prices.slice(overlap));
      if (m.digits.length > DIGIT_BUFFER_CAP) {
        const cut = m.digits.length - DIGIT_BUFFER_CAP;
        m.digits = m.digits.slice(cut);
        m.prices = m.prices.slice(cut);
      }
      m.ticksSinceBattery += appended.length;
    }
    m.lastSequence = tickSequence;
    if (m.digits.length >= MIN_BATTERY_TICKS && m.ticksSinceBattery >= BATTERY_REFRESH_TICKS) {
      this.runBattery(symbol, m);
      m.ticksSinceBattery = 0;
    }
  }

  private overlapSuffix(held: number[], incoming: number[]): number {
    // Find how many leading digits of `incoming` are already at the tail of
    // `held` (the tape window overlaps our buffer). Bounded search.
    const maxCheck = Math.min(held.length, incoming.length, 400);
    for (let k = maxCheck; k >= 1; k--) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (held[held.length - k + j] !== incoming[j]) { ok = false; break; }
      }
      if (ok) return k;
    }
    return 0;
  }

  private runBattery(symbol: string, m: MarketState): void {
    const battery = digitBattery(m.digits);
    const isRiseFall = symbol.startsWith("R_") || symbol === "1HZ100V" || symbol === "1HZ50V";
    const tests = isRiseFall ? [...battery.tests, riseFallRunsTest(m.prices)] : battery.tests;
    const report: BatteryReport = { n: m.digits.length, tests, minP: Math.min(...tests.map((t) => t.pValue)) };
    // BH across the battery of THIS market; the cycle composes markets via
    // snapshotBatteries() when it needs a global screen.
    const { significant } = benjaminiHochberg(report.tests.map((t) => t.pValue), BH_Q);
    m.battery = report;
    m.batterySignificant = significant.some(Boolean);
  }

  /** Record one settled recovery trade for a contract (key: SPEC@symbol). */
  recordOutcome(symbol: string, contractKey: string, p0: number, won: boolean): void {
    const key = `${contractKey}@${symbol}`;
    let e = this.eProcesses.get(key);
    if (!e) {
      e = createEProcess(p0);
      this.eProcesses.set(key, e);
    }
    stepEProcess(e, won);
    const m = this.markets.get(symbol);
    const gate = tiltGate({
      eValue: e.e,
      batterySignificant: m?.batterySignificant ?? false,
      currentlyActive: this.tiltActive.get(key) ?? false,
      enabled: this.enabled,
    });
    this.tiltActive.set(key, gate.active);
  }

  /**
   * RCI margin-weight multiplier for a contract: 1 unless the tilt gate is
   * active — and even then never below TILT_FLOOR. Disabled monitor ⇒ 1.
   */
  marginWeightFactor(symbol: string, contractKey: string): number {
    if (!this.enabled) return 1;
    const key = `${contractKey}@${symbol}`;
    return this.tiltActive.get(key) ? tiltGate({
      eValue: this.eProcesses.get(key)?.e ?? 0,
      batterySignificant: this.markets.get(symbol)?.batterySignificant ?? false,
      currentlyActive: true,
      enabled: true,
    }).marginWeightFactor : 1;
  }

  tiltDecision(symbol: string, contractKey: string): TiltDecision | null {
    const key = `${contractKey}@${symbol}`;
    const e = this.eProcesses.get(key);
    if (!e) return null;
    return tiltGate({
      eValue: e.e,
      batterySignificant: this.markets.get(symbol)?.batterySignificant ?? false,
      currentlyActive: this.tiltActive.get(key) ?? false,
      enabled: this.enabled,
    });
  }

  snapshot(symbol: string): HonestySnapshot | null {
    const m = this.markets.get(symbol);
    if (!m) return null;
    const contracts: HonestySnapshot["contracts"] = [];
    for (const [key, e] of this.eProcesses) {
      if (!key.endsWith(`@${symbol}`)) continue;
      contracts.push({
        key: key.slice(0, -(symbol.length + 1)),
        p0: e.p0,
        n: e.n,
        hitRate: e.n > 0 ? e.wins / e.n : 0,
        eValue: e.e,
        tiltActive: this.tiltActive.get(key) ?? false,
      });
    }
    return {
      symbol,
      ticks: m.digits.length,
      battery: m.battery,
      batterySignificant: m.batterySignificant,
      contracts,
    };
  }

  /** All markets' batteries — the global screen BH runs across these p-values. */
  snapshotBatteries(): Array<{ symbol: string; minP: number; n: number }> {
    const out: Array<{ symbol: string; minP: number; n: number }> = [];
    for (const [symbol, m] of this.markets) {
      if (m.battery) out.push({ symbol, minP: m.battery.minP, n: m.battery.n });
    }
    return out;
  }
}
