# Match Pulse — Matches-only bot

Implemented 2026-09-19; console revised to the specialist-bot workflow on 2026-09-19. Bot ID: `match-pulse`.

Match Pulse is a **separate bot**, not a renamed Match Sniper or a replacement for Matches/Differs Oracle. It trades only one-tick `DIGITMATCH`, offers market locking or qualified market switching after scanning, and uses Match Sniper's account-debt recovery sizing and settlement rules.

**What has been established:** causal replay, stricter entry qualification, distinct-tick timing, guarded order submission, isolated offline test fixtures, account-driven deployment, recovery parity, and conservative settlement/restart handling pass the tests below. **What has not:** higher real-market accuracy, profitability, or superiority to the existing bots. A fair digit stream offers no predictable Matches edge; abstaining is an intended outcome.

## 1. Audit: what was borrowed and what was changed

Only the Matches use cases of the two requested bots were evaluated. Their existing strategy and entry policies are unchanged. Shared infrastructure changes are limited to the recovery reducer, tick identity, queued-request guards, execution ownership, startup, routing, and test isolation needed by the new bot.

| Existing bot | Strengths retained or developed | Weaknesses addressed in the new bot |
| --- | --- | --- |
| **Match Sniper** (`match`) | Specialized digit analysis; payout-aware reasoning; correction for searching digits; user-selected market lock/switch behavior; shared debt-plus-markup recovery. | Dormancy/“overdue” timing can favor a digit without establishing its next-tick probability. Selection and reported evidence use overlapping observations rather than replaying the complete policy on separate chronological blocks. Recovery retry/control-flow paths and asynchronous quote waits do not uniformly enforce a final socket-send veto. Buffer length is not a reliable clock once a ring buffer is full. Paper outcomes are not consistently the observed next tick. |
| **Matches/Differs Oracle** (`ks-matchdiff`, Matches branch) | Longer tick history; chronological out-of-sample evaluation; whole-policy expectancy; confidence bounds and calibration; separation of scanning and execution. | Its family deployment can continue with an unsuitable measurement. Poll/ring-buffer counters can diverge from actual tick identity. Patience/recovery paths can relax timing. Its digit-change-based paper wait can miss a new tick that repeats the same digit. Generic quote/buy execution does not recheck every condition inside the socket queue. |

Audit references:

- Sniper: `artifacts/api-server/src/lib/bot-engine.ts`, `bot-scorer.ts`, `specialist-analysis.ts`, `bot-calibration.ts`.
- Oracle: `artifacts/api-server/src/lib/killshot-family-engine.ts`, `killshot-analysis.ts`, `killshot-timing.ts`.
- Shared sizing and settlement: `recovery-math.ts`, `recovery-payout.ts`, `agents/recovery-engine.ts`.

Pulse does **not** copy overdue-digit boosts, a patience override, a force-deploy switch, or an alternative Differs recovery contract. It applies the same qualification and execution rules to normal and recovery entries.

## 2. Using the console

Open **AI Bots → Match Pulse → Deploy Bot**.

The console uses the same compact bottom-right panel, shared accent styles, risk rows, scan screen, and session monitor as the other specialist bots.

1. Select your **Deriv demo or real account** in the app's existing account switcher. Pulse uses that account automatically; the console only displays its identity/type.
2. Configure base stake, take profit, stop loss, consecutive-loss limit, recovery-step cap, and shared recovery markup.
3. Run **Neural Scan All Markets**. The AI evaluates all ten digits automatically; there is no target-digit selector.
4. After a qualified scan, the best eligible market is shown with two deployment actions:
   - **Trade Locked on [best market]** keeps that market fixed.
   - **Trade with Smart Market Switching** starts on the same best market and permits qualified rotation as conditions change.
5. Deployment arms the engine; it does not buy immediately. If no market qualifies, only re-scan/change-settings actions are offered.
6. Use **Stop Match Pulse** to stop new entries. Closing the dialog does not stop a session. An unresolved purchase keeps its execution lock until confirmed.

There is **no Paper Rehearsal selector, execution-mode selector, target-digit control, or pre-scan lock/switch control**. Demo is not local paper simulation: both demo and real accounts use broker quotes, orders, balances, and settlements on the selected Deriv account.

The server pins the scan to the connected account and rejects changed accounts or expired receipts. Returning to settings discards the console's previous scan, so editing the configuration requires scanning again in the UI. Client-supplied execution mode, digit lock, account type, account ID, probabilities, or qualification cards cannot override the public deployment flow. The public API always uses broker transport and automatic digits.

Broker deployment requires an active funded account (virtual funds for demo), broker-origin history, and the app's existing signed risk acknowledgment. There is no additional Pulse-specific consent checkbox. The existing global Settings paper-trade safety flag still blocks broker orders when enabled; it is not silently overridden. Simulated histories are labeled and cannot qualify either a demo or real broker deployment.

Default risk values: stake `1.00`, stop loss `5.00`, take profit `10.00`, consecutive-loss limit `6`, recovery-step cap `3`. Saved stake/recovery-step settings prefill the console, as in the other bots. Recovery markup remains the shared setting, editable inline with automatic save, default `10%`. The user chooses the market policy only after scanning.

## 3. Analysis policy

Implementation: `match-pulse-analysis.ts`.

### Causal next-tick model

- Uses up to **4,999** observations; at least **1,800** are required for qualification.
- Maintains long/recent windows of **2,400 / 600** observations.
- Evaluates marginal, previous-digit, and previous-two-digit contexts. The public bot automatically considers all ten digits; internal locked-digit fixtures remain only for analysis regression tests.
- Requires long supports of **400 / 60 / 24**, and recent supports of **200 / 18 / 6**, for context orders 0 / 1 / 2.
- Applies ten uniform pseudo-observations; each replay forecast is made **before** observing its outcome.
- Requires an estimated probability of at least **22%**, a conservative lower bound above payout break-even plus **2 percentage points**, a recent estimate clearing that hurdle, and no sufficiently adverse recent drift (`z < -2.33`). Drift compares raw proportions, not differently shrunk priors.
- The entry lower bound uses Wilson `z = 2.576`, capped at the estimated probability. It is a conservative descriptive filter, not a guaranteed success probability.

There is no claim that digit absence makes a digit “due.” Context dependence must be supported by observations.

### Chronological whole-policy measurement

The first 50% initializes the causal policy. The next 25% is validation; the final 25% is the latest audit. The model continues to learn from past observations only. Both held-out blocks replay the actual digit-selection and tick-cooldown rule, including wrong selections and losses—not just the best digit selected afterward.

Qualification requires all of:

- At least **16 entries in each** held-out block and **48 total**.
- Both block win-rate lower bounds above the payout's break-even probability.
- Positive Brier skill versus a **10%** baseline in both blocks.
- Latest-audit mean forecast no more than 10 percentage points above its observed hit rate.
- A four-fixed-alternative mixture log-evidence test clearing the market-search/repeated-scan threshold.

For scan round `r`, `alpha = 0.02 / (r × (r + 1))`; required log evidence is `log(marketsTested / alpha)`. Automatic and manual scans share the account's process-lifetime round counter. The counter is **not persisted across server restarts**; restarting is not new independent evidence or a lifetime statistical guarantee. The evidence construction assumes the stated conditional break-even null; it does not certify future live behavior.

Rank is the smaller of the validation/audit lower expected values. A qualification permits monitoring; it never forces an entry. Quotes are checked against their actual gross payout, and both evidence and the fresh reading must still pass.

### Market and timing policy

- **Locked:** monitor only the selected market. Failed evidence means wait, not rotate.
- **Switching:** select only qualified candidates. Keep a qualified current market unless the challenger improves lower expected value by at least **0.12**. A 45-second preference for the current qualified market limits noisy rotations.
- Re-measure about every **90 seconds**, and sooner after a loss cluster or a feed-generation change.
- Receipts expire **120 seconds from scan start**, not from when the last result arrives.
- Arm for at least **four fresh ticks** after deployment or a market activation.
- Space entries by at least **four ticks**. Post-loss waits are **8**, then **10**, then **32 ticks** at three or more consecutive losses. Market rotation does not erase the loss shield.
- No timer, recovery debt, or high score can override failed evidence, provenance, or execution guards.

## 4. Match Sniper recovery, preserved

Pulse calls the canonical `getBotRecoveryStake` for live sizing. With gross payout multiplier `P`, debt `D`, and markup percentage `M`:

```text
requested recovery stake = D × (1 + M / 100) / (P − 1)
```

Canonical cent rounding, the minimum stake, maximum-stake setting, and balance limits still apply. Pulse adds a hard remaining-session-loss-budget cap to **both** normal and recovery stakes. A remaining budget below the broker minimum stops the session instead of rounding above the budget.

- Uses the same account-scoped live debt, not a private live ladder.
- Reloads the persisted account checkpoint when live deployment starts and when an interrupted live hold is restored, using the existing daily-reset/debt-clearance policy.
- Re-reads the shared markup setting before entry; a changed live payout must produce the correct recovery stake. If it changes sizing, the unsent order is aborted and repriced on a fresh tick.
- Confirmed losses add stake to debt; confirmed net winnings reduce debt. Recovery ends when **debt clears**, not when an optional target-profit aspiration is reached.
- `maxRecoverySteps` retains its existing meaning: it caps the step counter, **not** the number of possible recovery attempts. Pulse's separate consecutive-loss stop supplies that independent limit.
- The pure `reduceRecoveryOutcome` is the extracted existing transition. Existing callers still use `recordOutcome` and automatic persistence; their formulas and completion rule are unchanged.
- The offline engine test harness retains the same reducer in a separate simulated ledger. It is not exposed as a console mode or public API option and never changes real account debt or balance. A connected Deriv demo account uses its own broker-backed account ledger instead.

Recovery changes exposure, not the probability that a digit wins. It can increase losses and cannot manufacture an edge.

## 5. Execution and settlement safety

Implementation: `digit-tape.ts`, `match-pulse-history.ts`, `match-pulse-execution.ts`, `match-pulse-engine.ts`.

### Tick identity and send boundary

A bounded tape assigns monotonic sequence numbers even when price/digit repeats or the history buffer reaches capacity. Duplicate/out-of-order epochs are rejected. Source changes and feed gaps over three expected intervals invalidate the history generation. Broker history is merged by timestamp with overlap checks, not blindly concatenated with a local ring.

The guard runs before quoting, after the journal write, after the quote, and **inside the actual buy queue after throttling/connection waits**. It checks:

- Same decision sequence, generation, and source.
- Current execution ownership and absence of a stop request.
- Local receipt age: at most **550 ms** for 1 Hz markets, **900 ms** otherwise.
- For live buys, broker-origin ticks, a connected feed, no materially future broker epoch, and a **150 ms** margin before the expected next broker tick.
- Unexpired server measurement, still-eligible digit/conditional estimate, actual quoted payout, and correct stake.

A request that times out while queued is removed from eligibility and cannot transmit later. Every Pulse purchase is one-tick `DIGITMATCH`. A buy with an uncertain result is never retried.

These guards reduce stale submissions. They cannot control broker-side latency or promise execution in the intended interval. If a confirmed broker start time reaches the next expected tick, further entries stop while the existing purchase is settled honestly.

### Journal and ownership

- A journal row is written before a live buy: `mp-pending`, then `mp-open` after confirmation. The offline test harness uses `mp-paper`; it is not a public execution option. The legacy trade reconciler does not settle these rows.
- A unique reference travels in `passthrough.match_pulse_order`. While the process/socket remains alive, only an exact-reference late buy reply may recover the contract ID or confirm rejection. Unrelated/manual replies cannot resolve the hold.
- A confirmed result updates the journal and live recovery JSON in **one row-locked transaction**. Reconciliation does not apply the same result to debt twice.
- The offline lifecycle fixture settles the **next distinct sequence**, including an identical digit. It does not invent a random win or silently skip repeated digits. Missing/invalid paper provenance cancels the observation rather than inventing P&L.
- Stop cancels unsent work, but retains the lease while asynchronous work or a purchase is unresolved.
- Auth/account mutations and new manual/bulk orders are blocked while Pulse owns the account's executor.
- Startup restores live pending holds before engines can auto-resume. It never auto-resumes Pulse trading. Known IDs can be checked through **Check settlement**.
- Corrupt metadata or multiple interrupted live rows produces a **visible live manual-reconciliation hold**. Stop/reconcile cannot silently release it or settle only one row while ignoring the rest.

### Operational limits and unresolved orders

This follows the repository's **single API-process execution model**. The arbiter is process-local, not a distributed lock; do not run multiple trading workers against the same account. It also cannot prevent trades placed directly in Deriv or another application.

The existing engines' already-in-flight legacy/manual work has not been redesigned globally. Before changing engines, stop the old engine and verify all prior broker orders have settled. Pulse refuses journaled unresolved orders and blocks new conflicting requests, but an older path's not-yet-journaled purchase is not covered by a new distributed/global transaction lock.

A timed-out buy with **no known contract ID and no matching late response** remains unresolved. Restart cannot recover an old socket reply. There is deliberately no “assume loss,” “forget pending,” or force-unlock button. An operator must verify the original broker account and reconcile the exact journal exposure before clearing/repairing the hold. For corrupt/multiple-row startup holds, repair only from confirmed broker records, then restart; do not simply delete pending rows to make the lock disappear.

Broker outages, revoked credentials, or missed history may therefore keep the bot waiting or held. Safe refusal is preferred to duplicate orders or fabricated recovery accounting.

## 6. API and file map

All endpoints are under `/api/bots/match-pulse` and use the app's existing tab/account identity handling.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/status` | Current session, phase, evidence, pending hold, and telemetry. |
| POST | `/scan` | `{}`; automatic digit analysis for broker execution, bound to the selected demo/real account; no purchases. |
| POST | `/start` | Server receipt ID, best selected symbol, post-scan market mode, stake, SL, TP, recovery-step cap, consecutive-loss limit. Execution transport and digit policy are not client inputs. |
| POST | `/stop` | Stop new entries; retain unresolved execution ownership. |
| POST | `/reconcile` | Recheck the same known contract; never re-buy. |

Validation errors return `400`, invalid lifecycle/business conditions `409`, and missing broker-trading risk acknowledgment `428`. Removed execution/digit fields and account overrides are rejected, including attempts to request paper mode. Unknown fields, numeric strings, nonfinite amounts, and fractional digit/step values are rejected. Generic bot start cannot bypass the dedicated receipt lifecycle. Replay arrays are not exposed in scan responses.

Main files:

- Backend: `artifacts/api-server/src/lib/match-pulse-{analysis,config,engine,execution,history}.ts`, `digit-tape.ts`, `routes/match-pulse.ts`.
- Tests: `artifacts/api-server/src/lib/match-pulse.test.ts`, `match-pulse-engine.test.ts`.
- UI: `artifacts/trading-platform/src/components/match-pulse-console.tsx`, `src/lib/match-pulse.ts`, and `src/lib/match-pulse.test.ts`.
- Integration: bot catalogue/Arena, shared recovery reducer, execution arbiter, Deriv request hooks, auth/manual guards, and startup hold restoration.

No new database columns or runtime dependencies are required. API tests explicitly use `DATABASE_URL=pglite:memory`, so they do not write to the preview's persistent database or an externally configured production database.

## 7. Verification

Commands run successfully:

```sh
pnpm --filter @workspace/api-server run test:match-pulse
pnpm test
pnpm run build
pnpm --filter @workspace/trading-platform run check:first-paint
```

Results on 2026-09-19:

- **41 Pulse backend tests passed**: causal prefix replay; conditional/marginal synthetic plants; collapsed regimes; locked digits; payout/search correction; market selection/cadence; repeated/duplicate/out-of-order ticks; source/gap invalidation; timestamp merging; actual queued-send and timeout guards; broker-epoch deadline; exact-reference confirmations; no ambiguous-buy retries; recovery parity/caps; strict parsing; account leases; complete paper lifecycle; persisted live-hold restoration; corrupt/multiple-row startup holds; removed public input rejection; selected demo/real broker-account arming; account-bound scan receipts.
- Seeded control: **60 fair streams** evaluated with a 20-market correction produced **zero qualified markets**. This is a synthetic regression control, not an estimate of real false-positive rates or a profitability claim.
- Full regression: **335 API tests, 58 suites, zero failures**; **10 frontend tests, 3 suites, zero failures**. The frontend suite now covers best-market selection, account matching, and pre-scan risk validation. Existing recovery parity tests pass.
- Workspace typecheck and all production builds pass. Frontend build retains nonfatal UI-primitive sourcemap warnings and a large-chunk warning.
- **45 Chromium desktop/mobile checks pass**, including geometry/style parity with Match Sniper, removal of obsolete controls, settings → scan → results progression, actual API no-edge behavior, mocked demo/real lock and switching deployments, correct best-market/risk payloads, account and expiry guards, 390px layout, keyboard focus trapping, Escape, and no browser runtime errors. All browser start/stop operations used intercepted test responses, not broker orders.
- **7 first-paint checks pass**. HTTP smoke checks confirm removed mode/digit fields and numeric coercion `400`, and unacknowledged broker deployment `428`. Engine tests cover account-mismatched/missing receipts.

The preview had no configured broker app ID/account and its public broker WebSocket was unavailable, so it used labeled simulated market data. **No authenticated broker calls or real orders were used to establish these results.** Forward evaluation on a Deriv demo account using broker-origin ticks, followed by operational review, remains necessary before considering any real-money use. There is no live accuracy or profit guarantee.
