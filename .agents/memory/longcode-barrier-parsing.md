---
name: Deriv longcode barrier parsing
description: Why "last digit in the longcode string" is the wrong way to recover a DIGITOVER/DIGITUNDER barrier from Deriv's profit_table, and what pattern to use instead.
---

Deriv's `profit_table` has no structured barrier field for digit contracts — the barrier
has to be parsed out of the longcode sentence, e.g.:

- `"...is strictly higher than 8 after 5 ticks."` (DIGITOVER, barrier 8)
- `"...is strictly lower than 8 after 3 ticks."` (DIGITUNDER, barrier 8)
- `"...is even after 5 ticks."` / `"...is odd after 5 ticks."` (no barrier)

**The bug:** matching "the last digit anywhere in the string" grabs the tick-count digit
from the trailing duration clause, not the barrier — e.g. `"lower than 8 after 3 ticks"`
was read back as barrier **3** instead of the real barrier **8**. This surfaced as the
Journal/Analytics UI showing a different barrier than what the AI actually traded.

**Why:** the longcode always ends with `"after N ticks."`, so a plain last-digit regex is
inherently unreliable whenever barrier ≠ duration digit.

**How to apply:** extract the barrier by matching the specific phrase it appears in
(`strictly higher than (\d)`, `strictly lower than (\d)`, `matches (\d)`, `differs from (\d)`,
`is (\d) after \d+ tick`), never a generic "last digit in the sentence" scan. See
`extractBarrierFromLongcode()` in `api-server/src/routes/trades.ts`.
