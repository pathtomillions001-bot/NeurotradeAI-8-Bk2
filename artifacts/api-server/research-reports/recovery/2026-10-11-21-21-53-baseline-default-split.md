# Recovery ladder baseline — split

- Command: `research:recovery --method split --set "DIGITOVER:3,DIGITUNDER:6" --capital 200 --base 1 --max-stake 500 --episodes 200000 --seed 1`
- Episodes: 200000 per contract. Horizon: 3000 trades. Ruin = balance < $0.35.
- Episode model: one base-stake normal LOSS books the debt; the shipped stake formula + limits then run against i.i.d. outcomes at the contract's true p0. No ranker, no lookahead.
- TRUE loss runs are reset only by a win (cooldown resets never mask them).

| config | episodes | P(clear) | P(ruin) | P(unres) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Over 3 (split) | 200000 | 91.26% | 0.05% | 8.69% | 5/90/975 | 95.43/145.91 | -7.78 | -157.42 | 13.55% | 7.34% | 1.76% | 0.00% | 0.0 |
| Under 6 (split) | 200000 | 91.30% | 0.05% | 8.65% | 5/87/954 | 94.57/144.87 | -7.72 | -157.10 | 13.42% | 7.29% | 1.77% | 0.00% | 0.0 |

Interpretation: mean cash ≈ −(margin) × expected volume staked; CVaR99 is the
tail cost of the ladder. On i.i.d. data no staking geometry makes these
positive — the table quantifies the SHAPE of the loss, not a way around it.
