# Autonomous Engine — Recovery Pipeline Forensic Audit

**Scope:** the autonomous 1-tick engine (`artifacts/api-server/src/lib/autonomous-hedge/`) — analysis, entry timing, recovery selection, staking and execution — plus the Recovery Quality Pipeline v2 that is currently sitting in `shadow`.

**Question asked:** why does it lose consistently, and what would make recovery entries better?

**Answer in one line:** the engine is not failing to find recovery trades. It is trading a universe with a built-in negative expectation, on signals that are statistically indistinguishable from noise, at a rate of one trade per tick — and the recovery ladder then converts that slow bleed into clustered, account-sized losses. No improvement to *recovery selection* can fix a negative-expectancy entry; the fixes have to move upstream (prove an edge before trading) and downstream (stop compounding losses).

---

## 1. What I ran (everything below is reproducible)

| Artifact | Command | Result |
| :--- | :--- | :--- |
| **Reproduced lab** (`scripts/recovery-lab/index.ts`, 19 markets × 6 seeds × 6,000 ticks × 4 worlds × 3 sets) | `cd scripts && npx tsx ./recovery-lab/index.ts` | Full table in §4.3 — matches `docs/recovery-v2-design.md` §3 exactly |
| **Null-gate probe** (`scripts/recovery-lab/probe-null-gate.ts`, new) | `cd scripts && npx tsx ./recovery-lab/probe-null-gate.ts` | §3 — drives the **production** `buildMarketCandidates` + `decideHedge` + `applySettlement` over provably edge-free tapes |
| **Ranking probe** (`scripts/recovery-lab/probe-rank.ts`, new) | `cd scripts && npx tsx ./recovery-lab/probe-rank.ts` | §4.6 — measures what the v1 recovery terms actually do |

Both probes were added to the repository as audit tooling (analysis only — they import production modules, they are not imported by any production path).

The null-gate probe uses the engine's real decision path on uniform i.i.d. digits and a driftless price walk — i.e. exactly what the engine's own model assumes `p0` to be for every contract (`evidence.ts` `baseProbabilityForSpec`). If the engine had an edge detector, it must report **no edge** there.

---

## 2. The arithmetic of the game the engine is playing

### 2.1 Every contract it can buy is negative expectancy

From `lib/payouts.ts` (the engine's own canonical table), with the true probability of each event on a uniform-digit index:

| Family | True p | Payout | True EV | Win rate needed to break even |
| :--- | ---: | ---: | ---: | ---: |
| Differs | 0.90 | 1.09× | **−1.9 %** | 91.74 % |
| Over/Under 0–1 | 0.90 / 0.80 | 1.09× / 1.23× | −1.9 % / −1.6 % | 91.74 % / 81.30 % |
| Over/Under 2 | 0.70 | 1.40× | −2.0 % | 71.43 % |
| Over/Under 3 | 0.60 | 1.63× | −2.2 % | 61.35 % |
| Over/Under 4 / Even / Odd | 0.50 | 1.95× | **−2.5 %** | **51.28 %** |
| Rise / Fall | 0.50 | 1.92× | −4.0 % | 52.08 % |
| Over/Under 5 | 0.40 | 2.43× | −2.8 % | 41.15 % |
| Over/Under 6 | 0.30 | 3.21× | −3.7 % | 31.15 % |
| Over/Under 7 | 0.20 | 4.72× | −5.6 % | 21.19 % |
| **Matches / Over 8** | 0.10 | 8.93× | **−10.7 %** | **11.20 %** |

The best case available anywhere in the product is a **−1.6 %** expectation. To break even the engine must find a real edge of ≥ 1.6 % *and* be right about it; to make money it needs materially more.

### 2.2 The traded universe cannot contain that edge

`lib/deriv.ts:394` — `AUTOMATED_DERIV_MARKETS` is 20 symbols, all synthetic indices (`R_10`…`RDBEAR`, `JD10`…`JD100`). Nothing else is tradeable by this engine (`cycle.ts` refuses non-automated markets).

Deriv states its synthetic indices are produced by a **cryptographically secure RNG**, broadcast identically to all clients, "blind to your account balance… blind to whether you are long or short", with the tick sequence determined solely by the configured volatility ([Deriv — do brokers manipulate synthetic indices?](https://experts.deriv.com/insights/do-brokers-manipulate-synthetic-indices); [Deriv — synthetic indices](https://deriv.com/markets/derived-indices/synthetic-indices)). The last digit is therefore uniform and independent by construction.

**Conclusion:** within the traded universe the true edge is exactly 0 on every contract, and the house edge is −1.6 % to −10.7 %. Every "edge" the analysis layer reports is by definition a measurement of noise. This is not a hypothesis — §3 measures it.

### 2.3 What that costs per hour

Measured **decision** rate: the analysis layer produces an executable candidate on **100 % of ticks** (§3, NORMAL mode). The realised order rate is then limited by the one-exposure-at-a-time gate and the settlement round-trip (`waitForContractResult` polls the broker for a 1-tick contract), so in practice a trade lands every few seconds rather than every tick. Even with the brakes the code already has:

- base stake `$1 fixed × 0.7 (moderate)` = **$0.70** (`routes/ai.ts:216-218`, `ev-calculator.ts:274`)
- measured realised EV per normal trade: **−14.56 %** (§3), i.e. **≈ −$0.10 per trade**
- daily loss limit **$30** (`routes/ai.ts:225`)

→ the daily loss limit is reached in roughly **300 trades ≈ 5 minutes** of unpaused 1-second trading. That is the "loss after loss" the operator sees, and it is fully explained without any bug at all — merely by the fire rate multiplied by the house edge.

---

## 3. Probe 1 — the decision layer measured on edge-free tapes

3 seeds × 4,000 ticks × 19 markets, production code path (`buildMarketCandidates` → `decideHedge` → `evaluateConfirmation` → `applySettlement`), contract set = Rise, Fall, Over 4, Under 5, Even, Odd, Matches(auto), Differs(auto) — the same set B the v2 lab uses.

### NORMAL mode

| Metric | Measured |
| :--- | :--- |
| Candidate evaluations | 11,817 ticks |
| Candidates passing the hard gate | **40.7 per tick** |
| Ticks with ≥ 1 gate-passing candidate | **100.0 %** |
| **Trades fired** | **11,817 = 100.0 % of ticks** |
| Engine **predicted** EV per trade | **+44.94 %** |
| **Realised** EV per trade | **−14.56 %** |
| Realised win rate | 11.08 % |
| Capital destroyed | **−1,720 stake-units** |

Chosen contracts: **97 % of all trades were auto-digit `DIGITMATCH`** (1,101–1,360 trades per digit), predicted EV **+45 % to +48 %**, realised EV **−5.6 % to −23.8 %**, true win rate 8.5–10.6 %.

### RECOVERY mode

| Metric | Measured |
| :--- | :--- |
| Candidates passing the gate | **69.0 per tick** |
| Trades fired | 4,460 = 37.7 % of ticks |
| Predicted EV | +21.25 % |
| **Realised EV** | **−4.05 %** |
| Miscalibration | > 15 pp |

**Interpretation.** The gate never blocks. With 40–70 candidates qualifying *every* tick, "at least one qualified edge exists" is a certainty, not a signal — the selected candidate's apparent EV is simply the maximum of ~40–70 independent noise draws (an order statistic), which is why a pure-random tape yields a "+45 % edge" that is really −14.6 %.

---

## 4. The findings

Severity: **S1 = account-destroying**, S2 = materially harmful, S3 = design smell / correctness.

### 4.1 S1 — The gate is defeated by multiple comparisons (the root cause)

`contest.ts` evaluates every candidate against a fixed threshold (`normal.minEv = 0`, `lowerBound > breakEven − 0.025`, `n ≥ 30`) with **no correction for how many candidates were searched** (`constants.ts` `HEDGE_LIMITS.normal`). ~19 markets × 6–8 specs ≈ 40–120 candidates per tick, and the engine takes the best one.

What the live gate actually admits, contract by contract, on the 120-tick window it uses (`lowerBound > p_BE − 0.025` is the binding constraint; solved exactly):

| Contract | p0 | p_BE | Posterior mean needed to pass | Apparent edge | Fluke size (σ) | Candidates passing by chance |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| Over 0 / Differs | 0.90 | 0.9174 | 0.9287 | +2.87 pp | 1.22 σ | **11.1 %** |
| Over 2 | 0.70 | 0.7143 | 0.7434 | +4.34 pp | 1.21 σ | **11.3 %** |
| **Even / Odd / Over 4** | 0.50 | 0.5128 | 0.5463 | +4.63 pp | 1.18 σ | **11.8 %** |
| Rise / Fall | 0.50 | 0.5208 | 0.5543 | +5.43 pp | 1.39 σ | 8.2 % |
| Over 5 | 0.40 | 0.4115 | 0.4435 | +4.35 pp | 1.14 σ | 12.8 % |
| Over 6 | 0.30 | 0.3115 | 0.3394 | +3.94 pp | 1.10 σ | 13.6 % |
| Over 7 | 0.20 | 0.2119 | 0.2325 | +3.25 pp | 1.04 σ | 15.0 % |
| **Matches / Over 8** | 0.10 | 0.1120 | 0.1200 | **+2.00 pp** | **0.85 σ** | **19.8 %** |

Two things are wrong here at once:

1. **The gate is a ~1σ filter.** It admits a candidate whose measured edge is a sub-sigma fluke, and it admits 8–20 % of all candidates per tick. With 100+ candidates, "at least one qualified" is a mathematical certainty (§3 measured 100 % of ticks).
2. **The `−0.025` margin is not scale-free**, so the loosest gate in the whole set is the one on the lowest-probability, highest-payout contract: Matches passes at **0.85 σ / +2.00 pp**, and nearly **20 %** of Matches candidates pass by chance. That is the second reason the engine ends up in jackpot contracts.

The correct threshold for a search of this size is a soft-threshold on the z-scale, which the v2 pipeline already computes (`evidence.ts` `universalThreshold`): `M_eff = 19 × 8 × 3 = 456` (×10 for auto-digit ⇒ 4,560), so `λ = √(2 ln M_eff) = 3.499` (non-auto) to `4.105` (auto-digit). The smallest deviation from `p0` that can survive it:

| Window | Threshold λ | Minimum detectable deviation from p0 (coin-flip contract) |
| :--- | ---: | ---: |
| **120 ticks (live today)** | 3.499 | **±15.97 pp** |
| 500 ticks | 3.499 | ±7.82 pp |
| 1,500 ticks (v2 max) | 3.499 | ±4.52 pp |

So the live gate accepts a **+4.6 pp** apparent edge on a 120-tick window where the honest detection floor is **±16.0 pp** — and, worse, it accepts it at a *lower* bar than the v2 estimator needs at 1,500 ticks (±4.5 pp). That mismatch is the mechanism behind every phantom edge in §3.

**Fix direction:** the entry decision must use the shrunk (soft-thresholded) estimate and require a *positive* expected value on it, or it must not fire. This is exactly what v2's M1 already computes and what v2's decision layer discards.

### 4.2 S1 — Auto-digit Matches/Differs are scored in-sample → +45 % phantom EV

`hedge-analysis.ts` `resolveAutoDigit` picks the **most frequent digit in the window** (Matches) or the least frequent (Differs), and `hedgeWinStream` then measures the win rate **on that same window**. Classic in-sample selection: the chosen digit is, by construction, the one that looks best, so its measured hit rate is biased upward by roughly one standard error of the max, which on a 120-tick window with 10 digits is enormous.

Measured: predicted **+45 % to +48 %** EV on `DIGITMATCH` / realised **−10.7 %** (the table value). Because the score maximises EV, these candidates win the tournament essentially always (**97 % of normal-mode trades**, §3) — the engine spends its life buying 8.93× jackpot contracts whose true chance of winning is 10 % and whose house edge is the worst in the product (−10.7 %).

v2's M1 already fixes this with a strict 70/30 out-of-sample split for auto-digit specs (`docs/recovery-v2-design.md` §2.1, `evidence.ts`). **The fix exists in the repository; it is not switched on** (`constants.ts`: `RECOVERY_V2_MODE = "shadow"`, and `cycle.ts:739` applies v2 **only** in RECOVERY mode, so NORMAL entries never touch it).

### 4.3 S1 — v2 fixed the calibration and then removed the gate; it destroys 1.8× more capital

Reproduced lab (identical to `docs/recovery-v2-design.md`). Recomputing **total capital destroyed** = `trades × |realised EV|`, which the acceptance suite never does:

| World | Set | v1 trades | v1 realEV | v1 capital | v2 trades | v2 realEV | v2 capital | v2 / v1 |
| :--- | :-: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| NULL | A | 14,345 | −0.86 % | −123 | 34,777 | −2.50 % | −869 | **7.0×** |
| NULL | B | 13,414 | −3.26 % | −437 | 34,919 | −2.28 % | −796 | **1.8×** |
| NULL | C | 13,556 | −5.89 % | −798 | 34,685 | −2.15 % | −746 | 0.9× |
| REGIME | A | 14,367 | −1.48 % | −213 | 34,777 | −2.78 % | −967 | **4.5×** |
| REGIME | B | 13,424 | −3.87 % | −520 | 34,885 | −1.63 % | −569 | 1.1× |
| REGIME | C | 13,576 | −4.80 % | −652 | 34,677 | −2.19 % | −759 | 1.2× |
| **NULL+REGIME total** | | | | **−2,743** | | | **−4,706** | **1.7×** |
| PLANTED | A+B+C | 41,545 | −0.15/−4.27/−3.76 % | **−1,111** | 104,849 | +5.11/+5.12/+5.10 % | **+5,358** | turn-around |

Three things to take from this table:

1. **v2 is superbly calibrated** — `|pred − real| = 0.15 pp` vs v1's 24.3 pp. That work is real and should be kept.
2. **v2 still loses** wherever no edge exists, and it loses *more in total* than v1 because it fires 2.4–2.6× as many trades. Optimising *quality per trade* while ignoring *quantity* is what makes it worse in money: −4,706 vs −2,743 stake-units.
3. **v2 is the only version that can capture a real edge.** When an edge is actually planted it earns **+5.1 % per trade, +5,358 units**, while v1 *loses* money (−1,111) even in that world because its noise-fitted gates keep it on the wrong markets (planted-market share after tick 2000: v1 7.3 %, v2 79.3 %).

`score-v2.ts` `isRecoveryStakeEligible` confirms the cause: the only eligibility test is *"is the stake valid under the limits"*. There is **no EV requirement at all** — every ranked candidate is tradeable, so the engine always fires the least-bad one.

And the acceptance suite in `docs/recovery-v2-design.md` §3 cannot catch this: **A5 is a per-trade EV criterion** ("v2 ≥ v1 − 1.0 pp"), so it passed (+0.98 pp) while total losses grew 1.7×. Any future acceptance test must be denominated in **capital per 1,000 ticks**, not EV per trade.

### 4.4 S1 — The recovery ladder converts the bleed into account-sized losses

- `recovery-engine.ts:367` `getDynamicRecoveryStake` → `computeDynamicStake` → `calculateRecoveryStakeRequest` + `applyRecoveryStakeLimits` (`recovery-math.ts`).
- Instant mode sizes the stake to clear **all debt + target in one win**: `stake = (debt + target)/(payout − 1)`.
- Split mode caps each attempt at the base stake and carries the debt forward.

Both are martingale-shaped: the stake is an increasing function of accumulated losses. The repository already contains the counter-argument, written for the other engine, in `multiasset/risk.ts`:

> "THE LOSS POLICY IS DE-ESCALATION, NOT MARTINGALE. Increasing stake after a loss converts a long series of small wins into one total loss. At a 55 % win rate a 7-loss streak arrives roughly every 1,200 trades… Worse, a losing streak is usually evidence that the regime has changed — which is precisely the moment size must come down, not up."

The autonomous engine does the opposite of its own desk's doctrine. The lab's own episode statistics quantify the tail (per-episode P&L in base-stake units, mean / worst-5 %):

| World | Set | Ver | Instant (mean / ES5) | Split (mean / ES5) |
| :--- | :-: | :--- | ---: | ---: |
| NULL | A | v2 | −0.95 / **−79.0** | −0.42 / −13.3 |
| NULL | A | v1 | −0.32 / −56.2 | −0.14 / −11.8 |
| NULL | B | v1 | −0.96 / −69.9 | −0.46 / −14.9 |
| PLANTED | A | v2 | +0.74 / −23.5 | +0.59 / −10.1 |
| REGIME | A | v2 | −1.05 / −79.9 | −0.47 / −13.4 |

**A 1-in-20 recovery episode costs 79× the base stake.** With a $0.70 base stake that is ≈ $55 per tail episode, against a $30 daily loss limit. And note this is with a *real* edge planted (PLANTED: −23.5 ES5) — the ladder's tail is structural, not a symptom of the missing edge.

Additionally, `ladder-outcomes.ts` (the simulator that feeds v2's `J(c)`) **breaks the episode at the first win that clears debt** (`if (settled.recoveryComplete) break;`) and never models an episode that exhausts the balance into permanent debt — so the quantity v2 optimises is the cost of the *successful* episodes, with the failures only visible through the `es5`/`pStop` penalties.

### 4.5 S1 — Paper mode is self-fulfilling: it cannot detect any of the above

`cycle.ts:1204`:

```ts
if (ctx.paperTradeMode || !ctx.token) {
  const won = Math.random() < b.probability;      // b.probability = the engine's OWN belief
```

The outcome is drawn from the engine's posterior, not from the tape. Under paper mode the engine wins exactly as often as it *believes* it wins — so a phantom "+45 % EV" produces a beautiful paper P&L, and every improvement validated in paper mode is validated against the engine's own assumptions. **This invalidates the entire development loop that produced both v1's tuning and v2's acceptance evidence.** Paper mode must resolve outcomes from the real recorded ticks (the machinery already exists: `shadow-ledger.ts` `resolveOneTickOutcome`).

### 4.6 S2 — The v1 "risk-aware recovery score" barely re-ranks anything

`hedge-analysis.ts` computes `S_R = S_0 + 18w(P(edge) − 0.5) − 18w·R_3L − 8√Var(p)`. Probe 2 measured its actual effect on the engine's own candidate lists (90 candidates/tick, RECOVERY mode, escalation 2):

| Metric | Measured |
| :--- | :--- |
| Spearman correlation `S_0` vs `S_R` | **0.9595** |
| Top-1 pick unchanged by the three terms | **82.0 %** of ticks |
| mean \|S_0\| | 6.62 |
| mean \|S_R − S_0\| | 6.82 |

The terms are not small — they are **nearly constant across candidates**, so they shift every candidate by roughly the same amount and leave the ordering alone. 82 % of the time the "risk-aware" winner is the same candidate the plain EV score would have chosen.

Worse, `R_3L` is degenerate. `threeLossRunRisk({afterLossWin, lossToLoss})` returns `(1 − q_L→W)·q²_L→L`, but in `hedge-analysis.ts` both factors come from the *same* 2×2 transition counts, where `q_L→L ≡ 1 − q_L→W`. So `R_3L ≡ (1 − q)³`, a monotone re-encoding of the unconditional loss rate — it carries **no independent information about loss clustering**. Measured against `(1−q)³` on independent tapes: `0.3356 vs 0.3333` (p=0.3), `0.1266 vs 0.1262` (p=0.5), `0.0320 vs 0.0324` (p=0.7), `0.0066 vs 0.0075` (p=0.9). It duplicates the EV term instead of adding a cluster signal.

So the whole "recovery intelligence" layer (`recovery-risk.ts`, the κ/E escalation weight, the posterior edge probability, R3L) is, in practice, a near-constant offset on top of a noise-fitted score. The escalation weight `w ∈ [1.0, 1.5]` scales terms that are already almost constant — it cannot rescue the ranking.

### 4.7 S2 — Recovery confirmation adds latency, not information

`hedge-state.ts` requires the same best key on **2 distinct fresh ticks, or 3 once lossRun ≥ 3** (`HEDGE_LIMITS.recoveryConfirmations`). On 1-second markets that is 2–3 seconds of delay before the order is placed, applied to a statistic that §2.2 shows has no persistence to confirm: the candidate is "best" because it drew the largest noise value this tick, and requiring the same market/contract to repeat that draw is a filter on randomness, not a confirmation of an edge. Its one real effect is mechanical and accidental — it roughly halves the trade count (NULL B: 13,414 trades for v1 vs 34,919 for v2), which is the only reason v1 bleeds more slowly than v2 in the NULL world. The lab's own A1 metric (loss runs ≥ 10 per 1,000 trades) is 0.60 for v1 and 0.37 for v2 against a target of ≤ 0.80 — passing, but note that both are far above what a gated engine that simply does not trade would achieve.

### 4.8 S2 — The rematch rule is a churn generator

`applySettlement` arms `rematchPenalty = 8 + 2·(lossRun − 1)` on the exact losing tuple, decaying by 0.8 per fresh tick (`hedge-state.ts`, `applyRematch`). Since typical score gaps are ~6.6 units, an 8–16 unit penalty dominates: after **every** loss the engine is forced off the exact market/contract it just traded and onto a different one. In an edge-free universe that is pure rotation — it multiplies the number of distinct (market, contract) pairs sampled (raising multiplicity further) while contributing no edge. Its stated purpose ("don't immediately rematch the loser") is only meaningful if the tape has persistence, which §2.2 rules out.

### 4.9 S2 — The ladder's inputs are assumptions that are never reconciled

- The stake is sized from the **quoted** payout and the engine's **own** win probability (`cycle.ts:1046-1058`), i.e. from exactly the two things §3 shows to be unreliable.
- The ledger records the *pre-trade* quote via `ledgerEntryPayout(payout, …)` (`ledger.ts:77`, `cycle.ts:1382`) — deliberate, and documented ("a loss must carry the same multiplier as a win"), but it means the debt book is denominated in the engine's assumptions. Nothing ever compares the *realised* payout of settled contracts against the quote that sized the stake, so a systematically optimistic quote silently under-recovers forever.
- There is no reconciliation of "debt cleared" against the account's realised equity; the engine trusts its own ledger.

### 4.10 S3 — The stops are a metronome, not a brake

`routes/ai.ts:605`: `cooldownMinutes: settings?.cooldownMinutes ?? 30`; `routes/ai.ts:431-451` schedules an automatic resume after the cooldown. `cycle.ts:1449-1457`: three consecutive losses stop the engine; with the cooldown enabled it restarts itself 30 minutes later — **with the debt, the recovery step and the escalation intact** (`recoveryEscalation` deliberately uses `max(streakLossCount, recoveryStep)` so the ladder does not reset). The operator therefore sees an endless sequence of "3 losses → pause → 3 losses", and the only real terminal brake is the daily loss limit.

---

## 5. Why "better recovery selection" cannot be the fix

Let the engine hold belief `p̂` about a contract with payout `P`. Its per-trade expectation is `p_true·P − 1`, which is fixed by the product's pricing and does not depend on `p̂`, on ranking, on timing, or on staking. Staking changes only the *distribution* of outcomes, not its mean.

**The ladder's expected debt drift is strictly upward on every contract in the menu.** With Instant staking the stake is `debt/(P − 1)`, so a loss sets `debt ← debt·P/(P − 1)`. Weighting that growth by the probability `(1 − p_true)` of needing another attempt gives the expected multiplier per rung:

```
M = (1 − p_true)·P/(P − 1) = 1 + (1 − p_true·P)/(P − 1) = 1 + houseEdge/(P − 1)
```

Since `p_true·P < 1` on every contract (§2.1), `M > 1` **always** — verified for the whole table:

| Contract | EV | `M = 1 + houseEdge/(P−1)` | Consequence |
| :--- | ---: | ---: | :--- |
| Differs / Over 0 | −1.9 % | 1.211 | expected debt grows 21 % per rung |
| Over 1 | −1.6 % | 1.070 | grows 7.0 % per rung |
| Over 3 | −2.2 % | 1.035 | grows 3.5 % per rung |
| **Even / Odd (/ Over 4)** | **−2.5 %** | **1.026** | grows 2.6 % per rung |
| Rise / Fall | −4.0 % | 1.044 | grows 4.4 % per rung |
| Over 5 | −2.8 % | 1.020 | grows 2.0 % per rung |
| **Matches / Over 8** | **−10.7 %** | **1.0135** | grows 1.4 % per rung — *the slowest* |

This table contains the most counter-intuitive finding of the audit: **the ladder's ruin-drift is smallest on the highest-house-edge contract.** Because a bigger payout needs a smaller stake to erase a given debt, `M` is minimised exactly where the pricing is worst — Matches at −10.7 % drifts more slowly per rung than Differs at −1.9 %. The ladder therefore does not merely fail to repair a negative edge: **its cost metric actively points at the worst-priced instruments in the menu**, buying a slightly slower bleed at the price of a far more brutal path (10 % win rate instead of 90 %, ES5 −79 base stakes instead of −56).

Two things keep this from being the whole story, and both are worth knowing:

- v2's `J(c)` does **not** collapse into Matches, because the `4·pStop` term penalises exactly the contracts that lose most often. That is visible in the lab: v2's realised win rate stays at ~50 % across every world and set (NULL 50.04 %, PLANTED 53.9 %, NULL-B 50.10 %), whereas an all-Matches book would show ~10 %. The stop penalty is doing real work — it is the one part of v2's objective that resists the payout-metric trap.
- v1 **is** biased toward Matches, but through the *analysis* rather than the staking: §3 measured **97 % of normal-mode entries on auto-digit `DIGITMATCH`** on an edge-free tape, because in-sample digit selection (§4.2) manufactures a +45 % phantom EV that no other candidate can beat.

So the two halves of the engine pull in the same bad direction for different reasons: v1's analysis seeks out the jackpot contract that looks best in-sample, and the ladder's economics reward exactly that choice.

With **Split** staking the same identity holds with a slower growth rate (`stake = min(debt/(P−1), base)`), so the direction is unchanged and only the speed differs.

Therefore:

1. **Any change whose success criterion is "picks better recovery trades" is unfalsifiable in this universe.** Better picks of a negative-expectancy menu remain negative-expectancy.
2. **The only fix that can change the sign of the outcome is refusing to trade when no edge is demonstrated** — which requires moving the gate from *rank* to *admissible*, and requires the estimator to be honest (soft-thresholded, out-of-sample).
3. **The second lever is variance.** Even with a genuine edge, the current ladder's worst-5 % episode is 79 base stakes, which is what turns "unlucky hour" into "blown account".

---

## 6. Solutions considered, scored

Each option is scored on: expected effect on P&L, implementation cost, and risk of harm.

| # | Option | Mechanism | Effect | Cost | Risk |
| :-: | :--- | :--- | :--- | :--- | :--- |
| **B1** | **Stop live trading; keep the instrument on** | Paper-only + shadow, keep recording `edgeReport()`/CUSUM | Stops the bleed immediately; keeps collecting the evidence needed to prove or disprove any edge | ~0 (a settings change) | None — the engine currently has no demonstrable edge to protect |
| **B2** | **Positive-EV gate on the calibrated estimate** | Fire only if `p̃·P − 1 ≥ margin(n)` using M1's shrunk `p̃`; otherwise HOLD | The single change that makes "no edge" produce "no trade" instead of "trade anyway". Kills the 100 % fire rate in NULL/REGIME; preserves the PLANTED/MARKOV capture | Medium (wire M1 into the decision for NORMAL and RECOVERY) | Low — it can only remove trades |
| **B3** | **Live-edge certification (CUSUM + Brier skill)** | Require the account's own realised outcomes to clear an e-process/CUSUM against "E[R] ≤ 0" before any live order; auto-halt on alarm | Converts M7's existing evidence machinery from *shrinking beliefs* into *stopping trading*. Borrows the desk's proven design (`multiasset/governance.ts`, `E_HALVE=5`, `E_DISABLE=20`) | Medium | Low |
| **B4** | **Replace the recovery ladder with de-escalation** | After k consecutive losses: reduce stake (1.0/1.0/0.75/0.5/0.35), raise the entry bar, suspend the symbol; never size up to recover | Removes the tail that turns a bad hour into a bad month. Matches the desk's `LOSS_LADDER` doctrine | Medium (stake path + UI copy + settings semantics) | Medium — changes product behaviour users configured; needs a migration/default |
| **B5** | **Honest paper mode** | Resolve paper outcomes from the real recorded ticks (`shadow-ledger.resolveOneTickOutcome`) instead of `Math.random() < b.probability` | Makes every future experiment meaningful. Without this, no validation of B2/B4 can be trusted | Low | Very low |
| **B6** | **Fix the analysis layer** | Always-on 70/30 out-of-sample digit selection; soft-threshold every gate; delete `R_3L` or rebuild it on a real clustering test (runs test / Markov likelihood-ratio with its own counts); drop the near-constant `−8√Var` term | Removes the +45 % phantom EV on Matches; makes the reported confidence mean something | Medium | Low |
| **B7** | **Capital-denominated acceptance tests** | Replace "EV per trade" criteria with "capital destroyed per 1,000 ticks", "max drawdown", "tail episode cost" in the lab harness | Makes the v2 regression (§4.3) impossible to ship again | Low | Low |
| **B8** | **Execution truth-tracking** | Record quoted vs realised payout per settled contract; reconcile `debt cleared` against account equity; log decision→buy latency and tick slippage | Turns the ladder from an open-loop assumption into a closed loop; exposes quote staleness and latency costs | Low–Medium | Low |
| **B9** | Better analysis models (HMM/change-point/meta-ensemble, i.e. more of the desk's machinery) | More sophisticated inference on the same tape | **No effect on a CSPRNG tape.** The desk's alpha machinery exists because MT5 instruments are real markets with genuine microstructure | High | High (more complexity, more overfitting surface) |
| **B10** | Trade real instruments instead (the desk / MT5 path) | Move capital to markets where an edge can exist | The only path to a genuinely positive-expectancy autonomous strategy | High (new instrument universe, venue, risk model) | Medium |

### The best combination (recommended)

**Phase 0 — today, stop the bleeding (B1).** Live autonomous trading off; paper + shadow on with honest outcomes (B5) so evidence accumulates instead of money leaving.

**Phase 1 — make "no edge" mean "no trade" (B2 + B6 + B7).** Wire M1's soft-thresholded, out-of-sample estimate into *both* modes and require a positive expected value with a margin that scales with the window (`p̃·P − 1 ≥ m(n)`, `m(120)` large, `m(1500)` small). Keep v2's estimator — it is the best code in this area and it demonstrably captures a planted edge. Add the capital-denominated acceptance metrics so the change is provable, not asserted. Expected result, mechanically: on NULL/REGIME the engine fires ~0 trades (no bleed); on PLANTED/MARKOV it keeps the +5 %/trade capture. **I can run this in the lab before touching production**, and report the four numbers that matter: trades fired, capital destroyed (NULL/REGIME), capital earned (PLANTED/MARKOV), tail episode cost.

**Phase 2 — make the survival profile sane (B4 + B3).** Once entries are gated, replace compounding recovery with de-escalation, and let the account's own realised outcomes (CUSUM/e-process) be the thing that authorises live orders. Keep the ledger, drop the ladder.

**Deliberately not recommended:** B9 (more inference on a CSPRNG tape is spending effort on a proven-absent signal) and any further tuning of the recovery *ranking* (§5). If the goal is profit rather than engineering, the honest path is B10 — an instrument universe where edge can exist — with this engine's calibration work reused there.

---

## 7. What I need before implementing

The report is a proposal; no production code has been changed. Two facts determine which fixes matter most:

1. **Are Matches / Differs in your contract sets** (either NORMAL or RECOVERY)? If yes, §4.2 is the single largest source of phantom EV in your P&L today and the fix is small. If no, the loss mechanism is purely multiplicity (§4.1) and the ladder (§4.4).
2. **Which scope do you want me to implement?**
   - **(A)** Phase 0 only — flip the safety switches, honest paper mode, capital-denominated metrics. Small, reversible.
   - **(B)** Phase 0 + Phase 1 — the gate, the analysis fixes, and a lab run proving the effect on all four worlds before any live change. *This is my recommendation.*
   - **(C)** Phase 0 + 1 + 2 — the full redesign including de-escalation staking and live-edge certification.

I would also like your explicit acknowledgement of the uncomfortable finding: on Deriv synthetic indices there is no edge to find, so a correctly-working version of this engine will mostly **refuse to trade**. If the expectation is that it should trade frequently *and* profitably on these markets, that expectation is the thing that needs to change — not the code.

---

## Appendix A — Symbols in the money path

The core equations the audit refers to:

```
Break-even probability            p_BE = 1 / P
True EV per trade                 EV   = p_true · P − 1
Engine's (v1) gate                n ≥ 30, EV(p̄) > 0, LCB > p_BE − 0.025, instability < 0.16, clustering < 1.45
Engine's (v1) recovery score      S_R  = S_0 + 18w(P(edge) − 0.5) − 18w·R_3L − 8√Var(p)
Three-loss indicator              R_3L = (1 − q_L→W)·q²_L→L   ≡ (1 − q)³      [§4.6]
Universal soft threshold          λ    = √(2 ln M_eff),  M_eff = markets·specs·3·(10 if auto-digit)
Shrunk evidence (v2)              p̃    = p0 + soft(z, λ)·√(p0(1−p0)/n_eff)
v2 episode cost                   J(c) = −meanPnl/base + 0.25·max(0,−es5)/base + 4·pStop
v2 eligibility (today)            "stake is valid"  — no EV constraint      [§4.3]
Instant recovery stake            stake = (debt + target)/(P − 1)
Split recovery stake              stake = min((debt + target)/(P − 1), base)
Debt growth per loss              debt ← debt · P/(P − 1)
Expected debt multiplier per rung M    = 1 + houseEdge/(P − 1) > 1 always   [§5]
```

## Appendix B — Evidence index

| Claim | Evidence |
| :--- | :--- |
| Traded universe is synthetic-only | `lib/deriv.ts:357-401`; Deriv's own CSPRNG statement (link in §2.2) |
| House edges / break-even rates | `lib/payouts.ts` |
| Gate has no multiplicity control | `constants.ts` `HEDGE_LIMITS.normal`; `contest.ts` `decideHedge` |
| Gate admits ~1σ flukes: 8–20 % of candidates pass per tick; loosest on Matches (+2.00 pp, 0.85 σ, 19.8 %) | §4.1 exact solution of the `lowerBound` test against `hedge-analysis.ts` |
| Honest detection floor is ±15.97 pp at 120 ticks vs the ±4.63 pp the gate accepts | §4.1, `evidence.ts` `universalThreshold` |
| 40–70 gate-passing candidates every tick; 100 % fire rate | null-gate probe, §3 |
| Auto-digit scored in-sample | `hedge-analysis.ts` `resolveAutoDigit` + `hedgeWinStream`; probe §3 |
| v2 eligibility has no EV gate | `score-v2.ts` `isRecoveryStakeEligible` |
| v2 loses 1.7× more capital despite 0.15 pp calibration | lab table §4.3; `docs/recovery-v2-design.md` §3 |
| v2 fires 2.4–2.6× more trades | lab table §4.3 |
| Acceptance criterion A5 is per-trade and cannot catch it | `docs/recovery-v2-design.md` §3 |
| v2 is shadow-only, RECOVERY-only | `constants.ts` `RECOVERY_V2_MODE`; `cycle.ts:739-741`, `896-906` |
| Recovery terms re-rank almost nothing (0.96 Spearman, 82 % same pick) | rank probe §4.6 |
| `R_3L ≡ (1−q)³` | rank probe §4.6 |
| Ladder tail = −79 base stakes (worst 5 % of episodes) | lab `Inst(μ/ES5)` columns |
| Expected debt drift `M = 1 + houseEdge/(P−1) > 1` on all 10 families; drift is *smallest* on the worst-priced contract (−10.7 % Matches: 1.0135 vs −1.9 % Differs: 1.211) | §5, exact identity |
| v2 does not collapse into Matches (win rate stays ~50 % in every world) — its `4·pStop` term is what resists the payout trap | lab win-rate columns, §5 |
| Episode simulator breaks at the clearing win | `ladder-outcomes.ts` `runSimulation` |
| Paper mode samples from the engine's own belief | `cycle.ts:1204` |
| Rematch penalty dominates the score scale | `hedge-state.ts` `applySettlement`; `constants.ts` `rematchPenalty` |
| Stops auto-resume after 30 min with the ladder intact | `routes/ai.ts:431-451`, `605`; `cycle.ts:1449-1457`; `recovery-risk.ts` `recoveryEscalation` |
| Desk doctrine contradicts the ladder ("de-escalation, not martingale") | `multiasset/risk.ts` header + `LOSS_LADDER`; `multiasset/governance.ts` e-process |
| Defaults ($0.70 base, $30 daily limit, 3-loss stop, split, 3 steps, $500 cap) | `routes/ai.ts:215-243`, `ev-calculator.ts:274-293` |
