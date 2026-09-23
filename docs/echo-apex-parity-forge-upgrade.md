# Echo Apex & Parity Forge — Brain Upgrade (research → implementation)

*Scope: the two dedicated engines only — Echo Apex (Matches) and Parity Forge
(Even/Odd). Goal: better normal AND recovery trades through sharper probability
estimation, honest calibration, EV-aware selection — with ZERO new hard gates
(the pacing valves, budgets and the frozen recovery bar are untouched; no
function on any firing path gained a veto).*

## 1. Why they underperformed (diagnosis)

Both bots already fused several lenses and fired through a budget valve, but:

1. **Longest-match commitment.** Apex's suffix memory hard-commits to its one
   longest adequately-sampled context; Parity Forge's Markov lens capped at
   order 1–2 and its suffix lens at the longest matching digit context. The
   right context depth is exactly the thing you cannot know a priori — a hard
   commit throws away all the other depths' evidence.
2. **No gap conditioning (Apex).** The echo spectrum measured the *average*
   repeat rate at lag k, but nothing conditioned on the *actual elapsed gap*
   of each digit right now.
3. **Flat Hawkes base (Apex).** The self-exciting lens assumed every digit's
   base rate is 0.1 — structurally warm digits got no base tilt.
4. **No oscillation read (Parity).** Cyclic alternation (E O E O at any
   period) is invisible to order-1/2 chains and only crudely caught by the
   run hazard.
5. **Shallow digit conditioning (Parity).** P(parity | last digit) misses
   digit-pair flips (9→even runs, 1→odd runs…).
6. **Loss-pair risk from a bare order-1 chain (Parity).** q_LL priced the
   ladder-killing loss pair with the weakest lens in the stack.
7. **Heuristic fusion weights.** Weights came from a softmax of skill; they
   were never directly optimized for the pooled logarithmic score.
8. **Probability-picked, not EV-picked.** Matches pays a *different* multiplier
   per digit (8.2×–9.4× typical) and Even/Odd quotes drift apart (1.90×–2.00×);
   both bots picked by probability alone and discovered the payout only after
   committing.

## 2. What was implemented

### Echo Apex — 3 → 5 lenses (`apex-analysis.ts`)
- **`DigitCTW` — context-tree ORDER MIXTURE (depth 5).** Per-order
  Krichevsky–Trofimov context predictors with sequential log-scores; the
  predictive blends all orders 0..5 with posterior weights ∝ e^(log-score),
  each order first PPM-interpolated toward the shallower blend by data mass.
  Log-loss within log(6) nats of the *best* order, and it concentrates on that
  order exponentially fast — the "which Markov order?" question is answered by
  the data instead of a hard commit.
- **`RenewalHazard` — gap-conditioned per-digit hazard.** Discrete hazard
  h_d(g) = P(d prints | d last printed g ticks ago) from the censored gap
  history; P(next = d) ∝ h_d(current gap of d). Complementary to the echo
  spectrum, which only knows average lags.
- **Per-digit Hawkes base intensities** — recency-decayed frequency shares
  blended lightly (0.35) into the base; the echo lens's affinity prior already
  carries frequency, so double-counting is avoided.
- **Fusion fitting: skill weights → regularised coordinate descent** on the
  simplex, directly minimising pooled train log-loss with a KL-to-uniform
  complexity penalty (measured to be essential: unregularised descent
  manufactures fake expectancy on provably fair tapes) and τ ∈ [1, 1.5]
  (sub-1 sharpens noise; runaway softening degenerates the pool). The valve
  seed is recomputed at the final (weights, τ).
- **EV-aware digit choice at the fire tick** (`apex-engine.ts`): the top-3
  fused digits are quoted in parallel and the shot goes to argmax p·payout.
  Selection upgrade inside the already-open valve — never a gate; a locked
  user digit is never overridden.

### Parity Forge — 4 → 6 lenses (`parity-forge-analysis.ts`)
- **`ParityCTW` — binary context-tree order mixture (depth 12)** over the
  parity process: every chain order 0..12 blended by posterior log-score with
  PPM interpolation. Depth-tagged node keys (bits alone collide: "1" at depth 1
  equals "0001" at depth 4 — found by test).
- **`ParityEcho` — parity echo spectrum** (lags 1..24, recency-decayed): reads
  cyclic alternation at any period directly.
- **`DigitParity` deepened to two-digit contexts** with hierarchical backoff
  (pair → digit → fair), Jeffreys-smoothed.
- **q_LL from the fused opposite side** — the loss-pair risk is now the full
  six-lens model's probability of the losing side, not a bare order-1 chain.
- **Same fusion upgrade**: regularised coordinate descent + τ ∈ [1, 1.5],
  valve seed at the final pool.
- **Honest PRIME**: the verdict now additionally requires the recovery band's
  Wilson 95% LOWER bound to clear break-even (parity with Echo Apex's bar) —
  a lucky 7-of-12 fair-tape run can no longer wear the top badge. (A
  measurement-honesty fix, not a trade gate.)
- **EV-aware side choice at the fire tick** (`parity-forge-engine.ts`): both
  sides quoted in parallel, argmax p·payout fires — only when the user armed
  BOTH sides.

### Consoles (`trading-platform`)
- Lens-mix bars and per-lens readouts render the new lens sets dynamically
  (Apex: echo/hawkes/suffix/ctw/renewal; Parity: markov/hazard/digit-pair/
  suffix/CTW/echo).

## 3. Measured (held-out 40%, seeded deterministic streams)

| Stream | Old pipeline | New pipeline |
|---|---|---|
| Apex · planted repeat rhythm (echo 30%) | 38.0% hit on 71 shots | **33.3% hit on 117 shots** — same accuracy, +65% shots ⇒ ~+34% total captured edge |
| Apex · fair tapes (30 seeds) | — | 11.8% hit (fair = 11.2% break-even), mean edge +4.5%, **0 PRIME** |
| Parity · planted alternation (flip 70%) | normal 69.4% / recovery 71.8%, 37 loss pairs | **normal 69.1% / recovery 72.8%, 35 loss pairs**, PRIME with Wilson-proof recovery band |
| Parity · fair tapes | PRIME possible by luck | PRIME statistically impossible without proof; paper edge centered on 0 |

On structure-bearing tapes the replay fires at budget (the valve paces, never
starves); on fair tapes it measures exactly break-even. That is the whole
design: sharper where structure exists, honest where it does not.

## 4. Deliberately NOT done
- **No gates.** No break-even reject, no loss-run ratchet, no cool-down, no
  entropy/FDR vetoes on any firing path. `decideRecovery` still cannot see the
  loss run; the recovery bar is still a frozen constant.
- **No stake interference.** The shared debt-driven recovery ledger is
  untouched.
- **No pace changes.** Budgets (0.06/tick Apex, 0.20/tick Parity normal) are
  unchanged; recovery pace parity (factor 1) preserved.
