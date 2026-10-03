# Main autonomous recovery v2

## Scope and release status

Implemented for the **main autonomous engine**, with shared transport/settlement safeguards. FAB and specialist strategy selection were not redesigned. No real orders were submitted during development. Automated checks validate implementation behavior, not an exploitable trading edge, win rate, or profitability. **Demo validation is still required before real-money use.**

## Decision pipeline

1. Use live-provenance prices/digits and compatible public broker history (up to 4,000 ticks). Reject stale feeds, incompatible generations, conflicting history and discontinuities. History warms the analysis without waiting for thousands of new live ticks.
2. Evaluate the exact enabled contract, barrier and tick expiry. Match/Diff targets are selected from training data only or explicitly pinned; directional labels use the actual expiry, with ties counted as non-wins. Markov forecasts use an h-step transition matrix, not a one-tick forecast for every duration.
3. Split history chronologically: 50% training, 25% calibration/model selection, 25% final holdout. Conditional models must improve calibration Brier score over baseline by 2%, with adequate support. Final-holdout failure cannot trigger cherry-picking a different model.
4. Penalize uncertainty, correlated observations, deterioration and multiple candidates. Rank by conservative expected value/log growth. Quote up to three shortlisted contracts, then re-evaluate at the actual total-return payout. `EV = probability * total-return multiplier - 1`; a 61% probability at 1.63 payout is negative EV.
5. Require conservative EV of at least 0.01 per unit stake. Confidence/model preferences do not become arbitrary consensus-vote gates, but insufficient evidence, unsafe feeds and negative edge still prevent entry. Waiting alone never relaxes these conditions.
6. Use the original shared `getDynamicRecoveryStake` policy through `autonomousRecoveryStake`: Auto Split caps the exact debt-plus-remaining-target request at the normal base stake; Auto Instant targets that full amount at the selected payout. Manual Split caps the exact target by the configured compounded multiplier stake; Manual Instant uses that multiplier stake directly. Maximum recovery steps limits manual compounding. Preserve upward cent rounding, configured maximum stake and available-balance limits. Reject an unfundable broker minimum. The experimental 0.5%, quarter-Kelly and remaining-loss-budget stake overrides are **not used** by the main autonomous engine. Existing daily stop and drawdown checks remain; they do not silently rewrite the selected sizing formula.

These constants are conservative initial policy choices, not empirically optimized parameters. The lower probability estimate is a screening heuristic, **not an anytime-valid statistical confidence guarantee**. Repeated adaptive scanning can still produce false discoveries. Random synthetic digits with a payout disadvantage should normally produce no qualified trade.

## Responsiveness and execution

- Recovery waits wake on fresh ticks with coalescing (minimum approximately 500 ms between recovery scans) and a three-second watchdog. Market-only analysis is cached by tick/history/contract identity; account sizing is never cached.
- Disabled recovery, no enabled eligible contracts, or no safe edge does not fall through into ordinary trading while debt is active.
- Real mode requires account credentials; missing credentials never silently switch to paper.
- Prebuy checks enforce generation/running state, ownership, feed freshness, quote age/price, exact payout edge, selected-mode sizing and settings revision. Stop cancels queued work; purchased work is drained before a restart is permitted.
- A durable journal row starts as **NOT PURCHASED**, is changed to **PENDING** immediately before sending a buy, and gets its exact broker contract ID immediately after acknowledgement.
- Ambiguous transport outcomes or failures after purchase stop the engine and quarantine that session. No automatic retry or invented zero-profit loss occurs. Manual requests are rejected while the main engine owns execution or the account session is quarantined.
- Exact-ID reconciliation and normal settlement share one transaction: lock account settings, compare-and-set the trade status, and persist the updated recovery ledger. Duplicate settlement cannot add the same loss twice. Same-day persisted debt takes precedence over stale in-memory debt. Malformed settlements remain unresolved; refunded contracts do not create recovery debt.

## Paper mode and UI

Paper orders settle from **future feed ticks** at the selected duration, not a model-probability random draw. Feed-generation changes, gaps and timeouts cancel the paper attempt. This is not a broker-fill simulator: proposal latency, execution slippage and broker-specific behavior still need demo testing.

Paper recovery state and journal records use a separate `:autonomous-paper` session namespace. They do not alter the live recovery ledger or live account P&L. The account journal remains live-account history; paper activity is visible through engine activity/status, not a new paper-journal browser. Paper state is reset when a new paper engine session starts. Stop and restart after changing paper/live mode.

Dashboard diagnostics show waiting/executing/settled/unresolved reason, exact candidate, estimated and conservative probabilities, conservative EV, holdout/effective sample counts and selected model. Settings reflect the original Split/Instant and Auto/Manual behaviour. Recovery multiplier and maximum-step controls retain their original meaning. Sizing uses the selected payout quote, as in the original policy. The final broker proposal is still checked for positive conservative edge and the approved stake; its payout can differ, so an Instant repayment target is not guaranteed.

## Important retained limitations

- Ownership/quarantine is process-local and browser-session-scoped, with pending rows restored at startup. This is **not** a distributed account-wide lock across replicas, multiple browser sessions or external trading tools. Use one server process and one trading session per broker account. Do not run concurrent external traders during validation.
- Legacy manual/FAB/specialist ledger writers are not all migrated to transactional settlement. Their strategies and legacy asynchronous persistence remain outside this change.
- The shared recovery engine's existing calendar-day carry/reset behavior is unchanged. This is not an immutable lifetime loss ledger. Per-trade, daily and drawdown limits are enforced; a separate cumulative recovery-cycle loss budget has not been added.
- Orders lacking an acknowledged contract ID are deliberately **not** matched by symbol/stake/time proximity. They require broker-statement investigation and controlled record correction before restarting. There is no new self-service unresolved-order resolution screen. Clearing displayed recovery debt is not proof an outstanding purchase was resolved.
- Normal-entry statistical selection is unchanged. The new exact-contract statistical method applies to recovery.
- No historical broker replay, full autonomous HTTP-to-broker lifecycle test, demo forward trial or live profitability validation has been completed.

## Validation

Commands:

```sh
corepack pnpm run typecheck:libs
corepack pnpm --filter @workspace/api-server typecheck
corepack pnpm --filter @workspace/trading-platform typecheck
corepack pnpm --filter @workspace/api-server test
corepack pnpm --filter @workspace/api-server build
corepack pnpm --filter @workspace/trading-platform build
git diff --check
```

New tests cover neutral/advantaged streams, real payout rejection, training-only target selection, exact duration and Markov horizons, dependence/multiplicity/deterioration, sizing, history provenance, queue cancellation, failed intent persistence, unknown acknowledgement, exact future-tick paper outcomes, session quarantine, duplicate settlement, foreign-session isolation, refunds, malformed results and stale warm ledger handling. Existing single-contract execution protections remain enabled, including strict manual-trade validation and disabled mutation retries.

Both builds and typechecks passed. The frontend build emits a bundle-size warning; it does not fail. Test database is in-memory PGlite, and broker calls in execution tests are mocked. See the final test result recorded below.

## Suggested demo acceptance checklist

- Start with the smallest independently permitted stake and one account/session. Do not enlarge risk caps to overcome waiting.
- Verify dashboard contract/barrier/duration against the actual demo proposal and settled contract.
- Exercise stop during analysis, queued proposal, buy and settlement; verify no duplicate purchase.
- Exercise connection loss/unknown acknowledgement and restart; require exact reconciliation before new trading.
- Check partial repayments, refund behavior, daily limits, cooldown and midnight behavior against the broker statement.
- Confirm paper/live switching cannot move paper losses into live recovery debt.
- Collect forward out-of-sample calibration, drawdown and net results including unsuccessful attempts. Do not enable real-money trading solely because unit tests passed.

### Final recorded results

- Final full API run: **504 passed, 0 failed, 0 cancelled, 0 skipped** (~91 seconds).
- Focused recovery/settlement/single-order regression run: **36 passed, 0 failed**.
- Workspace-library, API and frontend typechecks: passed.
- API and frontend production builds: passed.
- `git diff --check`: passed.

## Sizing restoration

At the user’s request, original Split/Instant sizing is restored while retaining exact-contract analysis, execution checks and settlement protection. Instant is a sizing target, not a promise of recovery: a losing contract increases debt, and maximum stake/balance limits can prevent full repayment. Manual escalation can increase losses. Prior validation counts above describe the initial upgrade; sizing-restoration checks are recorded separately.

Sizing-restoration validation: full API suite **518 passed, 0 failed**; API/frontend typechecks and `git diff --check` passed. New regression cases cover all four Auto/Manual × Split/Instant combinations, manual-step limits, payout sensitivity, upward rounding, explicit maximum stake and insufficient balance.
