# Prism Match — Matches-only, prismatic tick-driven execution

Prism Match (`prism-match`, console `prism-match@1`) is an institutional-grade, Matches-only specialist that replaces Match Nexus. **Normal and recovery orders are always one-tick `DIGITMATCH`.** It keeps Matches recovery but never widens into Differs.

This is an evidence-driven tool, not a promise. On uniformly distributed digits a named digit matches 10% of the time; at an indicative 8.93× total return the expected return is −10.7% per dollar staked. Statistics, probability models and timing cannot create an edge in an IID stream.

## User flow

1. Open **AI Bots → Prism Match**, or `/bots?open=prism-match`.
2. Choose Active/Balanced/Patient pacing, automatic or fixed digit, base stake, stop-loss/take-profit and the recovery cap. Paper execution is the default.
3. **Scan markets first.** The server measures eligible digit markets, labels data provenance and returns a ranked report.
4. After the scan, pick a market and **locked** vs **allow switching**. Locked fixes the symbol; automatic digit selection still adapts inside that symbol. Switching starts at the selected market and uses dwell (6 ticks) + 0.03 utility hysteresis.
5. Deploy watches for a **fresh qualifying tick**; it never buys on deploy. Live mode also requires a live-source scan, an active Deriv account, global paper mode off and a separate confirmation.
6. Closing the console does not stop a session. Re-open via the global engine indicator. **Stop** cancels unsent work and drains any already-sent live contract before releasing ownership.

The console shows next-digit distributions, held-out results, CTW model weights, recovery stress, session P&L/recovery, provenance and measured execution timing. Paper P&L is explicitly labelled. The live next-tick view is not the frozen settling order. Missing measurements are shown honestly, not as zero accuracy.

## Analysis and pacing

- One causal multiclass model covers all ten digits. Seven experts: uniform baseline, two discounted frequencies (slow/fast EWMA), first- and second-order Markov with fixed order-3 context + exponential smoothing, and two renewal hazards (Laplace / empirical). No “due number” assumption.
- Expert weights are earned by **past** predictive log scores via Context Tree Weighting (n=3). The 3,072-tick rolling ring is bounded; prediction is read-only. Duplicate price/digit still advances the sequence.
- Up to 4,999 source-verified digits per market; ≥300 required. History requests are coalesced/cached with four scan workers. Missing broker history may fall back to a clearly labelled contiguous buffer; simulated and broker histories are never merged.
- First 60% (≥300 ticks) trains calibration/pacing. Calibration shrinks toward the fair 10% baseline (10 pseudocounts). The remaining ticks replay causally: **predict → pick digit/decide → reveal → update**. The held-out suffix never picks its own calibration or threshold.
- Same payout-aware rule in replay and execution:

  ```
  utility = (calibrated p − 0.04/0.18/0.40 × uncertainty) × total-return − 1
  ```

  Active/Balanced/Patient target fractions are 42%/26%/14% for fitting pacing, not quotas. Waiting relaxes pacing but never below 0.002 positive utility. No stacked entropy/gap/evidence gates.

- Report includes Wilson intervals, hit count/rate, Brier/log-loss skill, return, calibration and loss runs. Cross-market multiplicity correction only affects the diagnostic evidence label.
- Monte Carlo is a **risk scenario**, not a digit oracle: 512 seeded paths, ≤100 entries, posterior Dirichlet/Beta chain, fair prior, actual recovery sizing and limits. Excludes latency/slippage, assumes fitted regime persists, sensitive to small samples.

## Recovery (reused)

Uses the shared `calculateBotRecoveryStake` / `reduceRecoveryOutcome`, cent rounding, $0.35 minimum:

```
requested stake = debt × (1 + markup/100) / (payout − 1)
```

Partial wins pay debt down; step setting caps displayed progression, not attempts. Day-rollover policy unchanged. Actual broker payout sizes recovery with at most one resize/requote per entry; unstable payout waits for next tick. Balance, max stake and remaining stop budget cap exposure.

Paper uses the same reducer in a private ledger with a separate $10,000 bankroll.

## Execution invariants

1. Scan capabilities are owner-bound, single-use, 180 s TTL. Input validation rejects client model cards, stake changes on deploy, contract overrides, unscanned symbols.
2. Dedicated account lease excludes other executors. Only one quote/buy/settlement is outstanding; digit/decision/tick are frozen.
3. Risk check → proposal → optional resize/requote → payout utility check → durable intent → guarded pooled buy.
4. Ownership, stop state, exact tick sequence/generation/source and remaining tick time are re-checked **at socket send**. Minimum headroom 250 ms, adapted from p95 buy latency.
5. Persistent account connection is reused. Definitive rejection cancels intent without recovery change. **Ambiguous sent buys are never retried.** Correlation tag persisted before send contains no credentials. Echoed `passthrough.prism_intent` recovers late acks/rejections.
6. Known contract IDs must match exactly; unknown-ID rows are never matched by stake/time proximity. Live restarts refuse unresolved intents/open trades.
7. Contract-ID storage and settlement/commit errors retain the lease and retry bookkeeping, not the purchase. Journal + recovery commit is atomic with idempotency marker.
8. Paper settlement uses the first next sequence even if digit/price repeats. Generation/source change or missing sequence is unscorable.

### Unresolved-order ops

`attention` is conservative. Do not redeploy to unlock. Let a late correlated receipt/settlement arrive or inspect the broker journal. Link a durable intent only to a verified exact contract ID.

The arbiter and scan capabilities are process-local — use a single API worker; horizontal scaling needs durable ownership. Fix baseline auth/session issues before live use and verify on Deriv demo.

## API and files

| Endpoint | Purpose |
|---|---|
| `GET /api/bots/prism-match/status` | Owner-scoped current/last session |
| `POST /api/bots/prism-match/scan` | Validated config → markets + capability |
| `POST /api/bots/prism-match/start` | `{ scanId, symbol, marketMode, confirmLive }` |
| `POST /api/bots/prism-match/stop` | Cancel unsent / drain sent |

Catalogue, live registry, SSE and global paths include Prism Match. Specialist endpoint cannot widen contracts. No migration or new dep required.

Modules `artifacts/api-server/src/lib/`:

- `prism-match-analysis.ts` — CTW model, causal validation, risk scenarios.
- `prism-match-policy.ts` — wire validation, recovery limits, send-time guards.
- `prism-match-data.ts` — provenance-aware history/cache/merge.
- `prism-match-runner.ts` — tick/quote/buy/settle lifecycle.
- `prism-match-engine.ts` — owner orchestration, broker adapter, durable journal.
- `prism-match-transport.ts` — pooled broker transport.

Frontend: `components/prism-match-console.tsx` and `lib/prism-match.ts`.

## Verification (2026-09-21)

```sh
pnpm test:prism
pnpm --filter @workspace/api-server bench:prism
pnpm test
pnpm typecheck
pnpm build:api
pnpm build:web
```

- 63 API + 14 frontend Prism tests pass (causal invariance, seeded IID/planted, repeat ticks, strict inputs, route/PGlite journal, recovery, stop races, payout resize, ambiguous buys, exact-ID recon — transport via local fake broker).
- Full suite: API 350/355 pass, frontend 21/21 pass; 5 failures are pre-existing `session-isolation.test.ts` also on base commit.
- Typechecks: libs + frontend pass; API reports same six pre-existing `auth.ts` `isTabSession`/`clientId` errors. API and Vite builds pass.
- Chromium desktop/mobile smoke: deep-link, paper default, scan-before-mode, switching deploy, reload/reopen, stop, no overflow.
