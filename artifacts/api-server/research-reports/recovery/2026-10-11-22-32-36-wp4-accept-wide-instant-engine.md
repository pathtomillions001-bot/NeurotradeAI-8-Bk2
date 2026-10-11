# Recovery episode baseline — instant (engine selection)

- Command: `research:recovery --mode episode --method instant --selector engine --set "CALL:-1,PUT:-1,DIGITOVER:4,DIGITUNDER:5,DIGITEVEN:-1,DIGITODD:-1,DIGITDIFF:-1" --episodes 50000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 74643. Combined recovery hit rate: 71.47% (detectable edge at this N: ±0.37pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instant/engine | 50000 | 98.52% | 1.22% | 0.26% | 0.00% | 1/3/5 | 22.34/199.99 | -1.80 | -200.00 | 0.26% | 0.04% | 0.00% | 5.61% | 8.8 |
