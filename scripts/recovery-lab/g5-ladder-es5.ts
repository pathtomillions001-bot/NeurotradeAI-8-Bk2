/**
 * G5 — the recovery ladder is frozen: worst-5% episode P&L (ES5) must be
 * NUMERICALLY UNCHANGED from the pre-change baseline, for Instant and Split.
 *
 * This harness prints a deterministic digest of ES5 over a fixed input grid, so
 * it can be run on two different trees and the outputs diffed byte-for-byte:
 *
 *   npx tsx scripts/recovery-lab/g5-ladder-es5.ts > /tmp/g5-branch.txt
 *   npx tsx /tmp/base-tree/scripts/recovery-lab/g5-ladder-es5.ts > /tmp/g5-base.txt
 *   diff /tmp/g5-base.txt /tmp/g5-branch.txt && echo IDENTICAL
 *
 * It imports only `../recovery-math` and `./ladder-outcomes` (via the ladder
 * simulator), which are the frozen modules; the grid therefore exercises the
 * real stake request/limit/settlement functions rather than re-deriving them.
 */

import { createHash } from "node:crypto";
import { simulateEpisodeStats } from "../../artifacts/api-server/src/lib/autonomous-hedge/ladder-outcomes";

const P_VALUES = [0.1, 0.2, 0.35, 0.45, 0.5, 0.55, 0.65, 0.9];
const PAYOUTS = [1.63, 1.95, 5.2, 9.0];
const METHODS: Array<"instant" | "split"> = ["instant", "split"];
const AUTO_MODES = [true, false];
const MULTIPLIERS = [1.5, 1.62, 2.0];
const STEPS = [1, 2];
const MAX_STEPS = [3, 5];
const DEBTS = [1, 2.5];
const N_STOPS = [6, 8];

interface Row {
  p: number;
  payout: number;
  method: "instant" | "split";
  autoMode: boolean;
  multiplier: number;
  step: number;
  maxRecoverySteps: number;
  debt: number;
  nStop: number;
  es5: number;
  meanPnl: number;
  pStop: number;
  meanTrades: number;
}

function run(): Row[] {
  const rows: Row[] = [];
  for (const p of P_VALUES)
    for (const payout of PAYOUTS)
      for (const method of METHODS)
        for (const autoMode of AUTO_MODES)
          for (const multiplier of MULTIPLIERS)
            for (const step of STEPS)
              for (const maxRecoverySteps of MAX_STEPS)
                for (const debt of DEBTS)
                  for (const nStop of N_STOPS) {
                    const ep = simulateEpisodeStats({
                      p,
                      payout,
                      method,
                      autoMode,
                      multiplier,
                      step,
                      maxRecoverySteps,
                      debt,
                      targetRemaining: 0.95,
                      base: 1,
                      maxTradeStake: 50,
                      balance: 1000,
                      nStop,
                      paths: 400,
                      horizon: 25,
                      seed: 0x5eed_1234,
                    });
                    rows.push({ p, payout, method, autoMode, multiplier, step, maxRecoverySteps, debt, nStop, ...ep });
                  }
  return rows;
}

const rows = run();

// Digest: every ES5 value to 12 dp, in a fixed order, so any numerical change
// anywhere in the grid changes the hash.
const digestInput = rows
  .map((r) => `${r.method},${r.p},${r.payout},${r.autoMode},${r.multiplier},${r.step},${r.maxRecoverySteps},${r.debt},${r.nStop}:${r.es5.toFixed(12)}`)
  .join("\n");
const digest = createHash("sha256").update(digestInput).digest("hex");

const byMethod = (m: "instant" | "split") => rows.filter((r) => r.method === m);
const es5Of = (m: "instant" | "split") => byMethod(m).map((r) => r.es5);
const worst = (m: "instant" | "split") => Math.min(...es5Of(m));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log("=== G5 · recovery ladder tail (ES5 = mean P&L of worst 5% of episodes) ===");
console.log(`grid cells            : ${rows.length}   (methods x p x payout x auto x mult x step x maxsteps x debt x nStop)`);
console.log(`paths x horizon       : 400 x 25, CRN seed 0x5eed1234`);
console.log("");
for (const method of METHODS) {
  const cells = byMethod(method);
  console.log(
    `${method.padEnd(8)} ES5  min ${worst(method).toFixed(4)}   mean ${mean(es5Of(method)).toFixed(4)}   cells ${cells.length}`,
  );
}
console.log("");
console.log(`es5 digest (sha256)   : ${digest}`);
console.log("");
console.log("reference cells (method p payout auto) : es5 / meanPnl / meanTrades");
for (const method of METHODS) {
  for (const [p, payout] of [[0.5, 1.95], [0.1, 9.0], [0.35, 1.63]] as const) {
    const r = rows.find(
      (x) =>
        x.method === method && x.p === p && x.payout === payout && x.autoMode === true &&
        x.multiplier === 1.62 && x.step === 1 && x.maxRecoverySteps === 3 && x.debt === 1 && x.nStop === 6,
    )!;
    console.log(
      `  ${method.padEnd(8)} p=${p.toFixed(2)} payout=${payout} : ${r.es5.toFixed(4)} / ${r.meanPnl.toFixed(4)} / ${r.meanTrades.toFixed(4)}`,
    );
  }
}
