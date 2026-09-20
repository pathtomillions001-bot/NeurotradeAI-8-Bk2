/** Local CPU benchmark only. Synthetic streams are NOT evidence of market profitability. */
import { evaluateNexus, NexusModel } from "../src/lib/match-nexus-analysis";

let seed = 20260920;
function rng(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const risk = {
  stake: 1,
  stopLoss: 10,
  takeProfit: 10,
  maxStake: 100,
  markupPercent: 10,
  activity: "balanced" as const,
};
// Warm the JIT before reporting latencies.
evaluateNexus(
  Array.from({ length: 1000 }, () => Math.floor(rng() * 10)),
  risk,
);
const began = performance.now();
const analyses = Array.from({ length: 19 }, () =>
  evaluateNexus(
    Array.from({ length: 4999 }, () => Math.floor(rng() * 10)),
    risk,
  ),
);
const scanMs = performance.now() - began;
const model = new NexusModel();
for (let i = 0; i < 2000; i++) model.observe(Math.floor(rng() * 10));
const timings: number[] = [];
for (let i = 0; i < 10_000; i++) {
  const start = performance.now();
  model.observe(Math.floor(rng() * 10));
  model.predict();
  timings.push(performance.now() - start);
}
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      warning:
        "Synthetic CPU benchmark; excludes history I/O, DB, broker latency and real-world trading performance.",
      markets: 19,
      digitsPerMarket: 4999,
      scanMathMs: Number(scanMs.toFixed(1)),
      perMarketAverageMs: Number(
        (
          analyses.reduce((sum, a) => sum + a.analysisMs, 0) / analyses.length
        ).toFixed(2),
      ),
      liveUpdates: timings.length,
      observeAndPredictMedianMs: Number(timings[5000]!.toFixed(4)),
      observeAndPredictP95Ms: Number(timings[9500]!.toFixed(4)),
    },
    null,
    2,
  ),
);
