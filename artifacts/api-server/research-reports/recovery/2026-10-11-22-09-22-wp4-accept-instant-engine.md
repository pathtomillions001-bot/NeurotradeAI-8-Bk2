# Recovery episode baseline — instant (engine selection)

- Command: `research:recovery --mode episode --method instant --selector engine --set "DIGITEVEN:-1,DIGITODD:-1" --episodes 200000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 400558. Combined recovery hit rate: 49.95% (detectable edge at this N: ±0.16pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instant/engine | 200000 | 98.85% | 1.15% | 0.00% | 0.00% | 1/4/6 | 33.79/199.99 | -1.36 | -200.00 | 3.19% | 0.77% | 0.00% | 0.80% | 38.7 |
