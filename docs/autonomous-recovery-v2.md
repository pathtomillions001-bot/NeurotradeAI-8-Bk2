# Autonomous recovery decision v2

## Scope and rollback

Recovery v2 is isolated to the **main autonomous engine's recovery fast path**. The normal-trade coordinator, manual trading, specialist bots, and other engines keep their existing decision logic.

The rollout flag is `AUTONOMOUS_RECOVERY_V2`. It is enabled by default after this approved change. Set it to `false`, `0`, `off`, or `no` and restart the API to restore the previous autonomous recovery path. The old recovery consensus remains in place as the rollback path.

## What v2 changes

- Uses a fresh, same-generation **live Deriv tick tape**. When the process-local tape is short, it tries to warm it from `ticks_history`, then merges by broker timestamp and checks overlapping prices/digits. It never merges simulated ticks into a live sample.
- Measures candidate outcomes at the configured contract expiry horizon, rather than treating the last 50/100/150 digits as three independent confirmations.
- Shrinks win-rate estimates toward the contract's theoretical rate, discounts effective sample size for positive serial dependence, and applies a family-wise multiple-candidate confidence correction.
- Requires a live payout quote and a conservative expected value (lower probability bound × total payout multiplier − 1) of at least 1% per stake. Fallback payouts are diagnostic only and cannot authorize v2 execution.
- Ranks candidates by conservative EV on a common per-stake scale. Match/Diff barriers are each assessed as separate candidates and included in the multiple-testing count.
- Sizes from conservative fractional Kelly, capped by the configured normal stake, `maxTradeStake`, `maxRiskPerTrade`, 0.5% of a freshly verified Deriv account balance, and the outstanding debt itself. If a positive live balance cannot be confirmed, v2 waits instead of sizing from the settings-row balance. Debt can reduce the cap but never increase stake. V2 does not use the old recovery multiplier/instant-debt formula to increase stake.
- Rechecks the *actual account proposal* immediately before buy. The order is rejected if the live quote no longer clears the EV floor, the ask exceeds the risk cap, the live tick is stale, or the feed generation changed.
- Emits per-scan candidate estimates, sample sizes, payout source, EV bounds, and rejection counts to server logs and scan status.

The v2 local scan retries about every two seconds. A scan itself does not intentionally wait for minutes: it uses cached verified history or a bounded broker-history request. It can—and should—wait indefinitely when the feed is simulated/stale, a live payout is unavailable, evidence is insufficient, or no lower-confidence EV clears the gate.

## Paper mode

Recovery v2 does **not** use the old random paper-outcome simulation. Until a future shadow-settlement implementation exists, v2 refuses recovery execution in paper mode or without an authenticated live account. This avoids treating a random draw from the model's own probability estimate as evidence of real predictive skill. Disabling v2 restores the legacy paper recovery behavior.

## Important limitations

The confidence bound and risk caps are safeguards, not a guarantee of predictive edge or profit. Historical digit distributions can shift, synthetic-market observations can be dependent, candidate scans create selection bias, and the historical tape is not yet a substitute for a measured walk-forward calibration report. Markov features are intentionally not used until they show out-of-sample calibration improvement. Validate with shadow outcomes and small, closely monitored live exposure before drawing conclusions about P&L.
