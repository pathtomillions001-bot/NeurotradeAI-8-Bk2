---
name: SpeedAI recovery gate v3
description: Changes made to fastRecoveryGate + supporting infrastructure in speed-ai-engine.ts to reduce consecutive recovery losses.
---

# SpeedAI Recovery Gate v3

## What changed

### New infrastructure
- `RecoveryTradeRecord` interface + `recentRecoveryTrades: RecoveryTradeRecord[]` (last 8) added to `SpeedRecoveryState`
- `deepSignalBonus(contractType, barrier, digits, prices)` — adds +20/-15 pts per contract type using signals NOT in `precisionScore`:
  - OVER/UNDER: running-digit Z-score vs 4.5 + 20-tick directional frequency
  - EVEN/ODD: chi-square parity significance test + 40-tick bias rate
  - MATCH: tighter gap sweet-spot (4-9t = +12) + 30-tick frequency validation
  - DIFF: stricter cold-gap (≥10t = +15) + 30-tick low-frequency check
  - CALL/PUT: volatility penalty + recency-momentum bonus
- `pickTopMatchBarriers(digits, topN=3)` — returns top-3 MATCH digit candidates by Markov+freq+gap; gate evaluates all 3 instead of committing to 1
- `waitForGreenLight(symbol, ct, barrier, maxWaitMs=1500, pollMs=80)` — polls actual tick events every 80ms instead of flat sleep(600)

### Gate upgrades (fastRecoveryGate v3)
- 4-window scoring: 15t(0.20) + 30t(0.30) + 60t(0.35) + 100t(0.15) — more weight on ultra-recent data
- `deepSignalBonus` applied on top of 4-window base score
- Anti-pattern penalty: tracks `recentRecoveryTrades`; -8 pts (decaying with age) for any contract+barrier combo that recently lost; win resets its penalty
- MATCH expands to top-3 barrier candidates before scoring
- Recovery trade history cleared when debt fully clears (fresh episode)

### Loop wiring
- `recordRecoveryOutcome` now accepts optional `tradeContractType` + `tradeBarrier`; appends to `recentRecoveryTrades` only when `inRecovery` was true at trade time
- `runLoop` passes `session.recovery.recentRecoveryTrades` to `fastRecoveryGate`
- `runLoop` uses `waitForGreenLight` for green-light wait; re-runs gate if condition is met within timeout

**Why:** Flat 600ms sleep + single MATCH barrier + no loss memory = gate could keep picking the same losing setup. Anti-pattern penalty + multi-candidate MATCH + tick-polling together break the consecutive-loss cycle.

**How to apply:** Any change to `SpeedRecoveryState` fields must also be reflected in the initial session state (two places: module-level `session` const and inside `startSession`).
