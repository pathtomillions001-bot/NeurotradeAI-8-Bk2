# Recovery episode baseline — instant (engine selection)

- Command: `research:recovery --mode episode --method instant --selector engine --set "DIGITOVER:5" --episodes 100000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 249909. Combined recovery hit rate: 39.85% (detectable edge at this N: ±0.20pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instant/engine | 100000 | 98.79% | 1.21% | 0.00% | 0.00% | 2/5/8 | 27.40/200.00 | -1.44 | -200.00 | 7.84% | 2.87% | 1.03% | 0.66% | 89.6 |
