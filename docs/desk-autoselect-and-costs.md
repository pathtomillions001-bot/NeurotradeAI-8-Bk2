# Multi-Asset Desk — mode bands, asset-class costs, automatic best-market selection

This change set answers five reported problems with the Desk. Each one is a
behaviour change, so each one states what was wrong, what it does now, and which
file owns the decision.

---

## 1. The modes monitor exactly the band they are supposed to

**Reported:** *"When the user enables scalp, the system monitors only the
3-minute timeframe and below, all the way to 10 seconds if possible; intraday
looks between 5 and 30 minutes; swing looks from 1 hour to the weekly. Fix
this."*

| Mode | Band (new) | Was |
|---|---|---|
| Scalp | **S10, S30**, M1, M2, M3 | M1, M2, M3 |
| Day | M5, M15, M30 | M5, M15, M30 |
| Swing | H1, H4, D1, W1 | H1, H4, D1, W1 |

Two things changed:

1. **`S10` / `S30` exist.** MetaTrader's fastest period is M1, so a ten-second
   frame cannot come from `CopyRates`. It does not have to: the EA already sends
   a tick for **every selected symbol on every heartbeat** (0.5–1 s), which is
   ten to twenty samples inside a ten-second window. `subminute.ts` builds those
   bars on the server and withholds them until the recent bars are dense enough
   to be honest (`MIN_SAMPLES_PER_BAR = 2`, `DENSITY_WINDOW = 20`). A terminal
   heartbeating every 30 s produces **no** S10/S30 frames at all and the band
   falls back to M1–M3, rather than inventing a "ten-second candle" out of one
   tick.

2. **The bands are now exclusive.** Previously each mode scored its own band but
   *measured* the frames outside it as "context" and deducted up to 12 points
   when a slower frame leaned the other way (`CONTEXT_PENALTY_PER_FRAME = 5`,
   cap 12). Two problems: a scalp was effectively its own band minus an opinion
   about the hourly candle it was never supposed to have, and for **swing** the
   context frame was W1 — which is already inside the swing band, so the weekly
   candle was scored *and* penalised. `MODE_CONTEXT_TIMEFRAMES` is now empty for
   every mode; nothing outside a band is scored, required or penalised.

Owned by: `types.ts` (`Timeframe`, `MODE_ANALYSIS_TIMEFRAMES`),
`subminute.ts`, `confluence.ts` (`MODE_WEIGHTS`, `MODE_CONTEXT_TIMEFRAMES`).

### A data gap is a data gap, not a bad market

`scoreConfluence` used to return **score 0** when no frame in the band had 30+
bars — which is what produced this on the desk:

```
Quality 31.8 is below the 62.0 required for a scalp entry (confluence 0.0, evidence 57.9)
```

Confluence 0.0 did not mean "the market is bad". It meant the terminal had not
seeded the scalp frames on that symbol yet, while M5/M15 had data. The score is
now computed from the **nearest available frames** with the substitution named
in `warnings` and flagged as `substituted` on the result, and the frames that
were missing are listed individually.

---

## 2. Costs are judged against the symbol's own asset class

**Reported:** *"We keep getting this as the reason the trade was not executed:
'Spread 21 pts is 36% of the 58-pt stop (limit 25%)'. Is the system aware that
crypto spreads and forex spreads cannot be computed the same — or remove the
spread filter entirely?"*

It was not. There was one global constant (`maxSpreadFractionOfStop = 0.25`) for
every instrument on the planet, plus a second spread gate in the agent that
compared the live spread against `spec.spreadPoints * 2` — and `spec.spreadPoints`
**is** the live spread, so that gate could never fire. Dead code that looked like
a safety check.

Now (`asset-costs.ts`):

| Asset class | spread ÷ stop | (spread + commission) ÷ risk | fill-time spread ÷ stop | slippage × |
|---|---|---|---|---|
| forex | 35% | 35% | 40% | 1 |
| metals | 40% | 40% | 45% | 1.5 |
| indices | 50% | 45% | 55% | 2 |
| commodities | 50% | 45% | 55% | 2 |
| futures | 45% | 45% | 50% | 2 |
| crypto | 60% | 55% | 65% | 3 |
| stocks | 60% | 55% | 65% | 3 |

Both numbers are ratios, so "points" — which mean something different on every
instrument — never enter the decision. The reach of the change:

- The **live quote's** spread is used for cost, not the spec's cached copy
  (they agree in the live Desk because the heartbeat refreshes the spec, but the
  fill pays the quote).
- The spread is charged in the Monte-Carlo cost term, so the expectancy gate
  (`minEdgeR = 0.15R`) is net of it — that is the gate that decides.
- Sizing refuses at the asset class's ceilings, and names them:
  `Spread 40 pts is 40% of the 100-pt stop — above the 35% ceiling for forex.`
- A spread that is wide *for its class but still allowed* is surfaced as a
  caution on the plan (`wide for forex (ceiling 35%) … charged in the
  expectancy above rather than blocking the trade on its own`).
- The EA's fill-time guard (`plan.maxSpreadPoints`) is stop-relative and
  class-aware, not an absolute point count.

---

## 3. The stop is on the correct side of entry — always

**Reported:** *"Stop loss 31163.55 is on the wrong side of entry 31151.36 for a
buy."*

A genuine bug, and it wasted the whole analysis window. `structuralStop` places
the stop beyond the last confirmed swing, then validated the candidate with
`|entry − candidate|` — **distance only, never side**. After a breakdown the
most recent confirmed swing *low* sits **above** the live price, so for a buy the
candidate `swingLow − buffer` could still be above the entry. It passed the
distance test, the plan was built, and sizing refused it with "wrong side of
entry" — a correct refusal of a plan that should never have been constructed.

The guard now checks the signed distance (`signed > 0` means genuinely beyond the
entry) and falls back to the pure ATR stop, which is correct by construction.
Covered by tests for the breakdown case in both directions, plus a property test
that no evaluated plan ever carries a stop on the wrong side of its own trigger.

---

## 4. The desk finds the best market by itself

**Reported:** *"In every mode the system should look for the best market based on
what the user has selected and execute the best of them if it passes the
analysis, and manage it as well."*

Until now `autoTrade` only set a flag on the heartbeat: with it off the EA
refused every plan (including hand-armed ones, silently — see §6), and with it on
the system still did nothing by itself. There was no engine that chose a market.

`auto-select.ts` is that engine. On the terminal's heartbeat, while auto-trade is
on, it:

1. takes the user's **selected** markets (the watchlist is the universe),
2. skips any market that already has an open position or an armed plan,
3. evaluates the rest through the **same** `evaluate()` the manual path uses —
   same risk governor, same news gate, same quality/evidence gates, same cost
   policy, same sizing,
4. ranks the ones that pass by **expectancy after costs** (the number the gate
   enforces), then quality,
5. arms exactly one: the best. The EA then watches the trigger locally, opens
   the position and manages it from the plan's `management` block — break-even
   with a structure buffer, two partial exits, the ATR chandelier trail, the
   time stop — exactly as for a hand-armed plan.

Cadence is per mode: scalp 15 s, day 30 s, swing 60 s. It is **not** a trade
count: the binding limits stay risk-based (open positions, per-symbol cap,
correlated exposure, daily loss, loss-streak de-escalation). A pass evaluates a
bounded window of the watchlist and rotates it, so a 200-symbol selection is
swept over several passes instead of blocking a heartbeat.

Everything it does is reported:

- `/api/desk/state` → `autoSelect.last` (scanned / qualified / chosen / ranked)
  and the cadence; the scanner pane renders it.
- `POST /api/desk/auto-select` runs one pass immediately.
- When nothing qualifies it names the **closest miss** and its rejection, in the
  journal and on screen. "Why is it not trading?" is answered on the desk rather
  than guessed at.

---

## 5. The red-folder calendar shows the next 24 hours

**Reported:** *"We should see the next red folder news that will happen in the
next 24 hrs."*

The calendar pane listed whatever the feed carried, capped at twelve rows, with a
"−30 minutes" cutoff decided **in the browser**. The next release could be
missing while a past event was still on screen. The window is now computed once,
on the server, in `news.ts → upcomingRedFolder()`: high-impact events from 15
minutes ago to **24 hours ahead**, sorted, each stamped with `inMs` and the next
one flagged. The pane header states the window and the count, and the desk's
timezone is applied to every row. It is the same event list the news gate reads,
so what the user sees and what blocks entries can never disagree.

---

## 6. Fixes that fell out of the above

- **A hand-armed plan is executable with auto-trade off.** The EA refuses every
  `arm_plan` when `limits.tradingEnabled` is false, and that flag was
  `autoTrade && !halted`. So a user who armed a plan manually with auto-trade off
  got `skipped — trading disabled by server` in the MT5 log and nothing on
  screen. The flag is now `(autoTrade || any plan armed) && !halted`.
- **`/desk/series` serves the synthetic frames too**, and accepts them as a
  `timeframe` parameter, so an integration can ask for S10 and get bars (or an
  empty list) instead of a 400.

---

## Files

| Area | Path |
|---|---|
| Asset-class cost policy | `artifacts/api-server/src/lib/multiasset/asset-costs.ts` |
| Sub-minute bars | `artifacts/api-server/src/lib/multiasset/subminute.ts` |
| Best-market pass | `artifacts/api-server/src/lib/multiasset/auto-select.ts` |
| Shared live-data gate | `artifacts/api-server/src/lib/multiasset/live.ts` |
| Bands, weights, substitution | `artifacts/api-server/src/lib/multiasset/{types,confluence}.ts` |
| Stop placement, cost gates | `artifacts/api-server/src/lib/multiasset/{agent,sizing}.ts` |
| 24-hour news window | `artifacts/api-server/src/lib/multiasset/news.ts` |
| Tick ingestion + pass trigger | `artifacts/api-server/src/routes/bridge.ts` |
| State, scan, manual pass | `artifacts/api-server/src/routes/desk.ts` |
| Desk UI | `artifacts/trading-platform/src/pages/terminal.tsx`, `components/terminal/panes.tsx` |
| Tests | `agent.test.ts`, `sizing.test.ts`, `news.test.ts`, `auto-select.test.ts`, `subminute.test.ts` |
