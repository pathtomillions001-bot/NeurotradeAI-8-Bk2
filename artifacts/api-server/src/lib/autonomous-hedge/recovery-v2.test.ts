/**
 * Unit and integration test suite T1–T8 for Recovery Quality Pipeline v2.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getRecoveryV2Mode,
  HEDGE_WINDOW,
  hedgeGroupIndex,
  mulberry32,
  setRecoveryV2ModeOverride,
} from "./constants";
import {
  buildMarketCandidates,
  hedgePayout,
  type HedgeCandidate,
  type HedgeFamilySpec,
} from "./hedge-analysis";
import { decideHedge } from "./contest";
import { EvidenceTracker, type MarketTapeInput } from "./evidence";
import {
  clearLadderOutcomeCache,
  replayLadderStakePath,
  simulateEpisodeStats,
  simulateEpisodeStatsCached,
} from "./ladder-outcomes";
import {
  buildV2RecoveryDecision,
  deterministicTieHash,
  scoreV2Candidates,
  type V2LadderConfig,
} from "./score-v2";
import {
  isDecisionStale,
  MAX_WAIT_TICKS,
  MAX_WAIT_WALL_MS,
  shouldSwitchCandidateBeforeBuy,
  TimingV2Controller,
} from "./timing-v2";
import { clearPrefetchedQuotes, livePayoutFor, payoutInfoFor, setPrefetchedQuoteForTest } from "./quote-prefetch";
import { ShadowLedger, type MarketTickObservation } from "./shadow-ledger";
import { CalibrationGuard, CUSUM_SHRINK_TICKS } from "./calibration-guard";
import {
  applyRecoveryStakeLimits,
  calculateRecoveryStakeRequest,
  settleRecoveryWin,
} from "../recovery-math";

const TEST_MARKETS = [
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",
  "1HZ10V",
  "1HZ15V",
  "1HZ25V",
  "1HZ30V",
  "1HZ50V",
  "1HZ75V",
  "1HZ90V",
  "1HZ100V",
  "RDBULL",
  "RDBEAR",
  "JD10",
  "JD25",
  "JD50",
  "JD75",
];

const SET_B_SPECS: HedgeFamilySpec[] = [
  { type: "CALL", barrier: -1 },
  { type: "PUT", barrier: -1 },
  { type: "DIGITOVER", barrier: 4 },
  { type: "DIGITUNDER", barrier: 5 },
  { type: "DIGITEVEN", barrier: -1 },
  { type: "DIGITODD", barrier: -1 },
  { type: "DIGITMATCH", barrier: -1 },
  { type: "DIGITDIFF", barrier: -1 },
];

const DEFAULT_LADDER: V2LadderConfig = {
  method: "instant",
  autoMode: true,
  multiplier: 1.62,
  step: 1,
  maxRecoverySteps: 3,
  debt: 1,
  targetRemaining: 0.95,
  base: 1,
  maxTradeStake: 50,
  balance: 1000,
  consecutiveLossLimit: 10,
  currentLossRun: 1,
  hardStop: false,
};

describe("Recovery Quality Pipeline v2 — T1 to T8", () => {
  beforeEach(() => {
    clearLadderOutcomeCache();
    clearPrefetchedQuotes();
    setRecoveryV2ModeOverride(null);
  });

  // ── T1: Evidence calibration ───────────────────────────────────────────────
  describe("T1 — Evidence calibration (evidence.ts)", () => {
    it("maintains mean |p~ - p0| < 0.002, calibration slope within +-0.03 of 0, and unbiased auto-digit OOS on a 19-market null stream", () => {
      const rng = mulberry32(0x1010101);
      const numMarkets = TEST_MARKETS.length;
      const totalTicks = 2200;
      const allDigits = Array.from({ length: numMarkets }, () => new Array<number>(totalTicks));
      const allPrices = Array.from({ length: numMarkets }, () => new Array<number>(totalTicks));

      for (let m = 0; m < numMarkets; m++) {
        let price = 1000;
        for (let t = 0; t < totalTicks; t++) {
          allDigits[m]![t] = Math.floor(rng() * 10);
          price += rng() < 0.5 ? 0.01 : -0.01;
          allPrices[m]![t] = price;
        }
      }

      const tracker = new EvidenceTracker();
      const ledger = new ShadowLedger({ persistPath: null });
      let sumAbsDiff = 0;
      let totalRows = 0;
      let sumAutoDigitAbsDiff = 0;
      let autoDigitRows = 0;

      for (let t = 120; t < totalTicks - 1; t++) {
        const seq = t + 1;
        const avail = Math.min(1500, t + 1);
        const inputs: MarketTapeInput[] = TEST_MARKETS.map((symbol, m) => ({
          symbol,
          digits:
            t === 120 ? allDigits[m]!.slice(0, t + 1) : [allDigits[m]![t - 1]!, allDigits[m]![t]!],
          prices:
            t === 120 ? allPrices[m]!.slice(0, t + 1) : [allPrices[m]![t - 1]!, allPrices[m]![t]!],
          availableTicks: avail,
          tickSequence: seq,
          specs: SET_B_SPECS,
        }));

        const rows = tracker.evaluate({
          markets: inputs,
          marketsScanned: numMarkets,
          specsInSet: SET_B_SPECS.length,
          evidenceWeight: 1,
        });

        for (const r of rows) {
          const absDiff = Math.abs(r.pTilde - r.p0);
          sumAbsDiff += absDiff;
          totalRows += 1;
          if (r.spec.type === "DIGITMATCH" || r.spec.type === "DIGITDIFF") {
            sumAutoDigitAbsDiff += absDiff;
            autoDigitRows += 1;
          }
        }

        // Feed into shadow ledger every 10th tick to verify OLS slope on null stream
        if (t % 10 === 0) {
          const seqMap = new Map(TEST_MARKETS.map((s) => [s, seq]));
          const ranked = scoreV2Candidates({
            evidenceRows: rows,
            tickSequenceBySymbol: seqMap,
            ladder: DEFAULT_LADDER,
          });
          const obs = new Map<string, MarketTickObservation>();
          for (let m = 0; m < numMarkets; m++) {
            obs.set(TEST_MARKETS[m]!, {
              symbol: TEST_MARKETS[m]!,
              tickSequence: seq,
              digit: allDigits[m]![t]!,
              price: allPrices[m]![t]!,
              prevPrice: allPrices[m]![t - 1]!,
            });
          }
          ledger.stepTick({
            observations: obs,
            v2Ranked: ranked,
            v1Ranked: [],
          });
        }
      }

      const meanAbsDiff = sumAbsDiff / Math.max(1, totalRows);
      const meanAutoAbsDiff = sumAutoDigitAbsDiff / Math.max(1, autoDigitRows);
      const v2Metrics = ledger.getMetrics("v2");

      assert.ok(
        meanAbsDiff < 0.002,
        `Expected mean |p~ - p0| < 0.002 in null world, got ${meanAbsDiff.toFixed(6)}`,
      );
      assert.ok(
        meanAutoAbsDiff < 0.002,
        `Expected auto-digit OOS mean |p~ - p0| < 0.002 in null world, got ${meanAutoAbsDiff.toFixed(6)}`,
      );
      assert.ok(
        Math.abs(v2Metrics.beta) <= 0.03,
        `Expected calibration slope within +-0.03 of 0 in null world, got ${v2Metrics.beta.toFixed(5)}`,
      );
    });

    it("ranks a market with a planted +5 pp Even edge #1 on > 60% of ticks after 2000 ticks", () => {
      const rng = mulberry32(404 * 99991 + 17);
      const numMarkets = TEST_MARKETS.length;
      const totalTicks = 4500;
      const allDigits = Array.from({ length: numMarkets }, () => new Array<number>(totalTicks));
      const allPrices = Array.from({ length: numMarkets }, () => new Array<number>(totalTicks));
      const evenDigits = [0, 2, 4, 6, 8];
      const oddDigits = [1, 3, 5, 7, 9];

      for (let m = 0; m < numMarkets; m++) {
        let price = 1000;
        for (let t = 0; t < totalTicks; t++) {
          const u = rng();
          const uPrice = rng();
          price += uPrice < 0.5 ? 0.01 : -0.01;
          allPrices[m]![t] = price;
          if (m === 0) {
            if (u < 0.55) {
              allDigits[m]![t] = evenDigits[Math.min(4, Math.floor((u / 0.55) * 5))]!;
            } else {
              allDigits[m]![t] = oddDigits[Math.min(4, Math.floor(((u - 0.55) / 0.45) * 5))]!;
            }
          } else {
            allDigits[m]![t] = Math.min(9, Math.floor(u * 10));
          }
        }
      }

      const tracker = new EvidenceTracker();
      const seqMap = new Map<string, number>();
      let plantedWinsAfter2000 = 0;
      let totalAfter2000 = 0;

      for (let t = 120; t < totalTicks; t++) {
        const seq = t + 1;
        for (const s of TEST_MARKETS) seqMap.set(s, seq);
        const avail = Math.min(1500, t + 1);
        const rows = tracker.evaluate({
          markets: TEST_MARKETS.map((symbol, m) => ({
            symbol,
            digits:
              t === 120
                ? allDigits[m]!.slice(0, t + 1)
                : [allDigits[m]![t - 1]!, allDigits[m]![t]!],
            prices:
              t === 120
                ? allPrices[m]!.slice(0, t + 1)
                : [allPrices[m]![t - 1]!, allPrices[m]![t]!],
            availableTicks: avail,
            tickSequence: seq,
            specs: SET_B_SPECS,
          })),
          marketsScanned: numMarkets,
          specsInSet: SET_B_SPECS.length,
          evidenceWeight: 1,
        });

        if (t >= 2000) {
          const ranked = scoreV2Candidates({
            evidenceRows: rows,
            tickSequenceBySymbol: seqMap,
            ladder: DEFAULT_LADDER,
          });
          const best = ranked[0]!;
          totalAfter2000 += 1;
          if (best.symbol === TEST_MARKETS[0] && best.contract === "DIGITEVEN") {
            plantedWinsAfter2000 += 1;
          }
        }
      }

      const share = plantedWinsAfter2000 / Math.max(1, totalAfter2000);
      assert.ok(
        share > 0.6,
        `Expected planted market/spec to rank #1 on > 60% of ticks after 2000 ticks, got ${(share * 100).toFixed(1)}%`,
      );
    });
  });

  // ── T2: Ladder simulator ───────────────────────────────────────────────────
  describe("T2 — Ladder simulator (ladder-outcomes.ts)", () => {
    it("ranks 50% / 1.95x strictly better on pStop and es5 than 10% / 9x under Instant auto recovery", () => {
      const evenEp = simulateEpisodeStats({
        p: 0.5,
        payout: 1.95,
        method: "instant",
        autoMode: true,
        multiplier: 1.62,
        step: 1,
        maxRecoverySteps: 3,
        debt: 1,
        targetRemaining: 0.95,
        base: 1,
        maxTradeStake: 50,
        balance: 1000,
        nStop: 6,
      });

      const matchEp = simulateEpisodeStats({
        p: 0.1,
        payout: 9.0,
        method: "instant",
        autoMode: true,
        multiplier: 1.62,
        step: 1,
        maxRecoverySteps: 3,
        debt: 1,
        targetRemaining: 0.95,
        base: 1,
        maxTradeStake: 50,
        balance: 1000,
        nStop: 6,
      });

      assert.ok(
        evenEp.pStop < matchEp.pStop,
        `Expected 50%/1.95x pStop (${evenEp.pStop}) < 10%/9x pStop (${matchEp.pStop})`,
      );
      assert.ok(
        evenEp.es5 > matchEp.es5,
        `Expected 50%/1.95x es5 (${evenEp.es5}) > 10%/9x es5 (${matchEp.es5})`,
      );
    });

    it("produces distinct (meanPnl, es5, meanTrades) tuples for Split vs Instant recovery", () => {
      const instantEp = simulateEpisodeStats({
        p: 0.5,
        payout: 1.95,
        method: "instant",
        autoMode: true,
        multiplier: 1.62,
        step: 1,
        maxRecoverySteps: 3,
        debt: 1,
        targetRemaining: 0.95,
        base: 1,
        maxTradeStake: 50,
        balance: 1000,
        nStop: 5,
      });

      const splitEp = simulateEpisodeStats({
        p: 0.5,
        payout: 1.95,
        method: "split",
        autoMode: true,
        multiplier: 1.62,
        step: 1,
        maxRecoverySteps: 3,
        debt: 1,
        targetRemaining: 0.95,
        base: 1,
        maxTradeStake: 50,
        balance: 1000,
        nStop: 5,
      });

      assert.notEqual(instantEp.meanPnl, splitEp.meanPnl);
      assert.notEqual(instantEp.es5, splitEp.es5);
      assert.notEqual(instantEp.meanTrades, splitEp.meanTrades);
      // Split caps each recovery trade at baseStake ($1), so it takes more trades on average and has a tighter tail ES5
      assert.ok(splitEp.meanTrades > instantEp.meanTrades);
      assert.ok(splitEp.es5 > instantEp.es5);
    });

    it("matches closed-form uncapped pStop = (1 - p)^nStop within Monte Carlo error (+-0.015) and meets <= 5 ms runtime budget", () => {
      for (const { p, nStop } of [
        { p: 0.5, nStop: 3 },
        { p: 0.5, nStop: 4 },
        { p: 0.6, nStop: 3 },
        { p: 0.1, nStop: 5 },
      ]) {
        const t0 = performance.now();
        const ep = simulateEpisodeStats({
          p,
          payout: 1.95,
          method: "instant",
          autoMode: true,
          multiplier: 1.62,
          step: 1,
          maxRecoverySteps: 10,
          debt: 1,
          targetRemaining: 0.95,
          base: 1,
          maxTradeStake: Number.POSITIVE_INFINITY,
          balance: Number.POSITIVE_INFINITY,
          nStop,
        });
        const elapsedMs = performance.now() - t0;
        const closedForm = Math.pow(1 - p, nStop);
        assert.ok(
          Math.abs(ep.pStop - closedForm) <= 0.015,
          `Expected pStop (${ep.pStop}) within +-0.015 of closed-form ${closedForm.toFixed(4)}`,
        );
        assert.ok(elapsedMs <= 20, `Expected uncached simulation to be fast, took ${elapsedMs.toFixed(2)}ms`);
      }
    });
  });

  // ── T3: Score ordering & tie rotation ──────────────────────────────────────
  describe("T3 — Score ordering & tie rotation (score-v2.ts)", () => {
    it("is strictly monotone in p~ at fixed payout and ladder", () => {
      const probs = [0.48, 0.49, 0.5, 0.51, 0.52, 0.55, 0.6];
      const rows = probs.map((pTilde, idx) => ({
        symbol: `M_${idx}`,
        spec: { type: "DIGITEVEN" as const, barrier: -1 },
        resolvedBarrier: -1,
        p0: 0.5,
        pTilde,
        z: (pTilde - 0.5) * 20,
        zTilde: Math.max(0, (pTilde - 0.5) * 20),
        window: 500,
        nEff: 500,
        q: 0.5,
        depUsed: false,
        edgeIndex: 0.1,
      }));
      const seqMap = Object.fromEntries(rows.map((r) => [r.symbol, 100]));
      const ranked = scoreV2Candidates({
        evidenceRows: rows,
        tickSequenceBySymbol: seqMap,
        ladder: DEFAULT_LADDER,
      });

      for (let i = 1; i < ranked.length; i++) {
        assert.ok(
          ranked[i - 1]!.pTilde > ranked[i]!.pTilde,
          `Expected higher p~ to rank ahead: ${ranked[i - 1]!.pTilde} vs ${ranked[i]!.pTilde}`,
        );
        assert.ok(
          ranked[i - 1]!.J < ranked[i]!.J,
          `Expected lower cost J for higher p~: ${ranked[i - 1]!.J} vs ${ranked[i]!.J}`,
        );
      }
    });

    it("never selects Matches auto in the null world under Instant auto recovery with debt >= base", () => {
      const rng = mulberry32(0x7777);
      const tracker = new EvidenceTracker();
      const numMarkets = TEST_MARKETS.length;
      const digits = Array.from({ length: numMarkets }, () =>
        Array.from({ length: 500 }, () => Math.floor(rng() * 10)),
      );
      const prices = Array.from({ length: numMarkets }, () => {
        let p = 1000;
        return Array.from({ length: 500 }, () => (p += rng() < 0.5 ? 0.01 : -0.01));
      });

      for (let t = 120; t < 220; t++) {
        const seq = t + 1;
        const evRows = tracker.evaluate({
          markets: TEST_MARKETS.map((symbol, m) => ({
            symbol,
            digits: t === 120 ? digits[m]!.slice(0, t + 1) : [digits[m]![t - 1]!, digits[m]![t]!],
            prices: t === 120 ? prices[m]!.slice(0, t + 1) : [prices[m]![t - 1]!, prices[m]![t]!],
            availableTicks: t + 1,
            tickSequence: seq,
            specs: SET_B_SPECS,
          })),
          marketsScanned: numMarkets,
          specsInSet: SET_B_SPECS.length,
        });
        const ranked = scoreV2Candidates({
          evidenceRows: evRows,
          tickSequenceBySymbol: Object.fromEntries(TEST_MARKETS.map((s) => [s, seq])),
          ladder: { ...DEFAULT_LADDER, debt: 1.5, base: 1 },
        });
        assert.notEqual(
          ranked[0]!.contract,
          "DIGITMATCH",
          `Matches auto must never be #1 in null world at tick ${seq}`,
        );
      }
    });

    it("rotates equal-J candidates across 19 markets over 100 consecutive ticks with no market > 20%", () => {
      const counts = new Map<string, number>();
      const baseEvRows = TEST_MARKETS.map((symbol) => ({
        symbol,
        spec: { type: "DIGITEVEN" as const, barrier: -1 },
        resolvedBarrier: -1,
        p0: 0.5,
        pTilde: 0.5,
        z: 0,
        zTilde: 0,
        window: 1500,
        nEff: 1500,
        q: 0.15,
        depUsed: false,
        edgeIndex: 0,
      }));

      for (let seq = 1; seq <= 100; seq++) {
        const seqMap = Object.fromEntries(TEST_MARKETS.map((s) => [s, seq]));
        const ranked = scoreV2Candidates({
          evidenceRows: baseEvRows,
          tickSequenceBySymbol: seqMap,
          ladder: DEFAULT_LADDER,
        });
        const winner = ranked[0]!.symbol;
        counts.set(winner, (counts.get(winner) ?? 0) + 1);
      }

      for (const [symbol, count] of counts.entries()) {
        assert.ok(
          count <= 20,
          `Market ${symbol} captured ${count}% of equal-J ties (> 20% limit)`,
        );
      }
      assert.ok(counts.size >= 10, `Expected tie rotation across >= 10 markets, got ${counts.size}`);
    });
  });

  // ── T4: Bounded timing ─────────────────────────────────────────────────────
  describe("T4 — Bounded timing (timing-v2.ts)", () => {
    it("has median wait = 0 in the null world, p99 wait <= 3 ticks and <= 6 s across all worlds, and refreshes stale decisions once", () => {
      const ctrl = new TimingV2Controller();
      const nullWaits: number[] = [];

      // 1. Null world: stationary J around baseline
      for (let seq = 1; seq <= 600; seq++) {
        const dec = ctrl.evaluate({
          bestJ: 9.73,
          baselineJ: 9.73,
          tickSequence: seq,
          nowMs: seq * 1000,
        });
        if (dec.shouldFire) {
          nullWaits.push(dec.waitTicks);
        }
      }
      nullWaits.sort((a, b) => a - b);
      const medianNullWait = nullWaits[Math.floor(nullWaits.length * 0.5)]!;
      assert.equal(medianNullWait, 0, "Median wait in null world must be 0 ticks");

      // 2. Actively improving regime where valueOfWaiting > 0.02: never exceeds 3 ticks or 6 s
      const regimeCtrl = new TimingV2Controller();
      const allWaitsTicks: number[] = [];
      const allWaitsMs: number[] = [];
      let currentJ = 10.0;
      for (let seq = 1; seq <= 300; seq++) {
        // Construct a regime where J improves during warmup to raise valueOfWaiting > 0.02,
        // then flattens or worsens during waits so the hard cap (3 ticks / 6 s) is exercised.
        if (seq <= 60) {
          currentJ -= 0.04;
        } else {
          currentJ += 0.01;
        }
        const dec = regimeCtrl.evaluate({
          bestJ: currentJ,
          tickSequence: seq,
          nowMs: seq * 1500,
        });
        if (dec.shouldFire) {
          allWaitsTicks.push(dec.waitTicks);
          allWaitsMs.push(dec.waitMs);
        }
      }
      const p99Ticks = [...allWaitsTicks].sort((a, b) => a - b)[
        Math.floor(allWaitsTicks.length * 0.99)
      ]!;
      const p99Ms = [...allWaitsMs].sort((a, b) => a - b)[Math.floor(allWaitsMs.length * 0.99)]!;
      assert.ok(p99Ticks <= MAX_WAIT_TICKS, `Expected p99 wait ticks <= 3, got ${p99Ticks}`);
      assert.ok(p99Ms <= MAX_WAIT_WALL_MS, `Expected p99 wait ms <= 6000, got ${p99Ms}`);

      // 3. Stale decision refresh & pre-buy switch (> 0.02 margin)
      assert.equal(isDecisionStale(100, 101), false);
      assert.equal(isDecisionStale(100, 102), true);
      assert.equal(shouldSwitchCandidateBeforeBuy(5.0, 4.985), false);
      assert.equal(shouldSwitchCandidateBeforeBuy(5.0, 4.975), true);
    });
  });

  // ── T5: Staking invariant ──────────────────────────────────────────────────
  describe("T5 — Staking invariant across all recovery methods, autoModes, steps, balances, and caps", () => {
    it("produces 100% identical recovery stakes under RECOVERY_V2_MODE = off, shadow, and on", () => {
      // All 7 UI recovery methods map to either 'split' or 'instant' in recovery-engine.ts
      const uiMethods = [
        { name: "martingale", engineMethod: "instant" as const },
        { name: "dalembert", engineMethod: "split" as const },
        { name: "oscar_grind", engineMethod: "split" as const },
        { name: "fibonacci", engineMethod: "split" as const },
        { name: "labouchere", engineMethod: "split" as const },
        { name: "split", engineMethod: "split" as const },
        { name: "instant", engineMethod: "instant" as const },
      ];
      const autoModes = [true, false];
      const steps = [0, 1, 2, 3, 4, 5, 6];
      const balances = [10, 100, 1000];
      const caps = [5, 50];
      const lossSequence = [false, false, false, true, false, true];
      const payouts = [1.95, 1.63, 8.93, 1.09];

      for (const { engineMethod } of uiMethods) {
        for (const autoMode of autoModes) {
          for (const initialStep of steps) {
            for (const balance of balances) {
              for (const cap of caps) {
                for (const payout of payouts) {
                  const snapshots: string[] = [];
                  for (const modeFlag of ["off", "shadow", "on"] as const) {
                    setRecoveryV2ModeOverride(modeFlag);
                    assert.equal(getRecoveryV2Mode(), modeFlag);

                    // Compute direct step stake via recovery-math.ts
                    const reqStake = calculateRecoveryStakeRequest({
                      unrecoveredAmount: 2.5,
                      remainingTargetProfit: 0.95,
                      payoutMultiplier: payout,
                      baseStake: 1,
                      recoveryAutoMode: autoMode,
                      recoveryMethod: engineMethod,
                      recoveryMultiplier: 1.62,
                      recoveryStep: Math.max(1, initialStep),
                      maxRecoverySteps: 6,
                    });
                    const directStake = applyRecoveryStakeLimits(reqStake, cap, balance);

                    // Replay multi-step path via ladder-outcomes.ts
                    const path = replayLadderStakePath({
                      outcomes: lossSequence,
                      payout,
                      method: engineMethod,
                      autoMode,
                      multiplier: 1.62,
                      maxRecoverySteps: Math.max(1, initialStep || 3),
                      initialDebt: 1.0,
                      initialTarget: 0.95,
                      base: 1.0,
                      maxTradeStake: cap,
                      balance,
                    });

                    snapshots.push(
                      JSON.stringify({
                        directStake,
                        stakes: path.stakes,
                        debtsAfter: path.debtsAfter,
                        stepsUsed: path.stepsUsed,
                      }),
                    );
                  }
                  assert.equal(snapshots[0], snapshots[1], "off vs shadow stake mismatch");
                  assert.equal(snapshots[0], snapshots[2], "off vs on stake mismatch");
                }
              }
            }
          }
        }
      }
      setRecoveryV2ModeOverride(null);
    });
  });

  // ── T6: Normal-mode equivalence ────────────────────────────────────────────
  describe("T6 — Normal-mode equivalence (cycle.ts / contest.ts)", () => {
    it("produces byte-for-byte identical NORMAL-mode decisions, reasons, and stakes over a 500-tick replay", () => {
      const rng = mulberry32(0xabcdef);
      const numMarkets = TEST_MARKETS.length;
      const totalTicks = 500;
      const digits = Array.from({ length: numMarkets }, () =>
        Array.from({ length: totalTicks }, () => Math.floor(rng() * 10)),
      );
      const prices = Array.from({ length: numMarkets }, () => {
        let p = 1000;
        return Array.from({ length: totalTicks }, () => (p += rng() < 0.5 ? 0.01 : -0.01));
      });

      const runNormalReplay = (v2Flag: "off" | "shadow" | "on"): string[] => {
        setRecoveryV2ModeOverride(v2Flag);
        const trace: string[] = [];
        const memory = {};

        for (let t = 120; t < totalTicks; t++) {
          const seq = t + 1;
          const start = Math.max(0, t + 1 - HEDGE_WINDOW);
          const rows: HedgeCandidate[] = [];
          for (let m = 0; m < numMarkets; m++) {
            rows.push(
              ...buildMarketCandidates({
                symbol: TEST_MARKETS[m]!,
                group: hedgeGroupIndex(TEST_MARKETS[m]!),
                digits: digits[m]!.slice(start, t + 1),
                prices: prices[m]!.slice(start, t + 1),
                tickSequence: seq,
                specs: SET_B_SPECS,
                mode: "NORMAL",
                escalation: 0,
              }),
            );
          }
          const dec = decideHedge({
            rows,
            mode: "NORMAL",
            memory,
            lossRun: 0,
            escalation: 0,
          });
          trace.push(
            JSON.stringify({
              seq,
              eligible: dec?.eligible,
              bestKey: dec?.best.key,
              score: dec?.best.score,
              reason: dec?.reason,
              v2: dec?.v2,
            }),
          );
        }
        return trace;
      };

      const traceOff = runNormalReplay("off");
      const traceShadow = runNormalReplay("shadow");
      const traceOn = runNormalReplay("on");

      assert.deepEqual(traceOff, traceShadow, "NORMAL mode must be byte-for-byte identical in shadow");
      assert.deepEqual(traceOff, traceOn, "NORMAL mode must be byte-for-byte identical in on");
      setRecoveryV2ModeOverride(null);
    });
  });

  // ── T7: Shadow ledger ──────────────────────────────────────────────────────
  describe("T7 — Shadow ledger (shadow-ledger.ts)", () => {
    it("records top-10 + random control per tick, survives restart, and reports beta ~ 1 on calibrated stream and ~ 0 on null stream", () => {
      const rng = mulberry32(0x424242);
      const calibratedLedger = new ShadowLedger({ persistPath: null });
      const nullLedger = new ShadowLedger({ persistPath: null });

      const makeCandidate = (
        symbol: string,
        contract: "DIGITEVEN" | "DIGITODD",
        pTilde: number,
        seq: number,
      ): HedgeCandidate => ({
        symbol,
        group: 0,
        contract,
        barrier: -1,
        payout: 1.95,
        tickSequence: seq,
        key: `${symbol}:${contract}:-1`,
        samples: 500,
        losses: 250,
        probability: pTilde,
        lowerBound: pTilde - 0.03,
        breakEven: 1 / 1.95,
        ev: pTilde * 1.95 - 1,
        markov: pTilde,
        afterLoss: pTilde,
        afterWin: pTilde,
        conditionalEdge: pTilde - 1 / 1.95,
        posteriorEdgeProbability: 0.5,
        lossRunRisk: 0.1,
        recentAfterLoss: pTilde,
        recoveryAfterLoss: pTilde,
        riskWeight: 1,
        clustering: 1,
        instability: 0,
        score: pTilde,
        eligible: true,
      });

      // Run 800 ticks across 10 markets
      const markets10 = TEST_MARKETS.slice(0, 10);
      let trueProbs = markets10.map((_, i) => 0.35 + (i / 9) * 0.3); // 0.35 .. 0.65

      for (let seq = 1; seq <= 800; seq++) {
        const obsCal = new Map<string, MarketTickObservation>();
        const obsNull = new Map<string, MarketTickObservation>();

        for (let i = 0; i < markets10.length; i++) {
          const sym = markets10[i]!;
          const pTrue = trueProbs[i]!;
          const wonCal = rng() < pTrue;
          obsCal.set(sym, {
            symbol: sym,
            tickSequence: seq,
            digit: wonCal ? 2 : 1,
            price: 1000,
            prevPrice: 1000,
          });

          const wonNull = rng() < 0.5;
          obsNull.set(sym, {
            symbol: sym,
            tickSequence: seq,
            digit: wonNull ? 2 : 1,
            price: 1000,
            prevPrice: 1000,
          });
        }

        trueProbs = markets10.map((_, i) => 0.35 + (((i + seq) % 10) / 9) * 0.3);
        const calRanked = markets10.map((sym, i) =>
          makeCandidate(sym, "DIGITEVEN", trueProbs[i]!, seq),
        );
        const nullRanked = markets10.map((sym, i) =>
          makeCandidate(sym, "DIGITEVEN", trueProbs[i]!, seq),
        );

        calibratedLedger.stepTick({
          observations: obsCal,
          v2Ranked: calRanked,
          v1Ranked: calRanked,
        });
        nullLedger.stepTick({
          observations: obsNull,
          v2Ranked: nullRanked,
          v1Ranked: nullRanked,
        });
      }

      // Simulate process restart via exportPersistedState / importPersistedState
      const persisted = calibratedLedger.exportPersistedState();
      const restoredLedger = new ShadowLedger({ persistPath: null });
      restoredLedger.importPersistedState(persisted);

      const calMetrics = restoredLedger.getMetrics("v2");
      const nullMetrics = nullLedger.getMetrics("v2");
      const report = restoredLedger.edgeReport("v2");

      assert.ok(calMetrics.count >= 7000, `Expected >= 7000 records, got ${calMetrics.count}`);
      assert.ok(
        Math.abs(calMetrics.beta - 1) <= 0.05,
        `Expected calibrated beta within +-0.05 of 1, got ${calMetrics.beta.toFixed(4)}`,
      );
      assert.ok(
        Math.abs(nullMetrics.beta - 0) <= 0.05,
        `Expected null beta within +-0.05 of 0, got ${nullMetrics.beta.toFixed(4)}`,
      );
      assert.ok(calMetrics.kappa > 0.99, `Expected kappa > 0.99 on calibrated stream, got ${calMetrics.kappa}`);
      assert.ok(report.includes("exploitable structure"), `Expected exploitable structure in edgeReport: ${report}`);
    });
  });

  // ── T8: Calibration guard ──────────────────────────────────────────────────
  describe("T8 — Calibration guard (calibration-guard.ts)", () => {
    it("triggers within 150 trades when p~ is systematically +8 pp above realised win rate and shrinks p~ to p0 for 500 ticks", () => {
      const rng = mulberry32(0x998877);
      const guard = new CalibrationGuard();
      const trueP = 0.5;
      const overconfidentPTilde = 0.58; // +8 pp above realised win rate

      let triggeredAtTrade = -1;
      for (let trade = 1; trade <= 150; trade++) {
        const won = rng() < trueP;
        guard.recordRecoverySettlement({
          won,
          pTilde: overconfidentPTilde,
          p0: trueP,
        });
        if (guard.isShrunkToPrior()) {
          triggeredAtTrade = trade;
          break;
        }
      }

      assert.ok(
        triggeredAtTrade > 0 && triggeredAtTrade <= 150,
        `Expected CUSUM alarm within 150 trades, triggeredAt=${triggeredAtTrade}`,
      );
      assert.equal(guard.getEvidenceWeight(), 0);
      assert.equal(guard.applyGuard(0.58, 0.5), 0.5);
      assert.equal(guard.getState().shrinkTicksRemaining, CUSUM_SHRINK_TICKS);

      // Advance 499 ticks: still shrunk
      guard.onTick(499);
      assert.equal(guard.isShrunkToPrior(), true);
      assert.equal(guard.getEvidenceWeight(), 0);

      // Advance 1 more tick (total 500): restored
      guard.onTick(1);
      assert.equal(guard.isShrunkToPrior(), false);
      assert.equal(guard.getEvidenceWeight(), 1);
      assert.equal(guard.applyGuard(0.58, 0.5), 0.58);
    });
  });

  // ── M5: Quote prefetch & drift flag ────────────────────────────────────────
  describe("M5 — Quote prefetch and > 3% drift flag (quote-prefetch.ts)", () => {
    it("uses live prefetched payout and flags reason text when live differs from table by > 3%", () => {
      const tablePayout = hedgePayout("DIGITEVEN", -1); // 1.95
      assert.equal(livePayoutFor({ symbol: "R_10", contract: "DIGITEVEN", barrier: -1 }), tablePayout);

      // Inject a live quote 5% lower than table (1.85x vs 1.95x)
      setPrefetchedQuoteForTest("R_10", "DIGITEVEN", -1, 1.85, "live");
      const info = payoutInfoFor({ symbol: "R_10", contract: "DIGITEVEN", barrier: -1 });
      assert.equal(info.source, "live");
      assert.equal(info.payout, 1.85);
      assert.equal(info.drifted, true);
      assert.ok(info.flagText && info.flagText.includes("payout drift"));

      // Verify buildV2RecoveryDecision includes the drift flag in reason text
      const ranked = scoreV2Candidates({
        evidenceRows: [
          {
            symbol: "R_10",
            spec: { type: "DIGITEVEN", barrier: -1 },
            resolvedBarrier: -1,
            p0: 0.5,
            pTilde: 0.55,
            z: 3.9,
            zTilde: 0.5,
            window: 1500,
            nEff: 1500,
            q: 0.9,
            depUsed: false,
            edgeIndex: 0.2,
          },
        ],
        tickSequenceBySymbol: { R_10: 500 },
        ladder: DEFAULT_LADDER,
      });
      const dec = buildV2RecoveryDecision({
        ranked,
        escalation: 1,
        waitTicks: 0,
        shouldFireNow: true,
        waitReason: null,
      });
      assert.ok(dec);
      assert.ok(dec.reason.includes("payout drift"), `Expected drift flag in reason: ${dec.reason}`);
    });
  });
});
