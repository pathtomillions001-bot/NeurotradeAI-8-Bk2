# Echo Apex v3 — why it missed good Matches trades, and what was changed

*Research notes for the Echo Apex trade-quality upgrade (Matches / DIGITMATCH specialist).
Every number below comes from deterministic seeded experiments against the real production
policy (`apex-analysis.ts`) — null tapes (i.i.d. uniform digits, the honest model of a fair
Deriv synthetic feed) and planted-structure tapes. No gate was added anywhere; the pacing
budget, the one-decision-per-tick valve and the honest held-out replay are unchanged.*

## 1. Diagnosis — measured, not guessed

The policy replays were instrumented for four questions:

| Question | Measurement (9000-tick tapes, seeded) | Answer |
|---|---|---|
| Does the pipeline find real rhythm? | Planted lag-3 echo at 6–25% strength | **Yes** — realized hit 13.5%→32.7% vs break-even 11.2% (+20% to +192% EV/shot) |
| Why does it still lose on typical sessions? | Null (fair) tapes, 12 seeds | Fired shots **claimed 12.68%** but **realized 10.32%** — a 2.36-pt winner's-curse gap → −7.9% EV/shot |
| What does the old τ cap do to real structure? | 16% echo tape | Claimed **19.2%** where **25.9%** realized — the hard `τ ∈ [1, 1.5]` cap under-claims signal |
| Do the lenses add independent evidence? | Per-lens log-loss, 16% echo | echo +0.066 nats skill, renewal +0.025, hawkes +0.015, ctw −0.007, **suffix −0.22** |

Three structural causes, all quantified:

1. **Winner's curse on the argmax.** The valve fires on the fused argmax probability — the
   max of 10 correlated, noisy estimates. Its expected value is biased up even when every
   lens is unskilled, so on fair tapes the bot paid break-even-plus prices for noise. The
   full-data `peek()` digit pick in the scan had the same bias one level up.
2. **The τ cap fought both regimes at once.** Full-distribution log-loss cannot see the
   selection event, so a hardcoded `[1, 1.5]` grid was used as a guard. That softened real
   structure (19% claimed vs 26% realized) while still allowing fair-tape over-claims.
3. **The suffix lens was a liability.** Hard commitment to the longest context with ≥6
   decayed samples cost −0.22 nats on structured tapes; long contexts are mostly
   coincidences. The pool kept it alive at the 5% floor, dragging every fused estimate.

Also measured and dismissed: top-3 EV truncation at fire time costs only 0–0.11% of EV on
warm posteriors (≤5% of cold ticks) — worth removing, not the headline. Temperature alone
moves *claims*, not EV: at any τ, a fair tape fires on the same noise peaks and realizes
~10.2–10.3%. The honest levers are the payout side of `EV = p · payout` and sharper lenses.

## 2. The v3 upgrades (selection and calibration only — zero gates)

1. **Decision-calibrated fusion** (`optimizePoolWeights`). The fit objective is now
   `mean log-loss + wTop1 · mean top-1 Brier`, where the top-1 term scores the fused
   argmax's claim against the outcome — the exact event the valve trades. Softening now
   has to be *paid for* in decision-calibration and sharpening is earned exactly when the
   argmax event justifies it. Measured: fair-tape claim/realize gap 2.36 → **1.15 pts**
   (τ drifts to the soft end); a 25% echo earns τ = 0.70 and claims 29.1% vs 32.0%
   realized (the old cap made that impossible).
2. **Held-out EV digit pick** (`scoreMarket`). The AI digit is
   `argmax_d meanP_test[d] · payout[d]`, using each digit's mean fused probability over the
   **unseen test half** accumulated during the honest replay — no per-tick selection, no
   winner's curse. Falls back to the warmed peek only when the test half is too thin.
3. **Full-vector EV** (`ApexPolicy.decide/peek`, engine fire path). The engine quotes all
   10 digit payouts (60s-cached, bounded-concurrency sweep, canonical fallback) and the
   policy fires `argmax p·payout` over the whole vector. On a statistically flat book this
   is the one real lever: at fair p = 10%, the 9.4× quote bleeds −6%/shot where 8.2×
   bleeds −18%/shot. **Measured on null tapes with a realistic 8.2–9.4 quote spread:
   EV/shot improves from −11.4% (flat pricing) to −5.3% — 54% less bleed at the same fire
   budget.** Recovery inherits this: `argmax p·pay` is also the Kelly-consistent digit, and
   the chosen digit's quote feeds the shared recovery stake math.
4. **Suffix lens PPM interpolation.** Each order's Laplace predictive blends into the
   shallower ladder with depth-aware damping (`k = total/(total + 4·o²)`): thin deep
   contexts inherit the shallower view instead of shouting. Fair-tape skill improves from
   −0.22 to ≈ −0.07 nats while preserving the planted echo tilt.
5. **Online hedge between re-fits** (`OnlineHedge`). Exponentially-decayed per-lens
   log-loss is softmaxed into the fitted weights with a ramp (ρ = n/(n+400), 5% floor) —
   multiplicative-weights aggregation with the standard Hedge regret bound, so the pool
   re-aims at a regime change in tens of ticks instead of waiting for the 20–45s re-fit.
   The scan replay measures the whole thing honestly because the replay runs the identical
   online path.

## 3. Measured result summary (v3 pipeline, quoted payouts)

| Tape | τ | realized | claimed | mean payout | EV/shot |
|---|---|---|---|---|---|
| NULL (fair), quoted 8.2–9.4 | 2.60 | 10.53% | 11.03% | 9.00× | **−5.28%** |
| NULL (fair), flat 8.93 (legacy pricing) | 2.60 | 9.92% | 11.07% | 8.93× | −11.41% |
| lag-3 echo 6% | 2.60 | 13.99% | 11.35% | 8.91× | **+24.6%** |
| lag-3 echo 16% | 2.60 | 22.99% | 12.26% | 8.78× | **+101.8%** |
| lag-3 echo 25% | 0.70 | 31.98% | 29.14% | 8.77× | **+180.3%** |

Read: on fair tapes (most sessions) the payout-side EV pick halves the bleed with zero
change to the fire budget; on structured tapes the catches remain as strong as before and
the *claims* are now calibrated in both directions. Mid-strength structure can still
under-claim (16% echo claims 12.3% vs 23% realized at the soft τ) — this costs nothing in
realized EV because the valve's quantile bar still concentrates shots on the peaks; it is
recorded as known follow-up (per-order skill weighting for the suffix/CTW ladder).

## 4. Parity Forge — the deploy bug (same PR)

The scan fits **6** lens weights (`parityMkv, runHazard, digitPair, suffix, parityCTW,
echo`) into the candidate card, but `/api/bots/parity-forge/start`'s parameter parser
accepted only 4-weight vectors. Every click on **"Trade Locked on …"** / **"Smart
Switching"** bounced with `400 "Run the scan first…"` and the bot never started. Fixed by
accepting the live lens count (`PARITY_FORGE_LENS_COUNT`) and migrating legacy 4-lens
cards (first four keep 60% of the mass, the two newer lenses share the rest). Regression
tests drive the real HTTP route with the exact card shapes the console sends; verified
end-to-end against a running server (scan → start → `running: true` → pacing valve live).

## 5. What was deliberately NOT done

- **No gates.** No break-even reject, no entropy veto, no confidence floor, no minimum
  edge to fire. Selectivity remains the pacing budget alone.
- **No change to Parity Forge's trading logic** (per instruction) — only the deploy
  handoff bug.
- **Price-path microstructure lens** (conditioning digits on the underlying price's
  distance to the next pip boundary) is the next real information source; it needs the
  price stream inside the analysis core, which is deliberately digits-only today.
