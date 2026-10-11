# Recovery episode baseline — adaptive (rci selection)

- Command: `research:recovery --mode episode --method adaptive --selector rci --set "DIGITOVER:5" --episodes 100000 --seed 1`
- Full shipped pipeline on i.i.d. tapes: buildMarketCandidates → decideHedge (gate, confirmations, rematch) → shipped stake formula → reduceRecoveryOutcome; loss-limit stop → 60-tick cooldown → streak reset (D6 semantics).
- Recovery trades: 699153. Combined recovery hit rate: 39.98% (detectable edge at this N: ±0.12pt).

| config | episodes | P(clear) | P(ruin) | P(unres) | P(rebase) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| adaptive/rci | 100000 | 93.54% | 0.00% | 0.00% | 6.46% | 3/16/40 | 19.73/20.00 | -1.25 | -20.00 | 13.58% | 4.84% | 1.27% | 0.00% | 1.0 |
