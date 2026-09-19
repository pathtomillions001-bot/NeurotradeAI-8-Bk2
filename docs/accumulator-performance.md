# Accumulators bot — performance & efficiency impact

Measured on the sandbox API (`node dist/index.mjs`, PGlite fallback, simulated
tick feed), 2026-09-19. Every number below is a measurement, not an estimate.

## Summary

**The bot costs nothing when it is not running, and about 3 % of one CPU core
while it is actively trading. Nothing it does blocks the rest of the app for
longer than ~13 ms.**

| Dimension | Measurement | What it means for the app |
|---|---|---|
| API CPU — idle | **0.43 %** of one core | baseline with no bot |
| API CPU — bot trading (1 s index, switching mode) | **3.40 %** of one core | **+≈3 %** while a session runs; ~half that on a 2 s index |
| API memory — RSS | 434 MB flat over 120 s running **and** 60 s stopped | **no leak**, no growth attributable to the bot |
| `POST /accumulator/scan` | **116 ms** wall for 19 markets × 5 000 ticks | one-shot request; see below |
| Longest single synchronous block inside a scan | **12.7 ms** (per market; median 5.4 ms) | the route awaits between markets, so the event loop yields |
| Other requests *during* a scan | `/healthz` p90 **8 ms**, max **9 ms** (idle: 6 ms) | **no visible stall** for other users |
| Benjamini–Hochberg step | 0.15 ms | negligible |
| Engine tick loop work | 0.0013 ms per tick | negligible |
| Analysis module cold import (boot) | 4.8 ms | one-off at server start |
| Frontend console | 63.5 kB min / **18.2 kB gzip** | **+4.8 %** of the 376 kB gzip bundle |
| Server analysis module | 16.0 kB minified | trivial next to `deriv.ts` (~3 000 lines) |
| Test suite | 37 cases in ~1.8 s | CI cost only |

## Why it is cheap

1. **No second market feed.** The bot reads the tick history the app already
   keeps in `tickManager`. Adding it opens no new WebSocket subscription, no new
   polling loop, and no timer that fires while the bot is stopped — the engine's
   loop only exists for the lifetime of a session.
2. **The scan runs on the model, not on 19 quotes.** Requesting a live
   Accumulator proposal for every market cost up to 10 s each when quotes cannot
   be served (measured: a **159 s** request that produced nothing usable). The
   scan now uses the modelled band (which reproduces the published bands to
   <0.002 %) and spends **one** quote on the single market being deployed, where
   ground truth actually matters. That is the same request in **116 ms**.
3. **The work is bounded and shallow.** Cost is `markets × history ticks` for the
   scan and O(1) per tick for the live loop. The only knobs are `HISTORY_TICKS`
   (5 000) and `RESCAN_INTERVAL_TICKS` (25).
4. **The scan's CPU work is chunked.** Each market is ~5 ms of synchronous
   statistics, separated by an `await` for that market's history, so Node's event
   loop services other requests in between instead of stalling for the full
   116 ms.

## Where it could get slower (honest limits)

* **Many concurrent sessions.** The cost above is per running session. The
  engine arbiter permits one trading engine per account/session, but several
  users each running their own Accumulator would each add roughly their own
  ~3 %. Ten concurrent sessions on 1 s indices ≈ 30 % of one core.
* **A longer history window.** Raising `HISTORY_TICKS` from 5 000 to 20 000
  would take the scan from ~116 ms to ~460 ms and the longest block from ~13 ms
  to ~50 ms. The default is a deliberate trade-off between statistical power
  (≥ 3 000 ticks needed to see a thin edge) and latency.
* **Frontend first load.** The console adds 18.2 kB gzip to the single Vite
  chunk (already 376 kB gzip and flagged by Vite as oversized). The marginal
  cost is real but small; code-splitting the console would remove even that.
  The bots page itself is unaffected once loaded.
* **The scan is synchronous CPU work.** It cannot be made free — but it is a
  deliberate user action (a button), not a background poll, so it never
  competes with the app unprompted.
