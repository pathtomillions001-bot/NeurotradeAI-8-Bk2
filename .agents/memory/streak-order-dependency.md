---
name: Streak calc needs newest-first input
description: Why a "current streak" calculator silently breaks when fed trades in the wrong sort order, even though the function itself is correct.
---

`computeStatsCore()`'s consecutive win/loss streak loop assumes `trades[0]` is the
*most recent* trade — it walks forward accumulating +1/-1 until the streak breaks.
That assumption is correct only if the input is sorted newest-first.

**The bug:** `computeJournalStats()` built its "today" trade list sorted
oldest→newest (ascending, for chart/timeline consumers) and then passed that same
ascending list straight into `computeStatsCore()` for the streak/longest-streak
calculation. The function silently produced a real number — just the streak of
the *earliest* run of the day instead of the *latest* one (e.g. showing a 2-loss
streak from hours ago while the actual last two trades were both wins). No
exception, no visible failure — just a wrong-but-plausible value that only showed
up as a cross-page mismatch against a consumer (Analytics) that happened to
compute its own streak from a correctly-ordered list.

**Why:** sort order is an implicit contract between a data-prep step and the
function consuming it; nothing in the type system enforces it, so a shared "today
list, ascending" can be reused for a purpose that needs the opposite order without
any error surfacing.

**How to apply:** whenever a list is sorted for one purpose (chronological display)
and also needs to feed a second computation with an ordering assumption (streak,
"most recent N", etc.), pass an explicit reordered copy (`[...list].reverse()`) into
that second computation — never assume a shared list is already in the right order
for every consumer. When two pages show different values for what should be the
same metric, check whether they're deriving it from the same computation with
different input order before assuming the logic itself differs.
