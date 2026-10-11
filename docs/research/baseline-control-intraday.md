# Desk v4 — POSITIVE CONTROL (intraday)

A market with a deliberate, persistent edge (regime-switching drift plus AR(1) mean reversion). A pipeline that cannot find THIS is blind, and its restraint on the nulls means nothing.

## Verdict: **FAIL**

| Check | Result | Observed | Required |
|---|---|---|---|
| control_arm_rate | PASS | 0.6081 | >= 0.1 |
| control_mean_realised_r | PASS | 1.4189 | >= 0.3 over >= 1 trade |
| control_expectancy_gap | FAIL | 0.5568 | |predicted 1.976 - realised| <= 0.15 |

Harness `wp2.1.0`. Reproduce with:

```
pnpm --filter @workspace/api-server run research:run -- --mode intraday --gate control --seeds 1,2,3 --bars 40000 --step 15 --out ../../docs/research --name baseline-control-intraday --compact --quiet
```

## Aggregate

| Seed | Dataset | Evals | Arms | Fills | Hit rate | Mean R | Total R | DSR | Rel. slope |
|---|---|---|---|---|---|---|---|---|---|
| 1 | positive_control:seed=1:bars=40000:vol=0.0001... | 2567 | 1572 | 1459 | 79.2% | 1.407 | 2052.74 | 1.000 | 0.520 |
| 2 | positive_control:seed=2:bars=40000:vol=0.0001... | 2567 | 1296 | 1185 | 81.4% | 1.511 | 1790.05 | 1.000 | 0.473 |
| 3 | positive_control:seed=3:bars=40000:vol=0.0001... | 2567 | 1815 | 1762 | 76.2% | 1.367 | 2408.82 | 1.000 | 0.334 |

## Runs in detail

### Run — EURUSD intraday (seed 1)

**What this run is.**

- Dataset: `positive_control:seed=1:bars=40000:vol=0.0001:spread=8`
- Bars: 40,001 M1, harness `wp2.1.0`
- Evaluated: 2024-01-03T01:00:00.000Z → 2024-01-29T18:30:00.000Z
- Decisions: 2,567 · arms 1572 · fills 1459
- Deflated for 3 configuration(s) searched.

Caveats carried by this run:
- Positive control: regime-switching drift (6.00e-5/bar, persistent sign)
- plus AR(1) mean reversion (phi=0.9) in the range state.
- Switch probability 1.11e-3 per bar.
- A pipeline that cannot arm here must not be trusted to reject the nulls.
- Frames evaluated: M5, M15, M30.
- Calendar: clear and available for every evaluation (price-logic baseline).
- Book: empty — per-trade edge, no portfolio interaction (WP8 measures that).

**Headline numbers.**

| Metric | Value |
|---|---|
| Arm rate | 61.24% (1572/2567) |
| Fill rate (of arms) | 92.8% |
| Trades | 1459 |
| Hit rate | 79.2% |
| Mean R | 1.407 ± 0.034 |
| Median R | 2.175 |
| Total R | 2052.74 |
| 5% CVaR (mean tail loss) | 1.094 R |
| Mean MAE / MFE | -0.34 / 2.13 R |
| Longest losing streak | 26 |
| Max drawdown | 23.71 R |
| Mean cost | 0.044 R |
| Probabilistic Sharpe | 1.000 |
| Deflated Sharpe | 1.000 |

**Calibration.**

Brier 0.1673, skill vs base rate -0.0140, reliability slope 0.520.

| Predicted | Observed | n |
|---|---|---|
| 34.4% | 64.8% | 145 |
| 44.6% | 58.6% | 145 |
| 55.7% | 69.0% | 145 |
| 67.2% | 77.9% | 145 |
| 76.6% | 77.2% | 145 |
| 83.5% | 80.0% | 145 |
| 89.8% | 80.0% | 145 |
| 93.4% | 93.1% | 145 |
| 95.4% | 93.1% | 145 |
| 98.2% | 96.6% | 145 |
| 99.9% | 100.0% | 9 |

**Attribution by exit.**

| Exit | n | Mean R | Total R |
|---|---|---|---|
| take_profit | 1032 | 2.167 | 2236.53 |
| stop_loss | 295 | -0.907 | -267.51 |
| time_stop | 31 | -0.362 | -11.23 |
| trail | 84 | 1.058 | 88.85 |
| break_even | 11 | 0.645 | 7.09 |
| end_of_data | 6 | -0.164 | -0.98 |

**Unfilled arms.**

- expired: 78
- invalidated: 35

**First 20 trades.**

| # | Filled | R | Exit | MAE | MFE | Bars | Actions |
|---|---|---|---|---|---|---|---|
| 1 | expired | — | — | 0.00 | 0.00 | 0 | 0 |
| 2 | yes | 2.23 | take_profit | -0.72 | 2.58 | 931 | 16 |
| 3 | expired | — | — | 0.00 | 0.00 | 0 | 0 |
| 4 | yes | 2.06 | take_profit | -0.61 | 2.48 | 880 | 12 |
| 5 | expired | — | — | 0.00 | 0.00 | 0 | 0 |
| 6 | yes | 2.20 | take_profit | -0.68 | 2.56 | 864 | 12 |
| 7 | yes | -1.06 | stop_loss | -1.08 | 0.08 | 121 | 1 |
| 8 | yes | -1.07 | stop_loss | -1.09 | 0.13 | 106 | 1 |
| 9 | yes | -1.06 | stop_loss | -1.09 | 0.01 | 93 | 1 |
| 10 | yes | -1.07 | stop_loss | -1.10 | 0.00 | 79 | 1 |
| 11 | yes | -1.07 | stop_loss | -1.10 | 0.00 | 62 | 1 |
| 12 | yes | 2.21 | take_profit | -0.27 | 2.55 | 676 | 12 |
| 13 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 14 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 15 | yes | 2.25 | take_profit | -0.35 | 2.66 | 669 | 19 |
| 16 | yes | 2.25 | take_profit | -0.24 | 2.60 | 637 | 16 |
| 17 | yes | 2.23 | take_profit | -0.29 | 2.63 | 637 | 19 |
| 18 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 19 | yes | -0.46 | time_stop | -0.81 | 0.20 | 370 | 2 |
| 20 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |

### Run — EURUSD intraday (seed 2)

**What this run is.**

- Dataset: `positive_control:seed=2:bars=40000:vol=0.0001:spread=8`
- Bars: 40,001 M1, harness `wp2.1.0`
- Evaluated: 2024-01-03T01:00:00.000Z → 2024-01-29T18:30:00.000Z
- Decisions: 2,567 · arms 1296 · fills 1185
- Deflated for 3 configuration(s) searched.

Caveats carried by this run:
- Positive control: regime-switching drift (6.00e-5/bar, persistent sign)
- plus AR(1) mean reversion (phi=0.9) in the range state.
- Switch probability 1.11e-3 per bar.
- A pipeline that cannot arm here must not be trusted to reject the nulls.
- Frames evaluated: M5, M15, M30.
- Calendar: clear and available for every evaluation (price-logic baseline).
- Book: empty — per-trade edge, no portfolio interaction (WP8 measures that).

**Headline numbers.**

| Metric | Value |
|---|---|
| Arm rate | 50.49% (1296/2567) |
| Fill rate (of arms) | 91.4% |
| Trades | 1185 |
| Hit rate | 81.4% |
| Mean R | 1.511 ± 0.036 |
| Median R | 2.192 |
| Total R | 1790.05 |
| 5% CVaR (mean tail loss) | 1.068 R |
| Mean MAE / MFE | -0.32 / 2.18 R |
| Longest losing streak | 21 |
| Max drawdown | 20.12 R |
| Mean cost | 0.040 R |
| Probabilistic Sharpe | 1.000 |
| Deflated Sharpe | 1.000 |

**Calibration.**

Brier 0.1641, skill vs base rate -0.0816, reliability slope 0.473.

| Predicted | Observed | n |
|---|---|---|
| 33.0% | 62.7% | 118 |
| 42.1% | 70.3% | 118 |
| 51.1% | 72.9% | 118 |
| 61.7% | 73.7% | 118 |
| 71.0% | 80.5% | 118 |
| 79.2% | 82.2% | 118 |
| 87.1% | 84.7% | 118 |
| 92.2% | 95.8% | 118 |
| 96.5% | 96.6% | 118 |
| 99.6% | 96.6% | 118 |
| 100.0% | 20.0% | 5 |

**Attribution by exit.**

| Exit | n | Mean R | Total R |
|---|---|---|---|
| take_profit | 864 | 2.207 | 1906.72 |
| stop_loss | 215 | -0.879 | -188.98 |
| trail | 54 | 1.178 | 63.59 |
| break_even | 12 | 0.726 | 8.71 |
| time_stop | 31 | -0.215 | -6.67 |
| end_of_data | 9 | 0.742 | 6.68 |

**Unfilled arms.**

- expired: 69
- invalidated: 42

**First 20 trades.**

| # | Filled | R | Exit | MAE | MFE | Bars | Actions |
|---|---|---|---|---|---|---|---|
| 1 | yes | 2.18 | take_profit | -0.09 | 2.56 | 90 | 14 |
| 2 | yes | 2.17 | take_profit | -0.19 | 2.55 | 95 | 15 |
| 3 | yes | 2.17 | take_profit | -0.16 | 2.56 | 81 | 15 |
| 4 | yes | 2.17 | take_profit | -0.10 | 2.68 | 78 | 14 |
| 5 | yes | 2.17 | take_profit | -0.20 | 2.57 | 72 | 12 |
| 6 | yes | 2.18 | take_profit | -0.09 | 2.55 | 70 | 13 |
| 7 | yes | 2.19 | take_profit | -0.12 | 2.61 | 69 | 14 |
| 8 | yes | 2.16 | take_profit | -0.22 | 2.61 | 75 | 13 |
| 9 | yes | 2.17 | take_profit | -0.07 | 2.63 | 81 | 15 |
| 10 | yes | 2.17 | take_profit | -0.17 | 2.57 | 91 | 16 |
| 11 | yes | 2.19 | take_profit | -0.15 | 2.58 | 86 | 16 |
| 12 | yes | 2.18 | take_profit | -0.12 | 2.56 | 90 | 16 |
| 13 | expired | — | — | 0.00 | 0.00 | 0 | 0 |
| 14 | yes | 2.18 | take_profit | -0.15 | 2.61 | 73 | 14 |
| 15 | yes | 2.16 | take_profit | -0.07 | 2.54 | 71 | 14 |
| 16 | yes | 2.18 | take_profit | -0.10 | 2.61 | 69 | 13 |
| 17 | yes | 2.15 | take_profit | -0.09 | 2.59 | 68 | 12 |
| 18 | yes | 2.20 | take_profit | -0.05 | 2.62 | 69 | 14 |
| 19 | yes | 2.22 | take_profit | -0.13 | 2.60 | 72 | 12 |
| 20 | yes | 2.23 | take_profit | -0.10 | 2.62 | 81 | 16 |

### Run — EURUSD intraday (seed 3)

**What this run is.**

- Dataset: `positive_control:seed=3:bars=40000:vol=0.0001:spread=8`
- Bars: 40,001 M1, harness `wp2.1.0`
- Evaluated: 2024-01-03T01:00:00.000Z → 2024-01-29T18:30:00.000Z
- Decisions: 2,567 · arms 1815 · fills 1762
- Deflated for 3 configuration(s) searched.

Caveats carried by this run:
- Positive control: regime-switching drift (6.00e-5/bar, persistent sign)
- plus AR(1) mean reversion (phi=0.9) in the range state.
- Switch probability 1.11e-3 per bar.
- A pipeline that cannot arm here must not be trusted to reject the nulls.
- Frames evaluated: M5, M15, M30.
- Calendar: clear and available for every evaluation (price-logic baseline).
- Book: empty — per-trade edge, no portfolio interaction (WP8 measures that).

**Headline numbers.**

| Metric | Value |
|---|---|
| Arm rate | 70.71% (1815/2567) |
| Fill rate (of arms) | 97.1% |
| Trades | 1762 |
| Hit rate | 76.2% |
| Mean R | 1.367 ± 0.032 |
| Median R | 2.217 |
| Total R | 2408.82 |
| 5% CVaR (mean tail loss) | 1.112 R |
| Mean MAE / MFE | -0.40 / 2.12 R |
| Longest losing streak | 44 |
| Max drawdown | 47.35 R |
| Mean cost | 0.062 R |
| Probabilistic Sharpe | 1.000 |
| Deflated Sharpe | 1.000 |

**Calibration.**

Brier 0.1982, skill vs base rate -0.0938, reliability slope 0.334.

| Predicted | Observed | n |
|---|---|---|
| 38.6% | 80.1% | 176 |
| 55.7% | 63.1% | 176 |
| 67.0% | 61.4% | 176 |
| 77.2% | 53.4% | 176 |
| 85.2% | 72.7% | 176 |
| 90.9% | 80.7% | 176 |
| 94.8% | 80.1% | 176 |
| 97.1% | 90.9% | 176 |
| 98.7% | 92.0% | 176 |
| 99.5% | 88.6% | 176 |
| 100.0% | 0.0% | 2 |

**Attribution by exit.**

| Exit | n | Mean R | Total R |
|---|---|---|---|
| stop_loss | 363 | -0.969 | -351.62 |
| take_profit | 1222 | 2.201 | 2690.19 |
| trail | 57 | 1.061 | 60.45 |
| time_stop | 57 | -0.284 | -16.17 |
| break_even | 28 | 0.633 | 17.72 |
| end_of_data | 35 | 0.236 | 8.25 |

**Unfilled arms.**

- expired: 30
- invalidated: 23

**First 20 trades.**

| # | Filled | R | Exit | MAE | MFE | Bars | Actions |
|---|---|---|---|---|---|---|---|
| 1 | expired | — | — | 0.00 | 0.00 | 0 | 0 |
| 2 | expired | — | — | 0.00 | 0.00 | 0 | 0 |
| 3 | yes | -1.08 | stop_loss | -1.08 | 0.42 | 76 | 1 |
| 4 | yes | -1.05 | stop_loss | -1.06 | 0.00 | 63 | 1 |
| 5 | yes | -1.08 | stop_loss | -1.02 | 1.03 | 340 | 1 |
| 6 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 7 | yes | -0.05 | stop_loss | -1.02 | 1.05 | 304 | 3 |
| 8 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 9 | yes | -0.00 | stop_loss | -1.03 | 1.56 | 266 | 3 |
| 10 | yes | -1.07 | stop_loss | -1.02 | 0.88 | 250 | 1 |
| 11 | yes | -1.09 | stop_loss | -1.04 | 0.89 | 219 | 1 |
| 12 | yes | -0.11 | stop_loss | -1.05 | 1.03 | 188 | 3 |
| 13 | yes | -1.06 | stop_loss | -1.03 | 0.36 | 171 | 1 |
| 14 | yes | -1.05 | stop_loss | -1.03 | 0.21 | 158 | 1 |
| 15 | yes | -1.05 | stop_loss | -1.03 | 0.12 | 143 | 1 |
| 16 | yes | -1.06 | stop_loss | -1.03 | 0.23 | 130 | 1 |
| 17 | invalidated | — | — | 0.00 | 0.00 | 0 | 0 |
| 18 | yes | -1.05 | stop_loss | -1.02 | 0.00 | 99 | 1 |
| 19 | yes | 2.01 | take_profit | -0.18 | 2.35 | 80 | 15 |
| 20 | yes | 2.36 | take_profit | -0.10 | 2.78 | 79 | 17 |
