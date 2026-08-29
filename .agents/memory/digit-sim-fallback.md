---
name: Digit analyser simulation fallback
description: When active_symbols returns empty (bad app_id), DerivTickManager starts a price simulator so digit analysers always have data.
---

## Rule
`DerivTickManager.startSimulation()` is called automatically in `onActiveSymbols` when the Deriv server returns zero symbols. It seeds 150 synthetic ticks for every digit market immediately, then continues generating one tick per market per second. `stopSimulation()` is called automatically on the first real tick from Deriv.

**Why:** Without simulation, `tickBuffers` is empty → `digitStats` is null → EvenOdd, Digit Over/Under, and Matches/Differs panels all silently disappear from the UI.

**How to apply:**
- `SIM_PARAMS` in `deriv.ts` holds base prices and per-tick volatility for each market.
- `pushSimulatedTick()` rounds to the correct `pipSize` decimal places so `extractLastDigit` returns valid 0–9 values.
- Frontend panels (EvenOddPanel, Digit Over/Under, Matches/Differs) now show a spinner instead of returning null when `digitStats` is null — so they're always visible.
- Once a valid numeric `DERIV_APP_ID` is set, real Deriv ticks take over and simulation stops without restart.
