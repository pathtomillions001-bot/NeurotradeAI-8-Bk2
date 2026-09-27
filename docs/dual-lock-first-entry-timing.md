# Dual-Lock Range Sentinel — timing the FIRST entry of a generated DBot

**Problem.** The Dual-Lock scan picks the market and the two Over/Under
barriers, and the generated DBot executes that lock non-stop. But *when* the
user presses **Run** is a human event the scan knows nothing about. Pressing
Run inside an adverse excursion — a burst of digits violating the locked range
— loses the very first trade and drags the session into the recovery ladder
before it has earned anything.

**Requirement.** Delay only the *first* entry, never the rest. Be reliable on
every scanned market without per-market tuning. Never wait so long that the
scanned edge goes stale, and never error or stall.

---

## 1. Where it lives

| Piece | File |
|---|---|
| The model (pure) | `artifacts/dbot-builder/src/external/bot-skeleton/services/tradeEngine/trade/dual-lock-entry.js` |
| Runtime hook | `…/trade/Ticks.js` → `ntAnalyseDualLockEntry` / `ntDualLockEntryDecision` |
| Blocks | `…/scratch/blocks/Binary/Tick Analysis/neurotrade_dual_lock_entry.js` |
| XML wiring | `artifacts/api-server/src/lib/dual-lock-dbot.ts` (§3b) |
| Tests | `…/trade/__tests__/dual-lock-entry.spec.js`, `src/preview/__tests__/dual-lock-dbot-strategy.spec.js`, `artifacts/api-server/src/lib/dual-lock-dbot.test.ts` |

Everything runs **inside the bot runtime**. No NeuroTrade server, engine or AI
is in the loop after Deriv's Run button is pressed.

## 2. The model

Let `w[i] = 1` when digit *i* satisfies the locked contract (`d > b` for Over,
`d < b` for Under), over the last 120 digits of the scanned market.

1. **Baseline** — recency-weighted Beta posterior of the marginal hit rate
   (half-life 40 ticks, `Beta(20·p₀, 20·(1−p₀))` prior, `p₀` = the barrier's
   fair rate). Short or noisy tapes shrink back toward fair odds.
2. **Confidence** — a two-state Markov row, hierarchically shrunk toward that
   baseline: `P(next tick is a hit | the state the tape is in right now)`.
   This is what distinguishes a clean tick from one inside a violation cluster.
3. **Cluster guards** — `quietTicks` (ticks since the last violation) and
   `burst` (violations in the last 5 ticks).
4. **Deadline-relaxed threshold** — the bar decays linearly across the patience
   budget *P*:

   ```
   threshold(t) = pHigh − (pHigh − pLow) · t/P
   pHigh = max(baseline, p₀)        pLow = max(0, min(baseline, p₀) − 0.02)
   requiredQuiet(t) = 2 → 1 → 0     allowedBurst(t) = 1 → 2 → 5
   ```

   The bar is expressed in the **tape's own units**, which is why one gate is
   correct for Over 1 (`p₀ = 0.8`) and Under 7 (`p₀ = 0.7`), on any symbol,
   with zero per-market configuration. Because it decays, it cannot deadlock.
5. **Hard deadline** — at `t ≥ P` the gate opens unconditionally, *including*
   when the tick feed is unavailable (the runtime catches and honours the
   deadline). The wait is therefore provably bounded by `P` ticks — default
   **12** (≈ 12–24 s), configurable 3–40 via `entryPatience`.

The gate can only **delay** the start. It never changes the market, the side,
the barrier, the stake or the recovery ladder.

## 3. How the generated XML uses it

```
before_purchase:
  if First Entry Timed:                 ← latched open after the first buy
      purchase(locked contract)
  else:
      Entry Ticks Waited += 1
      nt_analyse_dual_lock_entry(<locked side>, <locked barrier>, 120, 12, Entry Ticks Waited)
      if entry.ready:
          First Entry Timed = true      ← the gate is never consulted again
          notify "Over 2 on Volatility 100 Index — TIMED ENTRY · …"
          purchase(locked contract)
      else if Entry Ticks Waited % 3 == 0:
          notify "Waiting for a clean start — TIMING 3/12 · …"
```

Both branches buy through the **stock `purchase` block**, so the builder's
mandatory-block gate ("The Purchase block is mandatory…") is satisfied exactly
as before.

## 4. Why it cannot error or stall

* The runtime wraps the tape request in `try/catch`; a failure still returns a
  decision object, and honours the deadline.
* `analyseDualLockEntry` clamps every input (`patience → [3, 40]`,
  `barrier → [0, 9]`, unknown contract → `DIGITOVER`, non-digits filtered) and
  divides only by guarded denominators.
* Unit tests assert termination within the budget on 500 random tapes, on an
  empty tape, and on a permanently hostile tape.
* The end-to-end builder spec loads the committed fixture into the **real**
  Deriv Blockly, compiles it the way `dbot.generateCode()` does, and executes
  it: 12 evaluations max, then the locked buy.

## 5. What did NOT change

Every trade after the first — normal or recovery — fires immediately with no
analysis, on the same stake ladder, the same TP/SL and the same circuit
breaker. The builder spec pins this: five trades, exactly **one** timing call.
