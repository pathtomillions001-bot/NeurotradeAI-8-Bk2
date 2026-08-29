---
name: SpeedAI PrecisionAI v3 improvements
description: What changed in speed-ai-engine.ts when upgrading from PrecisionAI v2 to v3 — contract-type specific weights, new signal helpers, three-window scoring, and enhanced green-light logic.
---

# SpeedAI PrecisionAI v3

## What changed

### New helper functions (added before `extractBarriers`)
- `streakAgainstLength(digits, contractType, barrier)` — unbroken consecutive recent ticks against the bet condition; used as signalBonus
- `digitGapSinceLast(digits, targetDigit)` — ticks since a specific digit last appeared; critical for MATCH/DIFF
- `markovToTarget(digits, targetDigit)` — direct Markov P(target | current last digit); more precise than markovNextProb()[target]
- `priceMomentumScore(prices, direction, window)` — recency-weighted price momentum for CALL/PUT
- `pickBestMatchBarrier` / `pickBestDiffBarrier` — now factor in gap analysis for smarter auto-barrier selection

### `precisionScore` — contract-type specific weights + signalBonus
Old: uniform `winP = empirical*0.50 + markovWin*0.25 + momentum*0.25` for all types
New: per-type weights:
- OVER/UNDER: empirical 0.40 + Markov 0.35 + momentum 0.25; streakAgainst bonus (+4 per tick, cap +12)
- EVEN/ODD: empirical 0.40 + momentum 0.35 + Markov 0.25; oddStreak bonus (+5 per tick, cap +15)
- MATCH: markovToTarget 0.55 + empirical 0.30 + momentum 0.15; gap bonus ([3-10]→+10, [11-20]→+3, <3→−8, >20→−4)
- DIFF: empirical 0.40 + markovWin 0.40 + momentum 0.20; gap bonus (≥8→+8, ≥5→+3, ≤1→−8, else→−3)
- CALL/PUT: momentum 0.50 + empirical 0.30 + markovWin 0.20; priceMomentumScore bonus ±15

Also: minimum digits lowered from 35 to 30 (more markets qualify when data is building).

### `isGreenLight` — deeper signal checks
- OVER/UNDER: now requires 2+ of last 5 digits in reversal territory OR streak≥2 OR momentum≥65% (was: just last digit ≤/≥ barrier)
- EVEN/ODD: uses streakAgainstLength internally (functionally equivalent but cleaner)
- CALL/PUT: priceMomentumScore≥0.65 added as alternative green-light path
- MATCH: (gap 3-12) OR markovToTarget>0.15 (was: appeared in last 7 but not last 2)
- DIFF: gap≥5 (relaxed from 8 — more trades, still safe)

### `fastRecoveryGate` — three-window combined scoring (v2)
Old: single 60-tick window
New: fetches 100 ticks, scores each candidate at 30/60/100 tick windows
Combined score = s30×0.25 + s60×0.50 + s100×0.25
Barrier selection uses 60-tick window (stable). Green-light uses 60-tick window.
Adaptive threshold unchanged: 52/55/58 based on consecutive losses.

### `scoreSingleMarket` + `analyzeMarketsForStrategy` — three-window scoring
Both now fetch 100 ticks (was 60) and use the same 30/60/100 combined scoring.
Consistent analysis depth between normal trades, recovery gate, and initial scan.

### Normal trade green-light retry
Extended from max 2×400ms to max 3×400ms (1.2s total wait before executing anyway).

**Why:** Each contract type has fundamentally different statistical properties. Uniform weights and single-window scoring left MATCH and EVEN/ODD under-served. The three-window approach filters one-window noise without blocking indefinitely (unlike the old 3-window consensus that required all-3 agreement).
