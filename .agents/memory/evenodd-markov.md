---
name: Even/Odd Markov chain analysis
description: analyzeEvenOdd in deriv.ts uses a Markov chain + streak reversal + chi-square approach, requiring ≥2 signals before recommending.
---

## Rule
The `analyzeEvenOdd()` function in `deriv.ts` uses an intelligent multi-signal approach — **not** naive bias following.

**Why:** Deriv synthetic indices use pseudo-random digit generation. Consecutive same-parity streaks tend to revert, not continue. Naive "follow the bias" recommendations are wrong more than 50% of the time.

**How it works:**
1. **Markov chain** — P(even|prev=even) and P(even|prev=odd) computed over last 100 digits
2. **Streak reversal** — if current streak ≥ 4, recommend the opposite parity
3. **Chi-square** — if bias is statistically significant (p < 0.05) over 100 ticks
4. **Recent 20-tick reversal** — if recent 20 ticks are >65% one side, recommend the other
5. **Consensus rule** — requires ≥2 signals pointing same direction before setting `recommendEven`/`recommendOdd`

**Extra fields returned in EvenOddStats:**
- `markovEvenGivenEven`, `markovEvenGivenOdd` — transition probabilities
- `markovNextEvenProb` — P(next=even) given the last observed digit
- `markovSignal` — "even" | "odd" | "neutral"
- `streakReversalSignal` — "even" | "odd" | "neutral"

**Frontend:** EvenOddPanel reads these fields and shows Markov tables and streak reversal reasoning in the AI Signal text. Window labels are fixed as "Last 20" / "Last 50" / "Last 100" regardless of sample count (fixes old duplicate "Last 50" bug caused by slicing 50 items from a 50-item array).

**Digit buffer size:** The tick handler and heartbeat now call `getDigits(symbol, 100)` (was 50) to populate all three windows correctly.
