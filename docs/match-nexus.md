# Match Nexus — Matches-only, tick-driven execution

Match Nexus (`match-nexus`, console `match-nexus@1`) replaces the previously unwired Nexus prototype with a dedicated model, execution lifecycle and console. **Normal and recovery orders are always one-tick `DIGITMATCH`.** It does not switch into Differs after a loss streak.

This is an evidence-driven trading tool, not a promised win rate. On independent, uniformly distributed digits, a named digit has a 10% match probability. At an indicative 8.93× total return that is −10.7% expected return per dollar staked. Markov models, timing and recovery cannot manufacture an edge in that stream.

## User flow

1. Open **AI Bots → Match Nexus**, or `/bots?open=match-nexus`.
2. Choose Active/Balanced/Patient pacing, automatic or fixed digit, base stake, session stop-loss/take-profit and the existing recovery step-label cap. Paper execution is the default.
3. **Scan markets first.** The server measures eligible digit markets, labels the data provenance and returns a ranked report, not an executable model supplied by the client.
4. **After the scan**, select a market and choose **locked** or **allow market switching**. A lock fixes the symbol; automatic digit selection can still adapt within that symbol. Switching starts at the selected market and compares the scanned pool with dwell time and hysteresis.
5. Deploy means watch for a **fresh qualifying tick**, not buy immediately. Live mode also requires a live-source scan, an active Deriv account, global paper mode disabled and separate confirmation.
6. Closing the console does not stop a session. Reopen it through the global engine indicator. **Stop** cancels unsent work and drains any already-sent live contract before releasing execution ownership.

The console includes next-digit distributions, held-out results, model weights, a recovery stress scenario, session recovery/P&L, feed provenance and measured execution timing. Paper P&L is explicitly labelled in both the console and global indicator. The changing next-tick view is **not** the frozen order currently settling. Missing measurements are not rendered as zero accuracy.

## Analysis and pacing

- One incremental multiclass model compares all ten digits. The six experts are a fair baseline, slow/fast discounted frequencies, first-/second-order Markov transitions and empirical renewal hazards. A digit's absence alone is not evidence that it is “due.”
- Expert weights are earned by **past** predictive log scores. Markov counts use a bounded 2,048-tick ring; prediction is read-only. Repeated prices/digits still advance the sequence.
- Up to 4,999 source-verified digits per market; at least 300 are required. History requests are coalesced/cached, with four scan workers overlapping I/O. Missing broker history may fall back to a clearly labelled contiguous buffer; simulated and broker history are never merged.
- The first 60% trains calibration and pacing. Calibration shrinks towards the fair 10% baseline. The remaining ticks are replayed causally: **predict → select digit/decide → reveal outcome → update**. The held-out suffix cannot choose its own calibration or threshold.
- The same payout-aware entry rule is used in replay and execution:

  ```text
  utility = (estimated probability − profile weight × uncertainty proxy) × total-return multiplier − 1
  ```

  The uncertainty term is an epistemic/model-disagreement proxy, **not a confidence interval**. Active/Balanced/Patient have target entry fractions of 45%/28%/15% for fitting pacing, not quotas. Waiting relaxes pacing but never below 0.005 positive utility. There is no extra entropy/gap/evidence-label gate stack.

- The report includes Wilson sampling intervals, hit count/rate, Brier/log-loss skill, historical return, calibration and loss runs. Cross-market multiplicity correction affects the **diagnostic evidence label**, not another hard entry filter. Sampling intervals are not simultaneous guarantees for whichever market the user selects.
- Monte Carlo is a **risk scenario**, not a next-digit oracle: 512 seeded paths, up to 100 entries, a posterior two-state win/loss chain, fair prior, existing recovery sizing and configured limits. It excludes latency/slippage, assumes the fitted environment persists and is sensitive to small samples. Simulated-price structure can produce impressive fits that do not transfer to broker data.

## Recovery is reused, not reinvented

Uses `calculateBotRecoveryStake`, the shared `reduceRecoveryOutcome`, cent rounding, the $0.35 minimum and existing limits:

```text
requested recovery stake = debt × (1 + botRecoveryMarkup / 100) / (actual payout multiplier − 1)
```

A partial win pays debt down; it does not prematurely reset recovery. The existing step setting caps the displayed progression, **not** the number of recovery attempts. Existing account day-rollover policy is unchanged.

Actual broker payout sizes recovery. At most one resize/requote is permitted per entry; an unstable payout waits for another tick. Balance, maximum stake and remaining session stop budget cap exposure. Zero/subminimum headroom stops entry rather than becoming an unlimited/default limit.

Paper mode uses the same reducer in a private ledger and a separate $10,000 starting bankroll. It never writes live trade rows or account debt. Cold live startup restores persisted debt even if an earlier status read allocated an empty state; warm outcomes, journal synchronization and explicit resets remain authoritative.

## Execution invariants

1. Scan capabilities are owner-bound, single-use and expire after 180 seconds. Input parsing rejects client model cards, stake changes on deploy, contract overrides and unscanned symbols.
2. A dedicated account-scoped arbiter lease excludes other app executors. Only one quote/buy/settlement task is outstanding; the entry's digit, decision and tick are frozen.
3. Risk/account verification → proposal → optional recovery resize/requote → actual-payout utility check → durable purchase intent → guarded pooled buy.
4. Ownership, stop state, exact tick sequence/generation/source and remaining tick time are rechecked **at socket send**, not just enqueue. Minimum headroom is 250 ms, adapted upwards using measured buy p95. This reduces stale sends; it cannot guarantee the broker's entry tick or eliminate network delay.
5. The account's persistent connection is reused. A definitive rejection cancels the intent without changing recovery. **An ambiguous sent buy is never automatically repeated.** A unique correlation tag is persisted before send and contains no browser/session credential. Echoed `passthrough.nexus_intent` can recover a delayed acknowledgement/rejection after the request timeout; unrelated receipts are ignored.
6. A known broker ID must match exactly during reconciliation. An unknown-ID Nexus pending row is never matched by stake/time proximity. Live restarts refuse unresolved Nexus intents or other open account trades.
7. Contract ID storage and settlement/commit errors retain the lease and retry the bookkeeping, not the purchase. Final journal status and recovery JSON are committed in one transaction with an idempotency marker, then the shared in-memory ledger is seeded. No second `recordOutcome` is applied.
8. Paper settlement uses the **first next sequence**, even if the digit and price repeat. A generation/source change or missing settlement sequence is unscorable, not a guessed win/loss. Stop can finish a stalled paper session without inventing an outcome.

### Unresolved-order operations

An `attention` state is deliberately conservative. Do not keep pressing Deploy or restart the process to “unlock” it. Let a late correlated receipt/confirmed settlement arrive, or inspect the account's broker journal with an operator. If the process lost an acknowledgement, link a durable intent only to a **verified exact contract ID**, and reconcile its actual settlement. If no purchase occurred, cancellation likewise requires broker verification. There is no speculative auto-cancel/auto-rebuy or new UI action that guesses this linkage. Until resolved, another Nexus deployment stays blocked.

The arbiter and scan capabilities are **process-local**. Use a single API execution worker; distributed execution requires durable/advisory ownership before horizontal scaling. This PR does not redesign the platform's authentication or other executors' restart behaviour. Before using live funds, fix the existing session/auth baseline issues below and verify broker/account permissions, latency, feed alignment and risk controls on a Deriv demo account. No real-account trading or live-market accuracy validation was performed for this change.

## API and files

| Endpoint                           | Purpose                                          |
| ---------------------------------- | ------------------------------------------------ |
| `GET /api/bots/match-nexus/status` | Owner-scoped current/last session                |
| `POST /api/bots/match-nexus/scan`  | Validated config → measured markets + capability |
| `POST /api/bots/match-nexus/start` | `{ scanId, symbol, marketMode, confirmLive }`    |
| `POST /api/bots/match-nexus/stop`  | Cancel unsent work / drain sent work             |

The catalogue, common bot status, live registry, SSE and global Open/Stop paths include Nexus. The generic specialist endpoint cannot widen its contracts. No schema migration or new production dependency is required.

Main modules under `artifacts/api-server/src/lib/`:

- `match-nexus-analysis.ts`: model, causal policy validation and risk scenarios.
- `match-nexus-policy.ts`: strict wire validation, recovery limits and send-time guards.
- `match-nexus-data.ts`: provenance-aware history/cache/merge.
- `match-nexus-runner.ts`: injectable tick/quote/buy/settle lifecycle.
- `match-nexus-engine.ts`: owner-scoped orchestration, broker adapter and durable journal.

Frontend: `components/match-nexus-console.tsx` and `lib/match-nexus.ts` in `artifacts/trading-platform/src/`.

## Verification (2026-09-20)

```sh
pnpm test:nexus
pnpm --filter @workspace/api-server bench:nexus
pnpm test
pnpm typecheck
pnpm build:api
pnpm build:web
```

- **77 focused tests passed**: 63 API tests, 14 frontend helper/console-registry tests. Includes causal-prefix invariance, seeded IID/planted structure, repeated ticks, strict inputs, actual route/PGlite journal integration, cold/warm recovery restoration, account isolation, stop races, payout resizing, ambiguous purchases, missed paper ticks and exact-ID reconciliation. Transport tests use the real pooled adapter against a **local fake** OTP/WebSocket broker, including late acknowledgements, unrelated intent tags and delayed definitive rejections.
- Full suite: API **314/319 passed**, frontend **21/21 passed**. The five failures in unchanged `session-isolation.test.ts` also reproduce against an isolated archive of base commit `3571ac1`: header/cookie priority, SSE tab identity, independent tabs, header risk acknowledgement and durable client rebinding.
- Library/frontend/other workspace typechecks pass. The API still reports the **same six pre-existing `auth.ts` type errors** concerning `isTabSession`/`clientId`, observed before feature edits. The root `build` includes that failing typecheck; the standalone API and Vite production builds both pass. Vite reports sourcemap/large-chunk warnings.
- Chromium desktop (1440×1080) and mobile (390×844) smoke checks passed: deep-link opening, paper default, scan-before-mode-choice, switching deployment, reload/reopen, stop, close clearing the deep link and no horizontal overflow or page errors. Actual UI runs used **simulated market data**, not an authenticated broker.

### Reproducible CPU microbenchmark

One local Node 22.22.3 run of `bench:nexus` (synthetic IID digits, warmed JIT):

| Measurement                                                  |           Result |
| ------------------------------------------------------------ | ---------------: |
| 19 market analyses × 4,999 digits (including risk scenarios) | 1,121.5 ms total |
| Average per-market analysis                                  |         58.69 ms |
| 10,000 incremental observe + predict updates: median         |        0.0061 ms |
| Incremental update p95                                       |        0.0109 ms |

These are **local CPU timings, not broker execution latencies, service SLOs or evidence of profitability**. History/network/DB I/O, browser rendering and multi-account contention are excluded. Re-run on deployment hardware; use the console's quote/buy/signal-to-send telemetry to measure actual execution separately.
