# Recovery selection null test — instant

- Command: `research:recovery --mode null --method instant --set "DIGITEVEN:-1,DIGITODD:-1" --episodes 1000 --seed 1`
- Engine arm runs the shipped ranker + gates; random arm draws a uniform contract from the SAME set with the SAME stake formula and cooldown rules. Both arms trade i.i.d. tapes.
- Hit rate: engine 49.80% (2026 trades) vs random 48.49% (2048 trades).
- Detectable edge at this N ≈ ±2.22pt (2·√(0.25/N)).
- VERDICT: engine selection is statistically INDISTINGUISHABLE from random choice on i.i.d. data (as expected).

| config | episodes | P(clear) | P(ruin) | P(unres) | trades p50/p90/p99 | peak debt p95/p99 | mean cash | CVaR99 | run≥6 | run≥8 | run≥10 | cap-trap | latency(t) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| instant/engine | 1000 | 99.40% | 0.60% | 0.00% | 2/4/6 | 33.79/145.43 | -0.25 | -119.62 | 2.90% | 0.40% | 0.00% | 1.00% | 41.5 |
| instant/random | 1000 | 98.40% | 1.60% | 0.00% | 2/4/6 | 33.79/200.00 | -2.26 | -200.00 | 3.90% | 1.40% | 0.00% | 0.90% | 2.6 |
