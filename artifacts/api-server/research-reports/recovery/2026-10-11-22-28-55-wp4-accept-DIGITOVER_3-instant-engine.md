# Recovery episode baseline — instant (engine selection)

- Command: `research:recovery --mode episode --method instant --selector engine --set "DIGITOVER:3" --episodes 100000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 167340. Combined recovery hit rate: 60.09% (detectable edge at this N: ±0.24pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instant/engine | 100000 | 99.04% | 0.96% | 0.00% | 0.00% | 1/3/5 | 27.63/188.56 | -1.30 | -192.57 | 1.02% | 0.00% | 0.00% | 0.62% | 122.2 |
