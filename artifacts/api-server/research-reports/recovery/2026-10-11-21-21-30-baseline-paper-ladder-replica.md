# Recovery ladder baseline — instant

- Command: `research:recovery --method instant --set "DIGITEVEN:-1" --capital 200 --base 1 --max-stake 500 --episodes 200000 --seed 1`
- Episodes: 200000 per contract. Horizon: 3000 trades. Ruin = balance < $0.35.
- Episode model: one base-stake normal LOSS books the debt; the shipped stake formula + limits then run against i.i.d. outcomes at the contract's true p0. No ranker, no lookahead.
- TRUE loss runs are reset only by a win (cooldown resets never mask them).

| config | episodes | P(clear) | P(ruin) | P(unres) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Even (instant) | 200000 | 99.14% | 0.86% | 0.00% | 1/4/6 | 24.56/104.78 | -1.31 | -171.65 | 3.09% | 0.79% | 0.00% | 0.76% | 0.0 |

Interpretation: mean cash ≈ −(margin) × expected volume staked; CVaR99 is the
tail cost of the ladder. On i.i.d. data no staking geometry makes these
positive — the table quantifies the SHAPE of the loss, not a way around it.
