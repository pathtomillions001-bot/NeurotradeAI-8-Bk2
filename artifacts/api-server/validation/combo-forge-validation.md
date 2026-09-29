# Combo Forge validation (full)

## 1. Null harness — 1,000,000 i.i.d. ticks × 4 markets, evaluation every 100 ticks, window 500
| gate | evaluations | fires | fire rate | 95% upper | nominal α | trades | return/$ | expected −margin/$ | z |
|---|---|---|---|---|---|---|---|---|---|
| Combo strict | 9995 | 1 | 0.01% | 0.06% | 5% | 1 | -100.00% | -2.50% | -1.00 |
| Combo balanced | 9995 | 5 | 0.05% | 0.12% | 25% | 5 | -22.00% | -2.50% | -0.45 |
| Combo always | 9995 | 9995 | 100.00% | 100.00% | — | 9995 | -0.99% | -1.97% | 1.53 |
| Omni gate (digits only, window 120) | 9995 | 7992 | 79.96% | 80.73% | — | 7992 | -1.77% | -2.23% | 0.47 |
| Omni gate (digits only, window 500) | 9995 | 9886 | 98.91% | 99.10% | — | 9886 | -2.36% | -2.20% | -0.19 |

Per-contract realised vs expected return:
- Combo always: Under 8 3843× -0.7% (exp -1.6%); Over 1 3693× -1.1% (exp -1.6%); Even 701× -0.1% (exp -2.5%); Odd 764× 0.6% (exp -2.5%); Rise 484× -8.4% (exp -4.0%); Fall 510× 1.6% (exp -4.0%)
- Omni gate (digits only, window 120): Even 2792× -3.9% (exp -2.5%); Odd 2773× 1.3% (exp -2.5%); Over 1 1196× -3.9% (exp -1.6%); Under 8 1231× -1.7% (exp -1.6%)
- Omni gate (digits only, window 500): Even 3215× -1.8% (exp -2.5%); Over 1 1594× -2.1% (exp -1.6%); Odd 3372× -2.9% (exp -2.5%); Under 8 1705× -2.6% (exp -1.6%)

## 2. Ladder sessions on null tapes (shared recovery formula, TP 10 / SL 5 / breaker 6 / 3 steps)
| mode | sessions | trades | staked | P&L | P&L per $ staked | expected | z | take-profit | stop-loss | breaker | tape-end | stake range |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| always | 300 | 8852 | 12831 | -209.1 | -1.63% | -2.43% | 0.61 | 130 | 170 | 0 | 0 | 1.00–12.71 |
| balanced | 120 | 66 | 105 | -4.3 | -4.05% | -2.31% | -0.10 | 1 | 1 | 0 | 118 | 1.00–11.68 |
| strict | 30 | 0 | 0 | 0.0 | 0.00% | 0.00% | 0.00 | 0 | 0 | 0 | 30 | 0.00–0.00 |

## 3+4. Planted-edge power — Over 1 (payout 1.23, break-even 81.3%), one edge market among 4, evidence grows with ticks (window = ticks so far, max 1000)
| gate | edge | true win rate | detected ≤500 | detected ≤1000 | median ticks | fires on something else | return after detect | theory |
|---|---|---|---|---|---|---|---|---|
| Combo strict | +3 pts | 84.3% | 4% | 10% | — | 0% | 2.5% | 3.7% |
| Combo balanced | +3 pts | 84.3% | 6% | 18% | — | 0% | 11.8% | 3.7% |
| Omni gate (window 120) | +3 pts | 84.3% | 18% | 18% | — | 82% | 23.0% | 3.7% |
| Combo strict | +6 pts | 87.3% | 34% | 87% | 650 | 0% | 5.3% | 7.4% |
| Combo balanced | +6 pts | 87.3% | 51% | 90% | 500 | 0% | 5.9% | 7.4% |
| Omni gate (window 120) | +6 pts | 87.3% | 43% | 43% | — | 57% | 3.7% | 7.4% |
| Combo strict | +10 pts | 91.3% | 98% | 100% | 225 | 0% | 12.8% | 12.3% |
| Combo balanced | +10 pts | 91.3% | 99% | 100% | 175 | 0% | 13.8% | 12.3% |
| Omni gate (window 120) | +10 pts | 91.3% | 80% | 80% | 100 | 20% | 12.8% | 12.3% |
| Combo strict | +15 pts | 96.3% | 100% | 100% | 100 | 0% | 19.9% | 18.4% |
| Combo balanced | +15 pts | 96.3% | 100% | 100% | 100 | 0% | 18.9% | 18.4% |
| Omni gate (window 120) | +15 pts | 96.3% | 99% | 99% | 100 | 1% | 18.9% | 18.4% |

Forge-time claim for Over 1 under strict (K=24), as the console quotes it (seeded simulation of the real gate; floor = threshold ÷ KL with the true rate known): +3pts ≈ >1000 ticks (floor 1996), +6pts ≈ 800 ticks (floor 475), +10pts ≈ 220 ticks (floor 157). Compare with the measured medians above.

## 5. Replay
No recorded Deriv tape is reachable from this environment (no network access to Deriv). Replaying an adversarial SYNTHETIC tape instead (regime switches every 400 ticks, digit clustering, drift) — this is a stress test, NOT recorded data. Pass `--replay quotes.csv` (one quote per line, or `epoch,quote`) to replay a real recording.
| gate | evaluations | fires | trades | realised return/$ | expected if tape were fair/$ |
|---|---|---|---|---|---|
| Combo strict | 2390 | 1086 | 1086 | 16.8% | -2.4% |
| Combo balanced | 2390 | 1260 | 1260 | 16.2% | -2.4% |
| Omni gate (digits, window 120) | 2390 | 1756 | 1756 | 18.8% | -2.3% |

## How to read this (honestly)

- **Null tapes (1, 2):** on i.i.d. ticks no gate can have an edge, so the only thing a gate can change is how often it pays the house margin. A gate that fires on a fair tape is just trading. Strict and Balanced fire far *below* their nominal α (the e-process is deliberately conservative: it is valid, not tight), so they mostly stay out; Always-trade and the Omni gate trade almost every evaluation and realise ≈ −margin, which is the expected value of a fair tape. Realised P&L per $ staked matches −margin within sampling error (|z| < 2) in every row that has enough trades.
- **Power (3, 4):** the price of that conservatism is slower detection. Quoted "ticks to detect" figures in the console come from a seeded simulation of the real gate; the information-theoretic floor is shown beside them. Edges of +3 points are effectively invisible inside a 1000-tick window. The Omni gate appears to "detect" sooner in some rows only because it also fires on contracts that have no edge (see "fires on something else"), which is not detection.
- **Replay (5):** no recorded Deriv tape is reachable from this environment, so the replay is an adversarial *synthetic* tape that contains real, exploitable structure. Both gates profit there, and Omni's gate profits at least as much because it takes more trades. That says the two gates can both find large structure; it does not say a live Deriv tape contains any. Run `--replay quotes.csv` on a real recording to get that answer.
- **What this does not show:** nothing here promises a win rate or profit on a live, fair synthetic index. The expected result on such a tape is −margin per $ staked for every strategy, including this one.

_Elapsed 493s._
