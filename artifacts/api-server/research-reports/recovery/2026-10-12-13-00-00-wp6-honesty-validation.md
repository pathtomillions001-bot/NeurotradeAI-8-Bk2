# WP6 — statistical honesty battery validation

Generated 2026-10-11T23:14:35.883Z · 400 i.i.d. runs, 5000 ticks each.

## Premise (restated)
Deriv digits come from a CSPRNG: i.i.d. uniform. Recovery contracts are priced
with a 1.6–10.7% margin, so they are negative-expectation. The honesty battery
exists to CONFIRM that per market and to gate the only permitted data-driven
adjustment — a bounded REDUCTION of the RCI margin weight (factor ∈ [0.5, 1],
never a stake increase).

## Null test: tilt on i.i.d. data must stay quiet (≤ 5%)
- BH-significant battery: 43/400 (10.8%)
- e-value ≥ 20 reached: 15/400 (3.8%)
- tilt ACTIVATED (needs BOTH): 1/400 = 0.25% → gate ≤ 5%: PASS

## Planted edge: p(Even) = 0.55 must be caught
- detected: 47/50 (94%), median trades to activation: 734

## Kill switch & bounds
- `recoveryTiltEnabled` OFF (the default) ⇒ margin factor is 1 for every contract; v2 mode off ⇒ likewise.
- Active tilt multiplies the RCI margin weight by 0.5 at most — selection order only, stakes never grow.

Battery cost: 495 ms for 400 batteries (~1.2 ms each, and only every 500 new ticks per market in production).
