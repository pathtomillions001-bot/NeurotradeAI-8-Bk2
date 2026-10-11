# Desk v4 — NULL gate (intraday)

Datasets with no exploitable structure. The desk must arm rarely (≤3%), must not lose more than the round-trip cost, and must not manufacture statistical significance.

## Verdict: **FAIL**

| Check | Result | Observed | Required |
|---|---|---|---|
| null_arm_rate | FAIL | 0.1257 | <= 0.03 |
| null_mean_realised_r | PASS | -0.088 | >= -0.1012 (cost 0.051 + slack 0.05) |
| null_dsr_significant_share | FAIL | 0.3333 | <= 0.05 at DSR >= 0.95 |

Harness `wp2.1.0`. Reproduce with:

```
pnpm --filter @workspace/api-server run research:run -- --mode intraday --gate null --seeds 1,2,3 --bars 40000 --step 15 --out ../../docs/research --name baseline-null-intraday --compact --quiet
```

## Aggregate

| Seed | Dataset | Evals | Arms | Fills | Hit rate | Mean R | Total R | DSR | Rel. slope |
|---|---|---|---|---|---|---|---|---|---|
| 1 | driftless:seed=1:bars=40000:vol=0.0001:spread=8 | 2567 | 204 | 171 | 18.7% | -0.620 | -105.94 | 0.000 | -0.510 |
| 2 | driftless:seed=2:bars=40000:vol=0.0001:spread=8 | 2567 | 414 | 356 | 50.0% | 0.236 | 83.94 | 0.996 | 0.100 |
| 3 | driftless:seed=3:bars=40000:vol=0.0001:spread=8 | 2567 | 350 | 302 | 39.7% | -0.169 | -50.91 | 0.000 | 0.105 |

## Runs in detail

### Run — EURUSD intraday (seed 1)

**What this run is.**

- Dataset: `driftless:seed=1:bars=40000:vol=0.0001:spread=8`
- Bars: 40,001 M1, harness `wp2.1.0`
- Evaluated: 2024-01-03T01:00:00.000Z → 2024-01-29T18:30:00.000Z
- Decisions: 2,567 · arms 204 · fills 171
- Deflated for 3 configuration(s) searched.

Caveats carried by this run:
- Driftless random walk: zero drift by construction.
- barVol 0.0001, 6 sub-steps per bar.
- Frames evaluated: M5, M15, M30.
- Calendar: clear and available for every evaluation (price-logic baseline).
- Book: empty — per-trade edge, no portfolio interaction (WP8 measures that).

**Headline numbers.**

| Metric | Value |
|---|---|
| Arm rate | 7.95% (204/2567) |
| Fill rate (of arms) | 83.8% |
| Trades | 171 |
| Hit rate | 18.7% |
| Mean R | -0.620 ± 0.062 |
| Median R | -1.054 |
| Total R | -105.94 |
| 5% CVaR (mean tail loss) | 1.092 R |
| Mean MAE / MFE | -0.91 / 0.77 R |
| Longest losing streak | 37 |
| Max drawdown | 104.88 R |
| Mean cost | 0.053 R |
| Probabilistic Sharpe | 0.000 |
| Deflated Sharpe | 0.000 |

**Calibration.**

Brier 0.1688, skill vs base rate -0.1099, reliability slope -0.510.

| Predicted | Observed | n |
|---|---|---|
| 13.8% | 23.5% | 17 |
| 18.4% | 23.5% | 17 |
| 21.7% | 29.4% | 17 |
| 24.2% | 23.5% | 17 |
| 26.0% | 0.0% | 17 |
| 28.0% | 17.6% | 17 |
| 30.4% | 29.4% | 17 |
| 32.2% | 17.6% | 17 |
| 34.2% | 11.8% | 17 |
| 37.9% | 11.8% | 17 |
| 41.4% | 0.0% | 1 |

**Attribution by exit.**

| Exit | n | Mean R | Total R |
|---|---|---|---|
| stop_loss | 143 | -0.929 | -132.82 |
| take_profit | 7 | 1.800 | 12.60 |
| break_even | 18 | 0.710 | 12.79 |
| trail | 3 | 0.497 | 1.49 |

**Unfilled arms.**

- invalidated: 23
- expired: 10

**First 20 trades.**

| # | Filled | R | Exit | MAE | MFE | Bars | Actions |
|---|---|---|---|---|---|---|---|
| 1 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 2 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 3 | yes | -1.06 | stop_loss | -1.03 | 0.20 | 50 | 1 |
| 4 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 5 | yes | -0.06 | stop_loss | -1.14 | 1.00 | 99 | 3 |
| 6 | yes | -1.05 | stop_loss | -1.11 | 0.39 | 82 | 1 |
| 7 | yes | -1.04 | stop_loss | -1.09 | 0.11 | 72 | 1 |
| 8 | yes | -0.06 | stop_loss | -1.08 | 1.29 | 125 | 3 |
| 9 | yes | -1.07 | stop_loss | -1.15 | 0.01 | 20 | 1 |
| 10 | yes | -1.04 | stop_loss | -1.01 | 0.23 | 273 | 1 |
| 11 | yes | -1.05 | stop_loss | -1.02 | 0.59 | 259 | 1 |
| 12 | yes | -1.05 | stop_loss | -1.01 | 0.36 | 236 | 1 |
| 13 | yes | -1.07 | stop_loss | -1.02 | 0.28 | 28 | 1 |
| 14 | yes | 1.59 | take_profit | -0.11 | 2.28 | 236 | 6 |
| 15 | yes | 0.91 | break_even | -0.30 | 1.95 | 390 | 6 |
| 16 | yes | -0.03 | stop_loss | -1.05 | 1.40 | 380 | 3 |
| 17 | yes | -1.06 | stop_loss | -1.02 | 0.75 | 91 | 1 |
| 18 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 19 | yes | 0.63 | stop_loss | -0.05 | 1.67 | 243 | 8 |
| 20 | yes | -0.25 | stop_loss | -0.23 | 1.24 | 233 | 2 |

### Run — EURUSD intraday (seed 2)

**What this run is.**

- Dataset: `driftless:seed=2:bars=40000:vol=0.0001:spread=8`
- Bars: 40,001 M1, harness `wp2.1.0`
- Evaluated: 2024-01-03T01:00:00.000Z → 2024-01-29T18:30:00.000Z
- Decisions: 2,567 · arms 414 · fills 356
- Deflated for 3 configuration(s) searched.

Caveats carried by this run:
- Driftless random walk: zero drift by construction.
- barVol 0.0001, 6 sub-steps per bar.
- Frames evaluated: M5, M15, M30.
- Calendar: clear and available for every evaluation (price-logic baseline).
- Book: empty — per-trade edge, no portfolio interaction (WP8 measures that).

**Headline numbers.**

| Metric | Value |
|---|---|
| Arm rate | 16.13% (414/2567) |
| Fill rate (of arms) | 86.0% |
| Trades | 356 |
| Hit rate | 50.0% |
| Mean R | 0.236 ± 0.068 |
| Median R | -0.002 |
| Total R | 83.94 |
| 5% CVaR (mean tail loss) | 1.079 R |
| Mean MAE / MFE | -0.71 / 1.32 R |
| Longest losing streak | 26 |
| Max drawdown | 42.44 R |
| Mean cost | 0.051 R |
| Probabilistic Sharpe | 1.000 |
| Deflated Sharpe | 0.996 |

**Calibration.**

Brier 0.3087, skill vs base rate -0.2350, reliability slope 0.100.

| Predicted | Observed | n |
|---|---|---|
| 9.5% | 62.9% | 35 |
| 15.5% | 42.9% | 35 |
| 20.7% | 42.9% | 35 |
| 24.3% | 57.1% | 35 |
| 26.6% | 42.9% | 35 |
| 29.2% | 34.3% | 35 |
| 31.9% | 54.3% | 35 |
| 34.2% | 37.1% | 35 |
| 38.3% | 65.7% | 35 |
| 44.6% | 62.9% | 35 |
| 52.4% | 33.3% | 6 |

**Attribution by exit.**

| Exit | n | Mean R | Total R |
|---|---|---|---|
| time_stop | 7 | -0.168 | -1.17 |
| stop_loss | 203 | -0.743 | -150.91 |
| take_profit | 95 | 2.006 | 190.55 |
| trail | 31 | 0.945 | 29.30 |
| break_even | 20 | 0.809 | 16.17 |

**Unfilled arms.**

- expired: 17
- invalidated: 41

**First 20 trades.**

| # | Filled | R | Exit | MAE | MFE | Bars | Actions |
|---|---|---|---|---|---|---|---|
| 1 | yes | -0.54 | time_stop | -0.73 | 0.41 | 372 | 2 |
| 2 | yes | 0.26 | time_stop | -0.80 | 0.46 | 373 | 2 |
| 3 | expired | — | — | 0.00 | 0.00 | 0 | 0 |
| 4 | yes | -1.05 | stop_loss | -1.01 | 0.22 | 201 | 1 |
| 5 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 6 | yes | -1.06 | stop_loss | -1.01 | 0.37 | 173 | 1 |
| 7 | yes | -1.04 | stop_loss | -1.00 | 0.13 | 124 | 1 |
| 8 | yes | -1.04 | stop_loss | -1.00 | 0.10 | 111 | 1 |
| 9 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 10 | yes | -1.04 | stop_loss | -1.01 | 0.02 | 79 | 1 |
| 11 | yes | -1.06 | stop_loss | -1.02 | 0.00 | 29 | 1 |
| 12 | yes | -1.05 | stop_loss | -1.01 | 0.28 | 118 | 1 |
| 13 | yes | -1.04 | stop_loss | -1.01 | 0.01 | 101 | 1 |
| 14 | yes | -1.05 | stop_loss | -1.02 | 0.10 | 90 | 1 |
| 15 | yes | -1.06 | stop_loss | -1.10 | 0.17 | 185 | 1 |
| 16 | yes | 1.45 | take_profit | -0.70 | 2.05 | 410 | 6 |
| 17 | yes | 1.59 | take_profit | -0.58 | 2.46 | 405 | 6 |
| 18 | yes | 2.16 | take_profit | -0.79 | 2.55 | 393 | 13 |
| 19 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 20 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |

### Run — EURUSD intraday (seed 3)

**What this run is.**

- Dataset: `driftless:seed=3:bars=40000:vol=0.0001:spread=8`
- Bars: 40,001 M1, harness `wp2.1.0`
- Evaluated: 2024-01-03T01:00:00.000Z → 2024-01-29T18:30:00.000Z
- Decisions: 2,567 · arms 350 · fills 302
- Deflated for 3 configuration(s) searched.

Caveats carried by this run:
- Driftless random walk: zero drift by construction.
- barVol 0.0001, 6 sub-steps per bar.
- Frames evaluated: M5, M15, M30.
- Calendar: clear and available for every evaluation (price-logic baseline).
- Book: empty — per-trade edge, no portfolio interaction (WP8 measures that).

**Headline numbers.**

| Metric | Value |
|---|---|
| Arm rate | 13.63% (350/2567) |
| Fill rate (of arms) | 86.3% |
| Trades | 302 |
| Hit rate | 39.7% |
| Mean R | -0.169 ± 0.061 |
| Median R | -1.037 |
| Total R | -50.91 |
| 5% CVaR (mean tail loss) | 1.086 R |
| Mean MAE / MFE | -0.81 / 1.06 R |
| Longest losing streak | 17 |
| Max drawdown | 53.53 R |
| Mean cost | 0.051 R |
| Probabilistic Sharpe | 0.005 |
| Deflated Sharpe | 0.000 |

**Calibration.**

Brier 0.2666, skill vs base rate -0.1135, reliability slope 0.105.

| Predicted | Observed | n |
|---|---|---|
| 9.5% | 46.7% | 30 |
| 15.2% | 46.7% | 30 |
| 19.6% | 36.7% | 30 |
| 22.6% | 46.7% | 30 |
| 24.5% | 23.3% | 30 |
| 26.3% | 36.7% | 30 |
| 28.7% | 23.3% | 30 |
| 31.7% | 40.0% | 30 |
| 35.2% | 36.7% | 30 |
| 42.2% | 60.0% | 30 |
| 47.9% | 50.0% | 2 |

**Attribution by exit.**

| Exit | n | Mean R | Total R |
|---|---|---|---|
| stop_loss | 191 | -0.844 | -161.26 |
| trail | 27 | 0.833 | 22.50 |
| time_stop | 12 | -0.202 | -2.43 |
| take_profit | 39 | 1.816 | 70.81 |
| break_even | 33 | 0.590 | 19.46 |

**Unfilled arms.**

- invalidated: 38
- expired: 10

**First 20 trades.**

| # | Filled | R | Exit | MAE | MFE | Bars | Actions |
|---|---|---|---|---|---|---|---|
| 1 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 2 | yes | -1.06 | stop_loss | -1.06 | 0.00 | 29 | 1 |
| 3 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 4 | yes | 0.06 | stop_loss | -0.15 | 1.21 | 129 | 2 |
| 5 | yes | -1.06 | stop_loss | -1.01 | 0.46 | 54 | 1 |
| 6 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 7 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 8 | yes | -1.08 | stop_loss | -1.25 | 0.67 | 111 | 1 |
| 9 | yes | -1.06 | stop_loss | -1.18 | 0.15 | 90 | 1 |
| 10 | yes | -1.07 | stop_loss | -1.21 | 0.39 | 82 | 1 |
| 11 | yes | -1.05 | stop_loss | -1.23 | 0.06 | 52 | 1 |
| 12 | yes | -1.05 | stop_loss | -1.23 | 0.00 | 37 | 1 |
| 13 | yes | 0.31 | trail | -0.27 | 1.45 | 850 | 3 |
| 14 | yes | -1.04 | stop_loss | -1.06 | 1.05 | 917 | 1 |
| 15 | yes | -1.06 | stop_loss | -1.04 | 0.53 | 279 | 1 |
| 16 | yes | -1.08 | stop_loss | -1.05 | 0.89 | 263 | 1 |
| 17 | yes | -1.05 | stop_loss | -1.04 | 0.25 | 248 | 1 |
| 18 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 19 | yes | -1.07 | stop_loss | -1.05 | 0.44 | 211 | 1 |
| 20 | yes | 0.47 | stop_loss | -0.64 | 1.55 | 673 | 6 |
