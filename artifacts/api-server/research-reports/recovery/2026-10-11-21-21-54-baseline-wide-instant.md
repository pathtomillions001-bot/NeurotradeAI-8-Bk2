# Recovery ladder baseline — instant

- Command: `research:recovery --method instant --set "CALL:-1,PUT:-1,DIGITOVER:4,DIGITUNDER:5,DIGITEVEN:-1,DIGITODD:-1,DIGITMATCH:-1,DIGITDIFF:-1" --capital 200 --base 1 --max-stake 500 --episodes 100000 --seed 1`
- Episodes: 100000 per contract. Horizon: 3000 trades. Ruin = balance < $0.35.
- Episode model: one base-stake normal LOSS books the debt; the shipped stake formula + limits then run against i.i.d. outcomes at the contract's true p0. No ranker, no lookahead.
- TRUE loss runs are reset only by a win (cooldown resets never mask them).

| config | episodes | P(clear) | P(ruin) | P(unres) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Rise (instant) | 100000 | 98.48% | 1.52% | 0.00% | 1/4/6 | 35.54/157.90 | -1.49 | -157.90 | 3.02% | 0.00% | 0.00% | 0.00% | 0.0 |
| Fall (instant) | 100000 | 98.44% | 1.56% | 0.00% | 1/4/6 | 35.54/157.90 | -1.55 | -157.90 | 3.04% | 0.00% | 0.00% | 0.00% | 0.0 |
| Over 4 (instant) | 100000 | 98.87% | 1.13% | 0.00% | 1/4/6 | 33.79/199.99 | -1.31 | -200.00 | 3.06% | 0.78% | 0.00% | 0.77% | 0.0 |
| Under 5 (instant) | 100000 | 98.91% | 1.09% | 0.00% | 1/4/6 | 33.79/199.99 | -1.23 | -200.00 | 3.08% | 0.72% | 0.00% | 0.75% | 0.0 |
| Even (instant) | 100000 | 98.83% | 1.17% | 0.00% | 1/4/6 | 33.79/199.99 | -1.39 | -200.00 | 3.16% | 0.79% | 0.00% | 0.74% | 0.0 |
| Odd (instant) | 100000 | 98.85% | 1.15% | 0.00% | 1/4/6 | 33.79/199.99 | -1.35 | -200.00 | 3.09% | 0.79% | 0.00% | 0.74% | 0.0 |
| Matches auto (instant) | 100000 | 98.21% | 1.79% | 0.00% | 7/21/34 | 59.27/200.00 | -2.45 | -200.00 | 58.69% | 47.62% | 38.51% | 0.18% | 0.0 |
| Differs auto (instant) | 100000 | 99.01% | 0.99% | 0.00% | 1/1/2 | 13.12/13.12 | -1.49 | -158.46 | 0.00% | 0.00% | 0.00% | 0.00% | 0.0 |

Interpretation: mean cash ≈ −(margin) × expected volume staked; CVaR99 is the
tail cost of the ladder. On i.i.d. data no staking geometry makes these
positive — the table quantifies the SHAPE of the loss, not a way around it.
