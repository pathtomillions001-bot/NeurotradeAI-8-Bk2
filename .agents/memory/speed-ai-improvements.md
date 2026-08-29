---
name: SpeedAI engine improvements
description: FAB freeze fix, 1-tick execution latency overlap, intelligent recovery scanner (dual-window consensus)
---

# SpeedAI Engine Improvements

## FAB freeze fix
**Rule:** Never call `setStatus` directly inside an SSE event handler — rapid server broadcasts during active trading cause back-to-back React re-renders inside `AnimatePresence` transitions, visually freezing the panel.

**How to apply:** Batch SSE status updates through `requestAnimationFrame` using a pending-ref pattern:
```ts
pendingStatusRef.current = data;
if (rafRef.current !== null) return;  // already queued
rafRef.current = requestAnimationFrame(() => {
  rafRef.current = null;
  setStatus(pendingStatusRef.current!);
});
```
Also add `es.onerror = () => { es.close(); setTimeout(connect, 2000); }` for auto-reconnect. Poll at 3s when panel is closed (badge), 1s when open.

**Why:** Multiple SSE events per second + framer-motion layout animations = render storm that freezes the panel.

## 1-tick execution: pre-analysis overlap
**Rule:** Market analysis (~50-200ms) must run in parallel with the post-trade sleep, not sequentially before the next trade. Store result in `preAnalyzedScored` and consume at the top of the next iteration.

**How to apply:** After recording a trade outcome, kick off `analyzeMarketsForStrategy()` as a background promise, then `await sleep(500)`, then `await preAnalyzePromise` and store to `preAnalyzedScored`. Skip pre-analysis if the consecutive recovery gate will fire next iteration (it forces its own deep scan).

**Why:** Cuts scan latency from the critical path on every trade.

## Recovery consecutive-loss gate + intelligent scanner
**Rule:** `SpeedRecoveryState` tracks `consecutiveRecoveryLosses` (losses taken while ALREADY in recovery). When ≥ 2, the gate runs `findSafestRecoverySetup()` — NOT a rescan of the user's configured types.

**findSafestRecoverySetup():** Tests ALL OVER barriers (1–8), ALL UNDER barriers (9–1), DIGITDIFF with AI-chosen coldest digit, DIGITEVEN, DIGITODD — across all markets — with dual-window (50t + 150t) consensus validation. A candidate must pass:
1. winProbability ≥ 60% in BOTH windows
2. Positive EV
3. |score_50 − score_150| ≤ 15 (not a noise spike)
Sorted by EV descending. Returns `null` if nothing passes (gate waits 5s and retries).

**`intelligentRecoveryOverride` flag:** When AI selects a setup, this flag is set to true and the normal barrier enforcement (`best.barrier = cfgOver/cfgUnder`) is SKIPPED — the AI has deliberately chosen a different barrier.

**Why:** If the user-configured recovery contract (e.g. OVER 5) keeps losing, scanning it again just reproduces the same losing setup. The intelligent scanner finds whatever IS working right now across the entire market universe.

## FAB recovery indicator
When `consecutiveRecoveryLosses ≥ 2`, the recovery indicator turns red with a pulsing dot and shows "⚡ AI full control — scanning all markets for safest setup". A "Nx loss streak" badge shows the exact count. This gives the user real-time visibility into when the AI takes over.
