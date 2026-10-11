# Recovery episode baseline — split (engine selection)

- Command: `research:recovery --mode episode --method split --selector engine --set "DIGITEVEN:-1,DIGITODD:-1" --episodes 200000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 15351709. Combined recovery hit rate: 50.00% (detectable edge at this N: ±0.03pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| split/engine | 200000 | 88.93% | 0.00% | 11.07% | 0.00% | 6/73/365 | 39.00/55.85 | -2.92 | -59.48 | 19.95% | 10.17% | 3.36% | 0.00% | 14.3 |
