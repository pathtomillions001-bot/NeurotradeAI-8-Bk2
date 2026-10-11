# Recovery episode baseline — adaptive (rci selection)

- Command: `research:recovery --mode episode --method adaptive --selector rci --set "CALL:-1,PUT:-1,DIGITOVER:4,DIGITUNDER:5,DIGITEVEN:-1,DIGITODD:-1,DIGITDIFF:-1" --episodes 50000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 400721. Combined recovery hit rate: 63.97% (detectable edge at this N: ±0.16pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| adaptive/rci | 50000 | 92.87% | 0.00% | 0.00% | 7.13% | 4/17/41 | 19.97/20.00 | -1.42 | -20.00 | 3.65% | 0.00% | 0.00% | 0.00% | 1.0 |
