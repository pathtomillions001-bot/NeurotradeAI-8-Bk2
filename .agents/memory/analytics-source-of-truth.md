---
name: Analytics vs Journal/Dashboard "today" source of truth
description: Why today's profit/win-rate can differ across pages, and the fix that unified them.
---

NeuroTrade had two independent "today" data sources: the local Postgres `tradesTable`
(paper/simulated + possibly stale rows) and Deriv's real `profit_table` via
`/api/trades/deriv-journal` (calendar-day filtered, the broker's actual settled history).
Journal and Dashboard already used the Deriv source; Analytics' "today" KPIs used the local
DB, so the two could diverge (e.g. $539.94 vs $138.99) even though both were technically
"today, midnight-scoped."

**Why:** the DB and the broker's journal are not the same list of trades — local-DB includes
sim/paper entries and can drift from what actually settled at Deriv.

**How to apply:** any "today" KPI (profit, win rate, streak, best trade) should read from
`/api/trades/deriv-journal` (via `computeJournalStats`) whenever a Deriv token is connected,
falling back to local DB only when there's no token yet (pure paper trading). All-time/historical
views (Analytics drawdown, market-breakdown, agent-scores) intentionally keep using the local DB
and should NOT be switched — only the "today" scoped sections need to agree across pages.
