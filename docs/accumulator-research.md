# Accumulators — deep research, strategy and configuration

**Bot:** Compounding Range Sentinel (BOT-ACCU) · family `accumulator`
**Modules:** `artifacts/api-server/src/lib/accumulator-analysis.ts` (research), `.test.ts` (37 tests), `accumulator-engine.ts` (execution)
**Status:** analysis + engine implemented and green; this document is the sign-off record for the strategy it encodes.

---

## 1. What the instrument actually is

An Accumulator is a *resettable discrete-barrier compounding* contract. Every tick:

1. The payout multiplier grows by the growth rate: `V_k = (1 + g)^k`, where `g ∈ {1 %, 2 %, 3 %, 4 %, 5 %}` and `k` is the number of consecutive in-band ticks.
2. The bands are **re-derived from the spot price of the previous tick** — they follow the price. There is no fixed strike to be right about.
3. If a tick prints outside the band, the contract **ends and the entire stake is lost**. No partial loss, no recovery of the stake, no residual value.

Source facts confirmed against the platform's own terms ([deriv.com trading terms §2.1.1.14, §2.3.2](https://deriv.com/terms-and-conditions/trading-terms), glossary, and the Accumulators ebook): max ticks and max payout are *derived from the growth-rate factor*; the growth rate is user-selectable in whole steps from 1 % to 5 %; a "growth start step" is the minimum number of ticks before the payout starts to grow; and a per-growth-rate **maximum aggregate open stake** caps how much can be open at once. Maximum duration is 230 ticks; the shorter growth-range products (e.g. 1HZ) cap lower in practice — see §4.

Two consequences drive everything below:

* **There is no payout ratio to invert.** Every other bot in this repo recovers a loss by inverting a known payout multiplier. An accumulator loss is *always exactly the stake*. Recovery must therefore re-earn the lost stake **through the growth path** — that is, by surviving long enough to compound it back.
* **The knockout is the whole risk.** Position sizing and horizon choice are the only risk levers; there is nothing to hedge and nothing to stop out.

---

## 2. The band model, and why the product is only *just* fair

Let `σ_tick` be the per-tick standard deviation of the log price and `z_b(g)` the band half-width in σ. The published bands are reproduced to **better than 0.01 %** by:

```
band half-width   b   = σ_tick · z_b(g)
z_b(g)                = twoSidedQuantile( floor(100 / (1 + g)) / 100 )
```

| g | band coverage (model) | z_b | break-even survival `1/(1+g)` | R_10 band, published vs model |
|---|---|---|---|---|
| 1 % | 99 % | 2.575829 | 0.990099 | ±0.0064867741 % vs model ✓ |
| 2 % | 98 % | 2.326348 | 0.980392 | ✓ |
| 3 % | 97 % | 2.170090 | 0.970874 | ✓ |
| 4 % | 96 % | 2.053749 | 0.961538 | ✓ |
| 5 % | 95 % | 1.959964 | 0.952381 | ±0.0049358253 % vs model ✓ |

The important subtlety: coverage is `floor(100/(1+g))`, i.e. **the band is set by the grid, not by the exact break-even probability**. The fair width would be `z_b = z(1/(1+g))`, which is *wider* than the grid band at every growth rate — testing confirmed it overshoots the real 5 % band by ~1 %, so `fairBandZ` is explicitly **not** used anywhere in the code. The gap between the grid and the fair value *is* the house tilt:

```
λ_model(g) = coverage(g) · (1 + g)
  1 % → 0.99990    2 % → 0.99996    3 % → 0.99999    4 % → 0.99995    5 % → 0.99750
```

So the structural house edge is **0.01 % at 1 % growth and 0.25 % at 5 %**. Two things follow:

* **Trade 1 %–3 % growth, not 4 %–5 %.** At 5 % you are fighting a 25 bp structural drag per tick; at 1 % it is 1 bp.
* **The payout is not a lottery ticket you can win by paying more.** Break-even needs `p > 1/(1+g)` *and* enough samples to prove it. Any edge must come from the market being **quieter than its own quoted volatility**, not from the product being mispriced on purpose.

### Where the edge can come from at all

The exchange sets the band from the index's **published annualised volatility** (`σ_model`). The bot measures the **realised** per-tick volatility from tick history (`σ_real`). Define

```
k = σ_model / σ_real
p(k, g) = 2·Φ(k · z_b(g)) − 1          (probability of staying inside)
λ = p · (1 + g)                        (EV multiple per tick: 1 tick of compounding)
```

`k > 1` means the market is printing **calmer than its sticker vol**, so a band drawn at the sticker's σ is wider in real-tick units than the model assumes. That is the entire trade: **buy the band when the tape is quieter than the label.** `k < 1` (a jumpy tape: JUMP indices, news, session opens) turns a fair product negative immediately — which is why the σ-route is used as a **veto**, not as a positive signal (§5).

Verified band widths from the model against measured per-tick σ at the real 1 s / 2 s cadence:

| symbol | σ_tick | | symbol | σ_tick |
|---|---|---|---|---|
| R_10 | 2.5183e-05 | | 1HZ10V | 1.7807e-05 |
| R_25 | 6.2958e-05 | | 1HZ25V | 4.4518e-05 |
| R_50 | 1.2592e-04 | | 1HZ50V | 8.9036e-05 |
| R_75 | 1.8887e-04 | | 1HZ75V | 1.3355e-04 |
| R_100 | 2.5183e-04 | | 1HZ100V | 1.7807e-04 |

---

## 3. Survival, and why EV alone is a trap

The knockout process is a **discrete** one: a run of `L` in-band ticks *fails at tick `L+1`*, so the survival curve is `S(1) = p`, `S(n) = p^n`. The empirical curve is estimated by **Kaplan–Meier** over observed run lengths with censored (still-running) windows kept in the risk set — not by dividing counts, which biases the tail exactly where the horizon decision is made. The code implements `kaplanMeierSurvival` accordingly (and the test suite reconstructs an *exact* `p` from a synthetic stream to prove it: `survival[1] = p`).

The EV law is a one-liner: `EV(n) = stake · λ^n`, `λ = p(1+g)`.

**The trap.** For `λ > 1` the EV-maximising horizon is *always* the tick cap, because the payout compounds while survival only decays — so a pure EV maximiser picks "**8 % chance of 31×, 92 % chance of losing everything**". The expectation of that ticket is genuinely positive and it is still an un-runnable bankroll policy: the stake is gone on 92 of every 100 attempts, so the wins never arrive often enough to survive the drawdown, and an accumulator recovery ladder built on it is a ladder into the floor.

`optimalHorizon(curve, minSurvivalLower)` therefore maximises the **conservative (lower-bound) EV subject to a floor on the lower-bound survival**. Each profile states its floor (0.65 / 0.50 / 0.35 for elite / strict / balanced). This is the single most important configuration decision in the bot, and the test suite pins it: a synthetic λ > 1 book provably returns the cap with no floor and the last horizon that still clears the floor when one is given.

---

## 4. Timing: tick caps, and the per-market asymmetry

| g | tick cap used | note |
|---|---|---|
| 1 % | 230 | the documented ceiling |
| 2 % | 141 | |
| 3 % | 117 | |
| 4 % | 98 | |
| 5 % | 60 | measured, not documented |

`ACCU_TICK_CAP_ANCHORS` interpolates **log-linearly** between those anchors and `ACCU_MAX_TICKS_HARD = 230` is a hard clamp. The cap is *calibrated per market* from the exchange's own proposal response whenever one is available (`calibrateTickCap`) — the table is only the prior.

Timing has three further layers, all tick-counted rather than wall-clock:

* **Health detectors.** A rolling 250-tick rate window (`rateWindowZ`), a **CUSUM** on the breach indicator (`reference`/`tolerance`, threshold 5), and a **Wald SPRT** (`H₀: p = p₀`, `H₁: p = p₀ − 0.01`, α = 0.01, β = 0.1) each flags a decaying tape. Sensitivity at `p₀ ≈ 0.98`: a **1-point** shortfall needs ≈1730 ticks to reach 3σ, a **3-point** shortfall ≈190. That asymmetry is the point — the detectors are cheap and quiet, and they scream only when the tape really has changed.
* **Live λ.** Each contract computes its *own* Wilson-bounded λ from ticks survived so far; a lower bound below 1 after warm-up is a flag, not an instant exit.
* **Exit ladder** (`liveExitDecision`): target reached → settle; `λ_live < 1` while the position is still worth ≥ par → **leave at par** (a free option: you keep the accrued compound and hand the knockout risk back); fewer than 5 flags → hold; ≥ 5 flags, or a rotating alternative is certified → **abandon the market and rotate**.

---

## 5. Statistics: what the bot demands before it trades

Nothing is deployed on a point estimate. Every market is measured over ≥ 3000 ticks of history (5000 requested) and must clear a **verdict hierarchy**, in this order:

1. **Break-even.** `p̂ > 1/(1+g)`, one-sided, with a Wilson interval for the lower bound.
2. **σ-route veto.** `zVol < VOL_EDGE_VETO_Z = −3` → refused outright. The σ ratio is *not* an entry signal (a fair 2.5σ band is noisy), but three sigma of evidence that the tape is *jumpier* than the band assumes is decisive.
3. **Edge size** (elite and strict only). `k ≥ profile.kMin` **and** `z ≥ profile.zMin`, so an edge that exists must also be big enough to pay for its own variance.
4. **λ lower bound.** `λ_lo > 1` at the profile's threshold — this is the actual profitability test.
5. **Sample size.** ≥ profile `minTicks` observations; below that the answer is "not yet", never "yes".
6. **EV floor** (engine-side). The conservative EV at the chosen horizon must clear `profile.minEvLower`, and a horizon must exist that clears the survival floor — otherwise a `CERTIFIED` verdict is **downgraded to `QUALIFIED`** with the reason appended.

**Multiple testing.** 19 markets are measured per scan, so a naive 5 % gate manufactures an edge out of nothing. The scan runs **Benjamini–Hochberg** over the one-sided p-values from the break-even z-scores and only certifies **discoveries** at the profile's FDR. Observed in a live scan: 19 hypotheses, BH threshold `1.4e-2`, discoveries `z = 3.20` and `z = 2.19` — a raw `p < 0.05` gate would have certified four or five markets instead of two.

**Markov.** A 4-state absorbing chain (3 magnitude bands + `BREACH` absorbing) is fitted with a 20-observation minimum per state, yielding `markovRunLength` (expected run length), `markovHitProb` (per-state hit probability) and `markovSpreadZ`. This answers a question the marginal `p` cannot: *does the chance of surviving depend on how the last tick ended?* A large `|spreadZ|` says the process is not i.i.d. and the naive `p^n` is not the right survival law — reported as a diagnostic on every candidate.

**Runs and clustering.** `runsTestZ` and `volClusteringZ` test for serial structure in the magnitude stream. Volatility clustering is the norm, not the exception: a `|z| > 2` reading is surfaced on the row rather than being hidden, because it is the main reason a live tape drifts away from its historical estimate.

**Profiles** (`ACCU_CERTAINTY`):

| | elite | **strict (default)** | balanced |
|---|---|---|---|
| `kMin` / `zMin` | 1.03 / 3 | 1.015 / 2 | 1.005 / 1.3 |
| `λ_lo` floor | 1.003 | 1.0015 | >1.0001 |
| min ticks | 1500 | 800 | 400 |
| FDR | 5 % | 10 % | 20 % |
| σ-veto required | yes | no | no |
| min EV lower | 0.05 | 0.02 | 0.005 |
| **min survival lower** | **0.65** | **0.50** | **0.35** |

---

## 6. Recovery, designed for accumulators specifically

A loss is exactly the stake, and the payout path is geometric in ticks. So:

```
horizon to recover a debt D with stake s:   n*(D) = ⌈ ln(1 + D/s) / ln(1 + g) ⌉
value at that horizon:                      (1 + g)^n*
required survival:                          (1 + g)^(−n*)      ← NOT 1/payout
```

**Escalation — doubling the stake — is dominated and is not implemented.** Raising the stake raises the *payout* linearly but the *probability of reaching any given horizon* exponentially (`p^n`), and it leaves the loss-per-failure larger. The code proves this rather than asserting it: `escalationIsDominated` compares a stepped-up ladder against a flat one and the recovery planner refuses the escalated branch.

**Flat-stake ruin is closed-form**: `(1 − p^n)^k` over `k = stopLoss / stake` ladders, implemented in `projectSession` and surfaced to the console as the session's ruin estimate.

The actual rule (`planAccumulatorRecovery`), in order:

1. Compute `n*(D)` and the required survival `(1+g)^{−n*}`.
2. Take it **only if** the measured Kaplan–Meier survival at `n*` clears that bar **and** `n*` fits inside the calibrated tick cap.
3. Otherwise **write the debt down**: the session abandons the market, records the loss honestly, and (in `switching` mode) rotates to a different market.
4. `performanceMultiple = (survived past n*) / (required survival)` is reported per plan so the console shows whether recovery is *earned* or *hoped for*.

Recovery outcomes are recorded against the shared ledger with the realised **total-return multiple** `max(1, (stake + profit)/stake)` (see `recordOutcome(..., "ACCU", …)`), because an accumulator has no fixed payout ratio to hand it.

---

## 7. Execution: the autonomous market switch

The user's requirement — *close the market automatically when conditions do not favour us and open a different market* — is implemented as `marketMode`:

* **`locked`** — one symbol, chosen at start; the loop still measures it every re-scan window and holds fire if it stops certifying.
* **`switching`** (default) — the loop re-scans on a tick schedule (`RESCAN_INTERVAL_TICKS`), ranks candidates by `evLower · 1000 + (λ_lo − 1) · 100` (EV first, edge size as the tiebreak), and rotates when any of these fire:
  * the working market **knocks out** and its fresh verdict is no longer `CERTIFIED`;
  * **≥ 5 health flags** in a live contract (a decaying tape), i.e. the λ the bot is actually getting is below the λ it bought;
  * a **different market certifies with a materially better EV** while the current contract is out of its compounding window;
  * the current market's verdict **decays** on re-measurement (the honest case: the edge was real and has gone).

Every rotation is journalled with `from`, `to`, `at` and `reason`, counted in `rotationCount`, and streamed to the console. "Hold fire" is a first-class outcome and the common one: **19 measured, 0 certified** is a normal scan result and a correct reason not to trade.

The ground-truth barrier is fetched **once per deployment**, not per scan. A scan over 19 markets that requested a live quote for each took **159 s** and produced nothing usable when quotes cannot be served; the model-based scan takes **142 ms**, and the single quote is spent on the market that is about to be traded — where it matters, because the exchange's band is the number the knockout is measured against. If that quote contradicts the model badly enough that the market stops certifying, the bot **holds fire instead of trading a model band**.

---

## 8. The full decision pipeline

```
tick history (5000)  ─┐
exchange proposal     ─┴─► band (model prior, quote as ground truth)
        │
        ├─► p̂ + Wilson CI ──► break-even test ──► Benjamini–Hochberg over 19 markets
        ├─► σ_model / σ_real = k ──► σ-route veto (z < −3)
        ├─► Kaplan–Meier survival S(n)
        ├─► 4-state absorbing Markov chain ──► run length, spread z
        ├─► runs test, volatility clustering
        │
        └─► EV curve  EV(n) = λ^n  ──► optimalHorizon(curve, survival floor)
                                           │
   verdict: CERTIFIED / QUALIFIED / WATCH / REFUSED  ←── EV floor + horizon existence
                                           │
                                   stake · horizon · market
                                           │
        live: rolling window z + CUSUM + SPRT + live λ  ──►  hold / leave at par / rotate
                                           │
                                  settle ──► ledger (ACCU, total-return multiple)
```

---

## 9. Honest limits (what this bot is **not**)

* **The edge is thin and intermittent.** A live 19-market scan at 3 % growth certified **0** markets in one window and **1** (JD50, `k = 1.0194`, `λ_lo = 1.00281`, hold 117) in another. The accumulator is close to fairly priced by construction (`λ_model = 0.9999` at 1 %); the bot's job is to *decline* the trade most of the time. That is why "holds fire" is the default state and why the console reports it plainly.
* **The sandbox has no live feed.** Ticks are simulated (Deriv's public WebSocket is unreachable from here), so all live readings above validate *the pipeline*, not a market edge. The strategy's numbers only become evidence once it runs against the real feed — the same caveat as every other bot in this repo, but it matters more here because the edge is ~10–100 bp, not percent.
* **The 5 % tick cap of 60 is measured, not documented**; it is re-calibrated from the proposal response when available.
* **Above `MAX aggregate open stake`** the exchange will refuse new positions per growth rate. The bot trades one position at a time, so it stays clear, but a multi-session bankroll should keep this in mind.
* **Correlated markets.** The 19 symbols are mostly volatility-index variants; the Benjamini–Hochberg correction treats them as independent tests, which is conservative in the wrong direction when they move together. Ranking by EV is stable; the *count* of certified markets should not be read as that many independent opportunities.

---

## 10. Verification

* `npx tsx --test src/lib/accumulator-analysis.test.ts` → **37 pass / 0 fail** (mulberry32 streams; exact-`p` Kaplan–Meier reconstruction; the survival-floor lottery test; modulated-band σ-veto test; profile-ordering asserts).
* `npx tsc --noEmit` clean for the analysis module, engine, routes and console; `pnpm --filter @workspace/api-server run build` green.
* API probes: `POST /api/bots/accumulator/scan` → 142 ms, 19 scored, BH-corrected verdicts; `POST /api/bots/accumulator/explain`; `POST /api/bots/accumulator/start` → live session with monitor/recovery/rotation payloads; `POST /api/bots/accumulator/stop`.
