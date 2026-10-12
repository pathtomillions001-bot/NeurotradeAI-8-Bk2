# Recovery episode baseline — adaptive (rci selection)

- Command: `research:recovery --mode episode --method adaptive --selector rci --set "DIGITEVEN:-1,DIGITODD:-1" --episodes 20000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 158569. Combined recovery hit rate: 50.03% (detectable edge at this N: ±0.25pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| adaptive/rci | 20000 | 93.23% | 0.00% | 5.58% | 1.20% | 4/17/37 | 19.85/20.00 | -1.24 | -20.00 | 6.65% | 1.19% | 0.00% | 0.00% | 1.0 |
