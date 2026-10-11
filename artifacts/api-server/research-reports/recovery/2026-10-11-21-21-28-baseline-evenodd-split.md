# Recovery ladder baseline — split

- Command: `research:recovery --method split --set "DIGITEVEN:-1,DIGITODD:-1" --capital 200 --base 1 --max-stake 500 --episodes 200000 --seed 1`
- Episodes: 200000 per contract. Horizon: 3000 trades. Ruin = balance < $0.35.
- Episode model: one base-stake normal LOSS books the debt; the shipped stake formula + limits then run against i.i.d. outcomes at the contract's true p0. No ranker, no lookahead.
- TRUE loss runs are reset only by a win (cooldown resets never mask them).

| config | episodes | P(clear) | P(ruin) | P(unres) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Even (split) | 200000 | 91.30% | 0.34% | 8.36% | 8/102/1110 | 112.50/173.55 | -8.80 | -184.59 | 19.98% | 13.09% | 8.30% | 0.01% | 0.0 |
| Odd (split) | 200000 | 91.24% | 0.35% | 8.41% | 8/100/1087 | 112.40/173.25 | -8.81 | -184.42 | 20.00% | 13.18% | 8.33% | 0.00% | 0.0 |

Interpretation: mean cash ≈ −(margin) × expected volume staked; CVaR99 is the
tail cost of the ladder. On i.i.d. data no staking geometry makes these
positive — the table quantifies the SHAPE of the loss, not a way around it.
