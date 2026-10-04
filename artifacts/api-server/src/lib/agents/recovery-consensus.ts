/**
 * Recovery Consensus Engine
 *
 * Replaces the full 8-agent tournament scan during recovery mode.
 * Instead of running the heavy coordinator pipeline (which has quality gates,
 * regime checks, and multi-family tournaments that can take 30+ minutes to
 * align), this module runs a fast, contract-specific analysis in three
 * independent tick windows: 50, 100, and 150 ticks/digits.
 *
 * A recovery trade fires the instant ALL THREE windows agree — this is the
 * sole quality gate. No coordinator, no quality floor, no regime gate.
 *
 * Rules enforced here:
 *  - Only the user's recovery contract types are analyzed (no contract switching)
 *  - Only the user's configured recovery barriers are used (recoveryOverDigit etc.)
 *  - Only markets already in contractCompatibleMarkets are scanned (no market switching)
 *  - Each contract type has its own analysis logic matched to its payout structure
 */

import {
  analyzeDigits,
  analyzeEvenOdd,
  analyzeMatchDiffers,
} from "./digit-probability";

// ── Per-window result ──────────────────────────────────────────────────────────

export interface WindowAnalysis {
  size: number;
  /** The trade direction this window recommends, e.g. "over" | "under" | "even" | "odd" | "match" | "diff" | "call" | "put" | "none" */
  recommendation: string;
  /** Digit associated with the trade (barrier for OVER/UNDER, match/diff digit for MATCH/DIFF) */
  digit: number | null;
  /** Estimated win probability 0–1 */
  winProbability: number;
  /** Deviation from theoretical win rate (positive = in our favour) */
  strength: number;
}

// ── Consensus result ──────────────────────────────────────────────────────────

export interface RecoveryConsensusResult {
  /** True only when all 3 windows independently recommend the same trade */
  agreed: boolean;
  contractType: string;        // e.g. "DIGITOVER", "DIGITMATCH", "CALL"
  barrier: number | null;      // exact barrier/digit to use
  digit: number | null;        // for MATCH/DIFF: the digit to match/differ
  avgWinProbability: number;   // average win probability across the 3 windows
  avgStrength: number;         // average signal strength across the 3 windows
  windows: {
    w50:  WindowAnalysis;
    w100: WindowAnalysis;
    w150: WindowAnalysis;
  };
  reason: string;
}

// ── DIGITOVER / DIGITUNDER ────────────────────────────────────────────────────

function analyzeOverUnder(
  contractType: "DIGITOVER" | "DIGITUNDER",
  barrier: number,
  w50: number[],
  w100: number[],
  w150: number[],
): RecoveryConsensusResult {
  const theoretical = contractType === "DIGITOVER" ? (9 - barrier) / 10 : barrier / 10;
  const label = contractType === "DIGITOVER" ? "over" : "under";

  function winProb(digits: number[]): number {
    if (digits.length < 5) return theoretical;
    const a = analyzeDigits(digits);
    let p = 0;
    if (contractType === "DIGITOVER") {
      for (let d = barrier + 1; d <= 9; d++) p += a.bayesianProb[d];
    } else {
      for (let d = 0; d < barrier; d++) p += a.bayesianProb[d];
    }
    return p;
  }

  const p50  = winProb(w50);
  const p100 = winProb(w100);
  const p150 = winProb(w150);

  const dev50  = p50  - theoretical;
  const dev100 = p100 - theoretical;
  const dev150 = p150 - theoretical;

  // All 3 windows must show digit distribution skewing in our favour.
  // 0.005 threshold filters noise at low sample sizes.
  const agreed = dev50 > 0.005 && dev100 > 0.005 && dev150 > 0.005;

  const mkWindow = (size: number, p: number, dev: number): WindowAnalysis => ({
    size, recommendation: dev > 0.005 ? label : "none",
    digit: barrier, winProbability: p, strength: dev,
  });

  return {
    agreed,
    contractType,
    barrier,
    digit: barrier,
    avgWinProbability: (p50 + p100 + p150) / 3,
    avgStrength: (dev50 + dev100 + dev150) / 3,
    windows: { w50: mkWindow(50, p50, dev50), w100: mkWindow(100, p100, dev100), w150: mkWindow(150, p150, dev150) },
    reason: agreed
      ? `${contractType} ${barrier}: all 3 windows above theoretical (devs: ${(dev50*100).toFixed(1)}%, ${(dev100*100).toFixed(1)}%, ${(dev150*100).toFixed(1)}%)`
      : `${contractType} ${barrier}: not all windows agree (devs: ${(dev50*100).toFixed(1)}%, ${(dev100*100).toFixed(1)}%, ${(dev150*100).toFixed(1)}%)`,
  };
}

// ── DIGITEVEN / DIGITODD ──────────────────────────────────────────────────────

function analyzeEvenOddContract(
  contractType: "DIGITEVEN" | "DIGITODD",
  w50: number[],
  w100: number[],
  w150: number[],
): RecoveryConsensusResult {
  const target = contractType === "DIGITEVEN" ? "even" : "odd";

  const eo50  = w50.length  >= 10 ? analyzeEvenOdd(w50)  : null;
  const eo100 = w100.length >= 10 ? analyzeEvenOdd(w100) : null;
  const eo150 = w150.length >= 10 ? analyzeEvenOdd(w150) : null;

  const rec50  = eo50?.recommendation  ?? "none";
  const rec100 = eo100?.recommendation ?? "none";
  const rec150 = eo150?.recommendation ?? "none";

  const agreed = rec50 === target && rec100 === target && rec150 === target;

  const getProb = (eo: ReturnType<typeof analyzeEvenOdd> | null) => {
    if (!eo) return 0.5;
    return contractType === "DIGITEVEN" ? eo.evenProb : eo.oddProb;
  };

  const p50  = getProb(eo50);
  const p100 = getProb(eo100);
  const p150 = getProb(eo150);

  const mkWindow = (size: number, rec: string, p: number): WindowAnalysis => ({
    size, recommendation: rec, digit: null,
    winProbability: p, strength: Math.abs(p - 0.5),
  });

  return {
    agreed,
    contractType,
    barrier: null,
    digit: null,
    avgWinProbability: (p50 + p100 + p150) / 3,
    avgStrength: (Math.abs(p50 - 0.5) + Math.abs(p100 - 0.5) + Math.abs(p150 - 0.5)) / 3,
    windows: { w50: mkWindow(50, rec50, p50), w100: mkWindow(100, rec100, p100), w150: mkWindow(150, rec150, p150) },
    reason: agreed
      ? `${contractType}: all 3 windows recommend ${target} (${(p50*100).toFixed(1)}%, ${(p100*100).toFixed(1)}%, ${(p150*100).toFixed(1)}%)`
      : `${contractType}: not all windows agree (${rec50}, ${rec100}, ${rec150})`,
  };
}

// ── DIGITMATCH ────────────────────────────────────────────────────────────────

function analyzeMatchContract(
  w50: number[],
  w100: number[],
  w150: number[],
): RecoveryConsensusResult {
  function runMD(digits: number[]) {
    if (digits.length < 30) return null;
    return analyzeMatchDiffers(digits, analyzeDigits(digits));
  }

  const md50  = runMD(w50);
  const md100 = runMD(w100);
  const md150 = runMD(w150);

  const agreed = !!(md50?.matchRecommended && md100?.matchRecommended && md150?.matchRecommended);

  // Pick the digit agreed upon by the most windows; fall back to 150-window digit
  const d50  = md50?.matchDigit  ?? 0;
  const d100 = md100?.matchDigit ?? 0;
  const d150 = md150?.matchDigit ?? 0;
  const counts: Record<number, number> = {};
  for (const d of [d50, d100, d150]) counts[d] = (counts[d] ?? 0) + 1;
  const bestDigit = [d50, d100, d150].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))[0];

  const p50  = md50?.matchWinProbability  ?? 0;
  const p100 = md100?.matchWinProbability ?? 0;
  const p150 = md150?.matchWinProbability ?? 0;
  const avg  = (p50 + p100 + p150) / 3;
  const theoretical = 1 / 10; // 10% uniform expectation per digit for MATCH

  const mkWindow = (size: number, md: ReturnType<typeof runMD>, p: number): WindowAnalysis => ({
    size, recommendation: md?.matchRecommended ? "match" : "none",
    digit: md?.matchDigit ?? null, winProbability: p,
    strength: Math.max(0, p - theoretical),
  });

  return {
    agreed,
    contractType: "DIGITMATCH",
    barrier: bestDigit,
    digit: bestDigit,
    avgWinProbability: avg,
    avgStrength: Math.max(0, avg - theoretical),
    windows: { w50: mkWindow(50, md50, p50), w100: mkWindow(100, md100, p100), w150: mkWindow(150, md150, p150) },
    reason: agreed
      ? `DIGITMATCH digit ${bestDigit}: all 3 windows recommend match (${(p50*100).toFixed(1)}%, ${(p100*100).toFixed(1)}%, ${(p150*100).toFixed(1)}%)`
      : `DIGITMATCH: not all windows recommend (${!!md50?.matchRecommended}, ${!!md100?.matchRecommended}, ${!!md150?.matchRecommended})`,
  };
}

// ── DIGITDIFF ─────────────────────────────────────────────────────────────────

function analyzeDiffContract(
  w50: number[],
  w100: number[],
  w150: number[],
): RecoveryConsensusResult {
  function runMD(digits: number[]) {
    if (digits.length < 30) return null;
    return analyzeMatchDiffers(digits, analyzeDigits(digits));
  }

  const md50  = runMD(w50);
  const md100 = runMD(w100);
  const md150 = runMD(w150);

  const agreed = !!(md50?.diffRecommended && md100?.diffRecommended && md150?.diffRecommended);

  // Pick the coldest diff digit agreed upon by the most windows
  const d50  = md50?.diffDigit  ?? 0;
  const d100 = md100?.diffDigit ?? 0;
  const d150 = md150?.diffDigit ?? 0;
  const counts: Record<number, number> = {};
  for (const d of [d50, d100, d150]) counts[d] = (counts[d] ?? 0) + 1;
  const bestDigit = [d50, d100, d150].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))[0];

  const p50  = md50?.diffWinProbability  ?? 0;
  const p100 = md100?.diffWinProbability ?? 0;
  const p150 = md150?.diffWinProbability ?? 0;
  const avg  = (p50 + p100 + p150) / 3;

  const mkWindow = (size: number, md: ReturnType<typeof runMD>, p: number): WindowAnalysis => ({
    size, recommendation: md?.diffRecommended ? "diff" : "none",
    digit: md?.diffDigit ?? null, winProbability: p,
    strength: Math.max(0, p - 0.9), // baseline DIFF win rate ~96%
  });

  return {
    agreed,
    contractType: "DIGITDIFF",
    barrier: bestDigit,
    digit: bestDigit,
    avgWinProbability: avg,
    avgStrength: Math.max(0, avg - 0.9),
    windows: { w50: mkWindow(50, md50, p50), w100: mkWindow(100, md100, p100), w150: mkWindow(150, md150, p150) },
    reason: agreed
      ? `DIGITDIFF digit ${bestDigit}: all 3 windows recommend diff (${(p50*100).toFixed(1)}%, ${(p100*100).toFixed(1)}%, ${(p150*100).toFixed(1)}%)`
      : `DIGITDIFF: not all windows recommend (${!!md50?.diffRecommended}, ${!!md100?.diffRecommended}, ${!!md150?.diffRecommended})`,
  };
}

// ── CALL / PUT (direction) ────────────────────────────────────────────────────

function analyzeDirectionContract(
  contractType: "CALL" | "PUT",
  p50: number[],
  p100: number[],
  p150: number[],
): RecoveryConsensusResult {
  const targetDir = contractType === "CALL" ? "up" : "down";
  const label = contractType === "CALL" ? "call" : "put";

  function trend(prices: number[]): { dir: "up" | "down" | "flat"; strength: number } {
    if (prices.length < 10) return { dir: "flat", strength: 0 };
    const first = prices[0];
    const last = prices[prices.length - 1];
    if (first === 0) return { dir: "flat", strength: 0 };
    const overall = (last - first) / first;
    // Require consistency: first-half slope and second-half slope must agree
    const mid = prices[Math.floor(prices.length / 2)];
    const firstHalf = (mid - first) / first;
    const secondHalf = (last - mid) / (mid || 1);
    const consistent = Math.sign(firstHalf) === Math.sign(secondHalf);
    if (!consistent || Math.abs(overall) < 0.00005) return { dir: "flat", strength: 0 };
    return { dir: overall > 0 ? "up" : "down", strength: Math.abs(overall) };
  }

  const t50  = trend(p50);
  const t100 = trend(p100);
  const t150 = trend(p150);

  const agreed = t50.dir === targetDir && t100.dir === targetDir && t150.dir === targetDir;

  const clamp = (v: number) => Math.max(0.45, Math.min(0.70, 0.5 + v * 8));

  const mkWindow = (size: number, t: { dir: string; strength: number }, prices: number[]): WindowAnalysis => ({
    size, recommendation: t.dir === targetDir ? label : "none",
    digit: null, winProbability: clamp(t.strength),
    strength: t.dir === targetDir ? t.strength : 0,
  });

  return {
    agreed,
    contractType,
    barrier: null,
    digit: null,
    avgWinProbability: (clamp(t50.strength) + clamp(t100.strength) + clamp(t150.strength)) / 3,
    avgStrength: agreed ? (t50.strength + t100.strength + t150.strength) / 3 : 0,
    windows: { w50: mkWindow(50, t50, p50), w100: mkWindow(100, t100, p100), w150: mkWindow(150, t150, p150) },
    reason: agreed
      ? `${contractType}: all 3 price windows trend ${targetDir} (${(t50.strength*100).toFixed(3)}%, ${(t100.strength*100).toFixed(3)}%, ${(t150.strength*100).toFixed(3)}%)`
      : `${contractType}: trend inconsistent (${t50.dir}, ${t100.dir}, ${t150.dir})`,
  };
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Run 3-window consensus analysis for one market.
 *
 * Analyzes each allowed recovery contract type using 50-, 100-, and 150-tick
 * windows. Returns one RecoveryConsensusResult per allowed contract type.
 * Only results with `agreed === true` should be acted on.
 *
 * @param digits           All available last digits for this market (≥150 recommended)
 * @param prices           All available price ticks for this market (≥150 recommended)
 * @param allowedTypes     Contract types the user has enabled for recovery
 * @param recoveryOverBarrier   User's recovery OVER barrier (e.g. 4 → OVER 4)
 * @param recoveryUnderBarrier  User's recovery UNDER barrier (e.g. 5 → UNDER 5)
 */
export function runRecoveryConsensus(
  digits: number[],
  prices: number[],
  allowedTypes: string[],
  recoveryOverBarrier: number,
  recoveryUnderBarrier: number,
): RecoveryConsensusResult[] {
  // Slice the three windows from the most recent data
  const d150 = digits.slice(-150);
  const d100 = digits.slice(-100);
  const d50  = digits.slice(-50);

  const p150 = prices.slice(-150);
  const p100 = prices.slice(-100);
  const p50  = prices.slice(-50);

  const results: RecoveryConsensusResult[] = [];

  for (const ct of allowedTypes) {
    if (ct === "DIGITOVER") {
      if (d50.length < 20) continue;
      results.push(analyzeOverUnder("DIGITOVER", recoveryOverBarrier, d50, d100, d150));
    } else if (ct === "DIGITUNDER") {
      if (d50.length < 20) continue;
      results.push(analyzeOverUnder("DIGITUNDER", recoveryUnderBarrier, d50, d100, d150));
    } else if (ct === "DIGITEVEN") {
      if (d50.length < 15) continue;
      results.push(analyzeEvenOddContract("DIGITEVEN", d50, d100, d150));
    } else if (ct === "DIGITODD") {
      if (d50.length < 15) continue;
      results.push(analyzeEvenOddContract("DIGITODD", d50, d100, d150));
    } else if (ct === "DIGITMATCH") {
      if (d50.length < 30) continue;
      results.push(analyzeMatchContract(d50, d100, d150));
    } else if (ct === "DIGITDIFF") {
      if (d50.length < 30) continue;
      results.push(analyzeDiffContract(d50, d100, d150));
    } else if (ct === "CALL") {
      if (p50.length < 10) continue;
      results.push(analyzeDirectionContract("CALL", p50, p100, p150));
    } else if (ct === "PUT") {
      if (p50.length < 10) continue;
      results.push(analyzeDirectionContract("PUT", p50, p100, p150));
    }
  }

  return results;
}

/**
 * Find the strongest consensus winner across all scanned markets.
 * Returns null if no market has any agreed consensus.
 * Ties are broken by avgStrength (higher = stronger signal).
 */
export function getBestConsensus(
  allResults: Array<{ symbol: string; market: any; results: RecoveryConsensusResult[] }>,
): { symbol: string; market: any; result: RecoveryConsensusResult } | null {
  const agreed: Array<{ symbol: string; market: any; result: RecoveryConsensusResult }> = [];

  for (const { symbol, market, results } of allResults) {
    for (const r of results) {
      if (r.agreed) agreed.push({ symbol, market, result: r });
    }
  }

  if (agreed.length === 0) return null;

  // Prefer higher avgStrength; within equal strength prefer higher avgWinProbability
  agreed.sort((a, b) =>
    b.result.avgStrength !== a.result.avgStrength
      ? b.result.avgStrength - a.result.avgStrength
      : b.result.avgWinProbability - a.result.avgWinProbability
  );

  return agreed[0];
}
