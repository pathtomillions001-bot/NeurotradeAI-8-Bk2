# Recovery episode baseline — adaptive (engine selection)

- Command: `research:recovery --mode episode --method adaptive --selector engine --set "DIGITEVEN:-1,DIGITODD:-1" --episodes 200000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 1581987. Combined recovery hit rate: 50.06% (detectable edge at this N: ±0.08pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| adaptive/engine | 200000 | 93.16% | 0.00% | 0.00% | 6.84% | 4/17/37 | 19.85/20.00 | -1.25 | -20.00 | 6.69% | 1.15% | 0.00% | 0.00% | 17.5 |
