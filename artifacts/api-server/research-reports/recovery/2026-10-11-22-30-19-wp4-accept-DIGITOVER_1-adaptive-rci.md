# Recovery episode baseline — adaptive (rci selection)

- Command: `research:recovery --mode episode --method adaptive --selector rci --set "DIGITOVER:1" --episodes 100000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 758474. Combined recovery hit rate: 80.07% (detectable edge at this N: ±0.11pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| adaptive/rci | 100000 | 93.47% | 0.00% | 0.00% | 6.53% | 6/14/27 | 19.98/20.01 | -1.28 | -20.00 | 0.00% | 0.00% | 0.00% | 0.00% | 1.0 |
