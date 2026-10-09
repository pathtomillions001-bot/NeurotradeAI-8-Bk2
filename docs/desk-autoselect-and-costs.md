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

## 2. The spread is PRICED, not vetoed — and the risk unit is real

**Reported (round one):** *"We keep getting 'Spread 21 pts is 36% of the 58-pt
stop (limit 25%)'. Is the system aware that crypto spreads and forex spreads
cannot be computed the same — or remove the spread filter entirely?"*

**Reported (round two):** *"We have an A+ setup — short bias 87/62, 24-minute
horizon, confluence 86, evidence 88, 4/7 families — and it did NOT execute:
'Spread 8 pts is 83% of the 10-pt stop — above the 35% ceiling for forex' and
'Expectancy after costs is −1.55R (model −1.14R, gross −0.05R), below the 0.15R
minimum'. Why is the spread still contributing to the trades? Remove that gate
completely. And why is my expectancy always below 0.15R — are the SL and TP
placed wrongly?"*

Round one made the ceilings asset-class aware. That was still the wrong shape:
a *ratio* can refuse a setup whose edge covers the cost it is being refused for.
The gates are now gone entirely, and three arithmetic faults underneath them
were fixed. The user's numbers are reproduced by the old formula in one line:

```
p·RR − (1−p) − costR  →  0.11·4.0 − 0.89 − 1.09  =  −1.55R     ← the report
```

with `costR = 10.9 pt round trip / 10 pt stop ≈ 1.09`. A risk unit that the
round trip can consume entirely cannot be traded at any win rate, so the fix is
not a threshold — it is the arithmetic.

**What the desk does now**

| # | Fault | Fix |
|---|---|---|
| 1 | The stop was resolved from the **fastest frame the confluence scored** (S10 on a scalp) while the horizon was counted in the mode's entry frame (12 × M2 = 24 min). Two clocks, one trade: the stop sat inside the noise of the horizon it was planned over. | `agent.ts → resolveEntrySeries()` anchors on the mode's **own** entry frame (M2 / M15 / H1), substituting nearest neighbours — slower first, so a substitution widens the stop instead of tightening it. The frame used is reported as `entryTimeframe` with its `horizonMinutes`, and the pane prints *that* number, never the mode's nominal one. |
| 2 | The stop could be **smaller than the spread**. "One R" then costs less than the act of entering, so no win rate can produce a positive expectancy. | `MIN_COST_COVERAGE = 4`: the risk unit is floored at four round trips (cost ≤ 25% of R) and at `MIN_RISK_ATR = 0.8` ATRs of the entry frame. When structure is tighter than the floor, the stop is **widened** and the widening is a warning on the decision (`stopWidened`), never a silent change of plan. |
| 3 | The blended expectancy was recomputed as `p·RR − (1−p) − costR`, charging **every path that ends at the time stop as a full −1R**. Most paths of a wide-stop plan end there, so the formula manufactured the negative number the gate then refused. | The timeout mass and its payoff are preserved: `E = p·RR − lossP + timeoutP·timeoutMeanR − costR`, with `lossP = clamp(1 − p − timeoutP, 0, 1)`. With no realised history blended in it reduces **exactly** to `monteCarlo.expectancyR`. The refusal line now reports the stop/time-stop split so it can be read instead of guessed at. |

**Cost policy today (`asset-costs.ts`)**

- `costR = (live spread + commission points + slippage allowance) / risk unit`.
  The **live quote's** spread is used, not the spec's cached copy — the fill pays
  the quote.
- The spread is charged inside the Monte Carlo the gate reads. `minEdgeR = 0.15R`
  is the **only** cost gate in the desk.
- Per asset class, only two numbers remain: `fillSpreadFractionOfStop` (how far
  the spread may *widen between arming and filling* — an execution guard, not an
  edge judgement) and `slippageMultiplier`. Forex 0.40/1, metals 0.45/1.5,
  indices 0.55/2, commodities 0.55/2, futures 0.50/2, crypto 0.65/3,
  stocks 0.65/3, other 0.50/2.
- `sizing.ts` no longer refuses on cost at all. It converts a risk budget into a
  legal lot size, reports `costMoney`/`riskMoney`, and the remaining rejections
  are `invalid_input`, `stop_too_tight`, `below_min_lot`, `insufficient_margin`
  and `reward_risk_too_low`. The old `spread_too_wide` and `cost_exceeds_edge`
  branches — and the lines they printed — are deleted, with tests asserting they
  cannot come back.

### The per-trade risk budget is a ceiling, not a size

**Reported (round three):** *"We also had this block: 'Minimum 0.01 lots would
risk 1.29 units (0.17% of equity), above the 0.15% budget of 1.14.' Raise the
budget to 0.5% — but not fixed; the system will decide what to use."*

That message named the wrong number twice over. The `0.15%` was never the
desk's budget: it was the **adaptive target** — the governor's allowance after
the edge and regime cuts — and the guard compared the broker's indivisible
minimum lot against that shrunken target instead of against a budget. An
account that could afford 0.17% per trade was told it could not trade at all.

- `PER_TRADE_RISK_BUDGET_PCT = 0.5` (`risk.ts`) is the desk's per-trade budget.
  It is a **ceiling**, and the risk policy in settings can only *tighten* it:
  `riskCeilingPct = min(0.5%, policy.maxRiskPct)`. A configured value above it
  lowers nothing and raises nothing.
- What is actually risked stays **adaptive**. The agent's target is
  `clamp(governor × edge scale × regime confidence, 0.05%, governor)`, where the
  governor itself is already inside the budget: fractional Kelly on the blended
  win probability shrinks it for thin edges, the regime confidence shrinks it in
  doubt, and the loss ladder shrinks it after losses. Only the ceiling is fixed.
- `sizing.ts` judges the broker minimum against the **budget**, not the target.
  If `volumeMin` fits inside the ceiling it is taken and reported
  (`minLotApplied`, plus *"broker minimum lot taken because the adaptive 0.15%
  target could not buy less — inside the 0.50% budget"*); if it does not fit it
  refuses and names the budget: *"above the 0.50% per-trade risk budget of
  3.80"*.
- The edge can no longer multiply the risk back up. The scale used to allow
  `1.5 ×` the governor's number, which meant a "0.5% budget" could trade 0.75%
  and, worse, a strong signal silently refilled a de-escalation the ladder had
  just applied. The cap is now **1×**: the edge can only vote for less risk.

The reported account: $760 of equity × 0.5% = $3.80 of budget; the broker's
0.01 lots risks $1.35 = 0.18%, inside the budget, so the trade is taken. On a
$200 account the same lot risks 0.67%, which the budget cannot afford, and the
refusal says so. De-escalation still works inside the budget — verified in
`agent.test.ts`, where the same market is sized 0.37 → 0.27 → 0.18 lots after
2 and 3 consecutive losses (0.499% → 0.364% → 0.243% of equity).

Verified on a synthetic EURUSD.m scalp with an 8-point spread and an 8-point-tall
structural stop (the reported shape): the risk unit is widened to 61 points,
`costR` is 24%, `entryTimeframe` is M2 with a 24-minute horizon, and the setup
**arms** (E 3.38R). Markets that are refused are refused on their economics, e.g.
`Expectancy after costs is −0.03R (model −0.03R, gross 0.22R, 0% stop / 100%
time-stop paths), below the 0.15R minimum.` — which is a statement about the
market, not about a ratio.

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
  journal and on screen. "Closest" is a statement about the MARKET, not about the
  watchlist order: analysis survivors (everything except the economics passed)
  come first, ranked by the expectancy that stopped them, then everything else by
  quality. The table is ordered the same way, so the row the desk names is the
  row at the top. Markets that were skipped for stale or incoherent data are
  named too — "no qualifying setup in 11 selected markets" is not an answer when
  three of the eleven were never analysed.

---

## 5. The red-folder calendar shows the next 24 hours

**Reported:** *"We should see the next red folder news that will happen in the
next 24 hrs."*

The calendar pane listed whatever the feed carried, capped at twelve rows, with a
"−30 minutes" cutoff decided **in the browser**. The next release could be
missing while a past event was still on screen. The window is now computed once,
on the server, in `news.ts → upcomingRedFolder()`: high-impact events from
**twelve hours ago** through **24 hours ahead**, sorted, each stamped with `inMs`
and the next one flagged. The pane header states the forward count and the count
of releases already out today, and the desk's timezone is applied to every row.
It is the same event list the news gate reads, so what the user sees and what
blocks entries can never disagree.

### Empty is not an all-clear

**Reported:** *"We have 3 red-folder events today, but the desk says 'Next 24 h ·
0 red-folder events … No high-impact events in the next 24 hours. The gate stays
armed.'"*

Two ways to be wrong, both fixed:

1. **The list did not remember the day.** A release that happened four hours ago
   was dropped, so a genuinely quiet afternoon printed as "0 red-folder events"
   while the terminal's own calendar showed three. Releases from the last twelve
   hours are now listed with `passed: true` — greyed, labelled *released*, never
   counted as upcoming — because they are the explanation for a quiet session.
2. **An empty calendar read was treated as a clear one.** `CalendarValueHistory`
   can return success with a zero-length array while MT5's calendar database is
   still syncing. The EA latched `available: true` on that result and the desk
   asserted a calm nobody had verified. The EA now retries with an open-ended
   window, publishes `rawCount` (rows read) and `redCount` (rows kept), and
   reports the calendar **unavailable** — which fails closed for new entries —
   when the read returns nothing at all. The desk renders that as *"the terminal
   returned no calendar rows… new entries stay paused until the read succeeds"*
   instead of "0 events, gate armed".

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

## 7. The terminal link is a circuit breaker, not a tripwire

**Reported:** *"The desk says 'The MT5 terminal last synced 39s ago. Quotes and
agent entries are paused until it resumes.' Fix this so we always have a stable
connection and do not miss trades or data."*

A single 30-second cliff meant one slow round trip — MT5 copying history, a VPS
hiccup, a broker restart, a busy event loop — flipped the entire desk into
"paused". Nothing was gained by it: the freshness that actually protects the
account is **per symbol** (`QUOTE_STALE_MS` = 8 s, warming 20 s) and that check
is not relaxed by a millisecond. A circuit breaker that trips on every hiccup
teaches the user to ignore it.

The link is now two-stage, and both stages are sized from the terminal's **own**
reported heartbeat (`clock.syncIntervalMs`):

| Stage | When | What happens |
|---|---|---|
| **degraded** | past 20 s of silence | The desk keeps analysing and arming. Every market is still gated on its own quote age, so a frozen feed cannot be traded. The UI says *reconnecting* — never "paused". |
| **stale** | past `clamp(heartbeat × 12, 120 s, 300 s)` | The terminal is written off; new analysis pauses until it returns. |

Also fixed on this path:

- **The EA heartbeats first.** `Sync()` used to run after the calendar refresh
  and the local plan evaluation, so a busy terminal could postpone it by seconds.
  It is now the first thing `OnTimer()` does, and the EA publishes the cadence it
  is actually running at.
- **The EA's own silence budget matches the desk's.** It used to stop executing
  after 30 s of server silence (`StaleAfterSec`), i.e. while the desk still
  considered the link live; that is now `ServerSilenceSec = 120`, separate from
  the tick-freshness check.
- **`/bridge/status` no longer keeps its own 30-second cliff.** The setup dialog
  reads the same two-stage state as the desk, so it cannot call the link dead
  while the desk is trading on it.
- **Plan expiry compared a UTC value with a server-time clock.** `expiresAt`
  arrives as a UTC epoch in milliseconds and was tested against
  `NowServer() * 1000`. On a GMT+3 broker every plan was "expired" the instant it
  was armed — a setup the desk had approved never reached the market. The
  comparison now uses the same UTC clock as the value.

---

## 8. What the four fixes do NOT change

- The per-symbol freshness gate (`QUOTE_STALE_MS` 8 s / warming 20 s) and the
  price-integrity check (quote vs its own candles) are untouched: nothing is ever
  analysed or armed on a stale or self-contradictory quote.
- The news gate still **fails closed**: an unavailable or stale calendar pauses
  new entries. It now fails closed *honestly* — with `rawCount` 0 reported as
  "no data" rather than "all clear".
- `minEdgeR = 0.15R` is still the gate. The difference is that it now reads a
  number computed correctly, on a risk unit that can actually absorb the cost of
  entering.
- Auto-trade still arms exactly one plan per pass, and every gate that existed
  before the economics is still applied first.

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
| Terminal health / two-stage staleness | `artifacts/api-server/src/lib/multiasset/live.ts`, `artifacts/api-server/src/routes/{bridge,desk}.ts` |
| Heartbeat, plan expiry, calendar read | `artifacts/mt5-ea/NeurotradeBridge.mq5` (v3.02) |
| Desk UI | `artifacts/trading-platform/src/pages/terminal.tsx`, `components/terminal/{panes,bridge-dialog}.tsx`, `lib/desk.ts` |
| Tests | `agent.test.ts`, `sizing.test.ts`, `news.test.ts`, `auto-select.test.ts`, `subminute.test.ts` |
