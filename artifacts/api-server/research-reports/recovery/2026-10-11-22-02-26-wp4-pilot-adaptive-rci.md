# Recovery episode baseline — adaptive (rci selection)

- Command: `research:recovery --mode episode --method adaptive --selector rci --set "DIGITEVEN:-1,DIGITODD:-1" --episodes 20000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 0. Combined recovery hit rate: 0.00% (detectable edge at this N: ±Infinitypt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| adaptive/rci | 20000 | 0.00% | 0.00% | 0.00% | 100.00% | 0/0/0 | 1.00/1.00 | -1.00 | -1.00 | 0.00% | 0.00% | 0.00% | 0.00% | 0.0 |
