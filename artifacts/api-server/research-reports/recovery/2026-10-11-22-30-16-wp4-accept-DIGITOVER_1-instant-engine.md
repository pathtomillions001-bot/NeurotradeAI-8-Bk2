# Recovery episode baseline — instant (engine selection)

- Command: `research:recovery --mode episode --method instant --selector engine --set "DIGITOVER:1" --episodes 100000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 127826. Combined recovery hit rate: 80.05% (detectable edge at this N: ±0.28pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instant/engine | 100000 | 99.24% | 0.76% | 0.00% | 0.00% | 1/2/3 | 6.35/34.96 | -1.30 | -152.54 | 0.00% | 0.00% | 0.00% | 0.66% | 119.1 |
