# MT5 Live Desk v3 — real-time data, correct times, and a signal engine that trades

Supersedes the v2 notes in [`mt5-live-desk-v2.md`](./mt5-live-desk-v2.md) for the six areas below.
Everything v2 stood for still holds: the Desk renders **only** live terminal data, and a
non-fresh quote blocks analysis, arming and execution.

---

## 1. Wrong and delayed prices

Three separate defects produced the symptom "XAUUSD shows 5898.46 when the market is 4105.35".

### 1a. Timestamps were in the broker's timezone, not UTC

Every quote, candle and calendar event was sent as `time * 1000`, where `time` comes from
`TimeTradeServer()`. On a broker whose server runs GMT+3, every timestamp the platform
received was three hours in the future relative to true UTC. The server then computed
"quote age" against its own wall clock, so a fresh tick could look hours old (or a stale
tick fresh), and news times were wrong by exactly the server offset.

**Fix.** The EA now derives its offset from MQL5's own GMT pivot and normalises everything
before it leaves the terminal:

```mql5
int ServerUtcOffsetSeconds() {
   long offset = (long)TimeTradeServer() - (long)TimeGMT();  // server minus GMT
   return (int)MathMax(-86400, MathMin(86400, offset));       // clamped, so one bad
}                                                             // sample cannot poison a week
long ToUtcMs(const datetime value) { return ((long)value - ServerUtcOffsetSeconds()) * 1000; }
```

`QuotesJson`, `CandlesJson` and `NewsJson` all emit `ToUtcMs(...)`, and the terminal sends a
`clock` object on every heartbeat so the server can cross-check rather than trust:

```json
"clock": { "serverUtcOffsetSeconds": 10800, "terminalUtcMs": 1791393454672, "label": "Broker-Demo" }
```

The server keeps `clockSkewMs = terminalUtcMs - serverNow`. Beyond a tolerance it warns in the
UI and, critically, it **corrects every age it computes** by the skew — so a skewed terminal
degrades to a warning, not to wrong data.

### 1b. Cached ticks on symbols the EA had not touched

`SymbolInfoTick` returns the last cached tick for a symbol that is not in Market Watch. For a
renamed contract or a symbol the EA had not selected, that cache can be hours — or days — old,
and it looks perfectly plausible.

**Fix,** two-layered:

- **In the EA:** `SymbolSelect(symbol, true)` before reading, so the terminal actually
  subscribes; ticks older than `StaleAfterSec` are dropped at source and an `ageMs` field is
  emitted with every quote.
- **In the server:** `lib/multiasset/integrity.ts` cross-checks each quote against the symbol's
  *own* recent candles. A quote is flagged `mismatch` only when **both** scales are wrong:

  ```ts
  const mismatch = deviationAtr > 25 && deviationPct > 25;   // AND, not OR
  ```

  Requiring both is the point. Gold moving 1.5% in a minute is a market event, not a corrupt
  feed, and an OR rule flagged it. A 4105-vs-5898 disagreement is ~44% away — it trips both.

A `mismatch` symbol is rendered in red, named in a banner, and **blocked from trading**.
A wrong price is never displayed as if it were a good one.

### 1c. Polling

The Desk polled `/api/desk/instruments` every four seconds, so every price was at least one
poll old and a symbol at the tail of the rotation could be several heartbeats behind.

**Fix.** `GET /api/desk/stream` is a server-sent event stream; the server broadcasts a `desk`
event the instant a terminal heartbeat lands. The client (`hooks/use-desk-stream.ts`) keeps
polling as a *fallback* only, and the header shows `STREAM` or `POLL` so transport state is
never invisible.

Related: `SyncIntervalMs` 1000 → **500 ms**, `SymbolsPerHeartbeat` 24 → **12** (candles only
now), and a new `SendAllQuotesEachBeat = true` input sends the full selection's quotes on every
beat. Candles remain batched, because resending ten timeframes for 40 symbols every half second
is pointless.

---

## 2. News/calendar times are Nairobi EAT

Two problems, and fixing only the formatting would have left the bug in place.

1. Calendar timestamps arrived in broker-server time (§1a), so the *value* was wrong.
2. The frontend rendered with `toLocaleString()` and no `timeZone`, so the *display* used
   whatever clock the browser happened to have.

Now the terminal sends true UTC and the Desk renders in an explicit, user-selectable zone that
**defaults to `Africa/Nairobi`** and never falls back to "whatever the device thinks". Each
row also carries the zone abbreviation (`EAT`) next to the time, and the journal and every
other timestamp use the same zone. `GET /api/desk/settings` accepts `{ timezone }`; the
server validates against an allowlist and reflects the current value in `/desk/state`.

The EA's forward calendar window also grew from 2 hours to 24 (`CalendarValueHistory(now - 15m,
now + 24h)`), which is why the upcoming-events list used to sit empty for most of the session.

---

## 3. Filling the desktop gap below the calendar

The right-hand column ended at the news calendar, leaving a large void on wide screens. It is
now filled by two panes, both built from live broker data only:

- **Realised performance** — equity curve sampled from terminal equity, P&L by symbol as a
  diverging bar chart, and the statistics that actually decide whether an edge exists: win
  rate, total R, average R, profit factor, max drawdown in R, worst losing streak, and the
  recently-closed trade list with per-trade R multiples. Built *only* from closed positions —
  a record, not a projection.
- **`{symbol} · price action`** — candlestick chart of the selected instrument with a
  timeframe switcher (M1 → W1) that draws the armed plan's trigger, stop and target directly on
  the price. Inline SVG, no charting dependency, so it renders identically offline and in an
  iframe.

A **Performance** pane was also added to the left column under the watchlist.

---

## 4. Mobile: the "live market pulse"

The pulse used a four-column strip designed for a desk-width screen. On a phone each column
became a cramped box, and the price — the one thing you opened the desk to see — was rendered
at the same size as the spread.

The mobile layout is now a card: symbol and feed status in the header, bid and ask as two large
figures, then spread / change / 24h range / tick age as pills, then a sparkline of recent
closes, then any price-integrity warning.

**Desktop is unchanged.** The two layouts are explicit (`sm:hidden` and `hidden sm:grid`)
rather than one responsive compromise, so neither screen size is a degraded version of the
other.

---

## 5. The agent was blocking almost every trade

The dominant cause was the Markov gate: a single first-order model, reading only the sign of
the last few bars, sitting on the decision path with veto power. When it said "no", the trade
died there — regardless of what everything else said.

### 5a. Markov is now evidence, not a gate

`markov.ts` still runs, but as **one family in a weighted ensemble** (`evidence.ts`) alongside
six others. No single family can veto.

| Family (`FactorFamily`) | Rendered as | What it measures |
|---|---|---|
| `trend` | Kalman trend | Kalman-filtered slope, level and slope-vs-noise quality |
| `momentum` | Momentum | RSI with an explicit fade warning when extended, efficiency ratio |
| `meanReversion` | Mean reversion | Ornstein–Uhlenbeck z-score and half-life, **suppressed when Hurst ≥ 0.45** |
| `breakout` | Breakout / range | Position within the recent range, ATR expansion vs the slow ATR |
| `flow` | Volume flow | Money flow and order-flow imbalance from the bar's own volume profile |
| `regime` | Regime memory | Hurst, variance ratio, Ljung–Box and permutation entropy together |
| `markov` | Markov persistence | the original transition model — now one vote of seven |

Each family returns `{ vote, strength, reliability }`. Reliability **shrinks the vote toward
zero when the sample is short**, which is what stops a model fitted on 30 bars from swinging a
real-money decision:

```
contribution = vote × strength × weight × (n / (n + shrinkage))
```

Two guards, both chosen to be *permissive by design*:

- `MODE_MIN_AGREEING_FAMILIES = 3` of 7 — three independent confirmations, not seven.
- Family weights differ per mode (a scalp weights microstructure heavily; a swing weights
  trend and volatility), so a mode's irrelevant families cannot dominate it.

### 5b. New statistics (`analytics.ts`)

Hurst (R/S and structure-function), variance ratio, OU fit with half-life, skew, excess
kurtosis, efficiency ratio, permutation entropy, money flow, range position, Kalman trend,
GARCH(1,1), lag-1 autocorrelation, Ljung–Box, beta-posterior shrinkage, `normalCdf`. Covered by
27 unit tests, including the cases that matter: a mirror-symmetric sample has zero skew, and
autocorrelation must be measured on *returns*, not prices.

### 5c. Costs are charged honestly

Rejections quote expectancy *after* spread, commission and swap (`Expectancy after costs is
−0.05R (model 0.16R, gross 0.24R)`). A trade that only looks good before costs is not a trade.

### 5d. Risk capacity

`maxOpenPositions` 4 → **12**, `maxPositionsPerSymbol` 1 → **3**. With three independent
confirmations required, the binding constraint should be the portfolio, not a per-symbol cap of
one.

Measured on synthetic data (all three modes, trending / ranging / choppy):

| Regime | Scalp | Day | Swing |
|---|---|---|---|
| Trend up | **ARMED** q94.4, E +0.59R | **ARMED** q94.9, E +3.92R | **ARMED** q87.2, E +3.94R |
| Range | rejected q43.5 | rejected q37.7 | rejected q31.5 |
| Chop | rejected E −0.51R | rejected E −0.05R | rejected E −0.27R |

Good trades get through. Noise still does not.

---

## 6. Timeframe alignment is no longer a veto

Previously a trade needed every timeframe it looked at to agree. One dissenting frame — often
the slowest, which is the *least* relevant to a scalp — killed the setup.

Now:

- **Each mode monitors its own band, and nothing else.** There are no context frames:
  - scalp → **S10, S30**, M1, M2, M3 (10 seconds to 3 minutes)
  - day → M5, M15, M30 (5 to 30 minutes)
  - swing → H1, H4, D1, W1 (1 hour to weekly)

  `MODE_CONTEXT_TIMEFRAMES` is empty for all three modes, so the context penalty machinery
  (`CONTEXT_PENALTY_PER_FRAME = 5`, cap 12) is inert and `contextPenalty` is always 0 — kept as a
  stated decision rather than an absence someone has to infer. The old scheme measured frames
  *outside* the band and deducted up to 12 points when one disagreed — which meant a scalp
  carried an opinion about the hourly candle, and swing's "context" frame (W1) was already inside
  its own band, so the weekly candle was both scored and penalised.

  `S10`/`S30` cannot come from `CopyRates` — MetaTrader's fastest period is M1. They are built on
  the server from the per-symbol tick stream the EA already pushes on every heartbeat
  (`subminute.ts`), and withheld until the recent bars are dense enough to be honest
  (`MIN_SAMPLES_PER_BAR = 2`, `DENSITY_WINDOW = 20`). A terminal heartbeating every 30 s produces
  no sub-minute frames at all, and the band falls back to M1–M3.
- **Dissent inside the band is priced, not vetoed.** `VETO_TIMEFRAMES` stays deleted;
  higher-timeframe opposition inside the band is surfaced as a caution ("Carried cautions").
- **A data gap is not a bad market.** A band with no seeded frames used to score **0** — the
  source of the `confluence 0.0` in "Quality 31.8 is below the 62.0 required…". The score is now
  taken from the nearest available frames, with `substituted: true` and the substitution named in
  `warnings`; the missing frames are listed individually.

Verified: with two and three timeframes inverted against the trend, all three modes still arm
(quality 74–95 against thresholds of 60–62). Nothing in any rejection list mentions alignment.

### The three modes differ in more than timeframe

| | Scalp | Day | Swing |
|---|---|---|---|
| Analysis band | S10–M3 | M5–M30 | H1–W1 |
| Horizon | ~25 min | ~6 h | ~48 h |
| Stop (ATR ×) | 0.8 | 1.5 | 2.0 |
| Plan TTL | 60 s | 10 min | 60 min |
| Time stop | 15 bars M2 | 25 bars M15 | 25 bars H1 |
| Break-even | at 1.8R | at 1.2R | at 1.2R |
| Score threshold | 62 | 60 | 60 |
| Evidence blend | 0.55 | 0.45 | 0.40 |
| Default chart | M2 | M15 | H1 |

Ownership now sits in one place per concern: the bands in
`lib/multiasset/types.ts` (`MODE_ANALYSIS_TIMEFRAMES`, `MODE_ANALYSIS_LABEL`), the weights and
substitution in `lib/multiasset/confluence.ts`, the sub-minute construction in
`lib/multiasset/subminute.ts`.

Every plan carries `management` — break-even with a structure buffer, two partial exits (35% at
1.5R, 25% at 3R), an ATR chandelier trail activating at 1.2R, one pyramid add at 1.5R capped at
1.5R portfolio risk, a time stop, and spread/slippage/news guards.

### Costs are per asset class

The single global `maxSpreadFractionOfStop = 0.25` (and a companion spread gate in the agent that
could never fire, because it compared the live spread against the live spec's own spread) is
replaced by `lib/multiasset/asset-costs.ts`. Every limit is a **ratio**, so "points" — which mean
something different on every instrument — never enter the decision:

| Asset class | spread ÷ stop | (spread + commission) ÷ risk | fill spread ÷ stop | slippage × |
|---|---|---|---|---|
| forex | 35% | 35% | 40% | 1 |
| metals | 40% | 40% | 45% | 1.5 |
| indices / commodities | 50% | 45% | 55% | 2 |
| futures | 45% | 45% | 50% | 2 |
| crypto / stocks | 60% | 55% | 65% | 3 |

The spread is charged *in* the expectancy simulation, so the gate that decides is
`minEdgeR = 0.15R` net of costs; the ceilings above are the outermost refuse. A spread that is
wide for its class but still inside the ceiling becomes a caution on the plan rather than a
silent veto. Pairs: `asset-costs.ts` (policy), `sizing.ts` (refusal + sizing),
`agent.ts` (cost-aware expectancy), `bridge.ts`/`presenter.ts` (`plan.maxSpreadPoints`).

---

## The desk finds the best market itself

While auto-trade is on, `lib/multiasset/auto-select.ts` runs on the heartbeat: it evaluates every
**selected** market through the same `evaluate()` as the manual path (same risk governor, news
gate, cost policy, sizing), skips markets that already hold a position or an armed plan, ranks
what qualifies by **expectancy after costs** and then quality, and arms exactly one — the best.
The EA then watches the trigger locally and manages the position from the plan's `management`
block, exactly as for a hand-armed plan.

Cadence is per mode (scalp 15 s, day 30 s, swing 60 s) and the pass sweeps a rotating window of
the watchlist, so a large selection is covered over several passes without blocking a heartbeat.
`/api/desk/state` reports the last pass (`autoSelect.last`) — scanned, qualified, chosen, ranked —
and `POST /api/desk/auto-select` runs one on demand. When nothing qualifies, the desktop names the
**closest miss** and its rejection in the journal.

The binding limits stay risk-based; auto-select is not a trade-count budget.

## The red-folder calendar shows the next 24 hours

`NewsPane` lists high-impact events from 15 minutes ago to **24 hours ahead**, sorted, with the
next one flagged. The window is computed once on the server (`news.ts → upcomingRedFolder()`), so
the pane, the agent's news gate and the journal all describe the same list. Every time is
rendered in the desk's configured timezone (Nairobi EAT by default) and labelled with that zone's
abbreviation.

---

## Upgrading the EA

The EA in this branch is **v3.01** (v3.00 above plus the one-account rule in §7). Re-download and
re-attach it; v2 will still pair but will send server-relative timestamps and rotate symbol
coverage.

New and changed inputs:

| Input | v2 | v3 |
|---|---|---|
| `SyncIntervalMs` | 1000 | 500 |
| `SymbolsPerHeartbeat` | 24 | 12 (candles only) |
| `SendAllQuotesEachBeat` | — | `true` (new) |

Timeframe set grew from 7 to 10 with **M2, M3 and W1** (`#define TF_COUNT 10`). The Desk's
scalp mode analyses M2 and M3, and swing mode analyses W1, so v2 left those modes working from
a thinner set of frames than intended. The EA's timeframe list is unchanged by the S10/S30
work: those frames are synthesised on the server from ticks the EA already sends
(`SendAllQuotesEachBeat = true`), never requested from the terminal.

---

## Files

| Area | Path |
|---|---|
| EA | `artifacts/mt5-ea/NeurotradeBridge.mq5` |
| Routes | `artifacts/api-server/src/routes/desk.ts`, `.../bridge.ts` |
| Integrity | `artifacts/api-server/src/lib/multiasset/integrity.ts` (new) |
| Evidence ensemble | `artifacts/api-server/src/lib/multiasset/evidence.ts` (new) |
| Statistics | `artifacts/api-server/src/lib/multiasset/analytics.ts` (new) |
| Presentation | `artifacts/api-server/src/lib/multiasset/presenter.ts` (new) |
| Frontend | `src/pages/terminal.tsx`, `src/components/terminal/panes.tsx`, `src/lib/desk.ts`, `src/hooks/use-desk-stream.ts` (new) |

Tests: 222 passing (12 files under `src/lib/multiasset/`), including 53 new ones covering the
statistics, the evidence ensemble and feed integrity. Run with:

```
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx --test src/lib/multiasset/*.test.ts
```

---

## 7. One MT5 account, one Desk

An MT5 account can be connected to exactly one Desk at a time. Opening a second browser (or a
second device, or an incognito window) and pairing the same login is **refused**.

### Why it has to be refused

Desk state is held per browser session, so nothing previously stopped the same broker account
being paired twice. Both sessions would then stream the same account, both would arm plans
against it, and either could flatten positions the other believed it owned — one balance counted
against two independent sets of risk limits, and each Desk blind to what the other had open.

### How it is enforced

`lib/multiasset/claims.ts` keeps a global registry of `login@SERVER → session`, in two layers:

- **Postgres `mt5_account_claims`** is the real guarantee. The unique index on `account_key`
  makes concurrent pairings race on a single `INSERT … ON CONFLICT`, so exactly one wins — across
  processes, and across a redeploy. The conflict clause only overwrites an existing row when it
  belongs to the same session or has gone idle.
- **An in-process map** mirrors it so `/sync`, which runs twice a second per terminal, never
  touches the database.

The identity is normalised (`login@SERVER`, server trimmed and upper-cased) so one broker server
spelled two ways is never mistaken for two accounts.

| Event | Effect |
|---|---|
| Second browser pairs a held account | **409** `account_already_connected` — refused |
| Same browser re-pairs (EA restart, redeploy) | allowed |
| Same browser pairs a *different* account | previous claim released — a Desk holds one terminal |
| Unlink | claim released; the account is immediately available elsewhere |
| Terminal stops heartbeating for 10 min | claim goes idle and can be taken over |
| Heartbeat after another Desk took the account | **409** `account_claimed_elsewhere`; the superseded terminal is unlinked and stops trading |

The last row matters: the old bearer token is still cryptographically valid, so `/sync` is the
only place a handover can be enforced. Without it the superseded terminal would keep streaming
and trading an account the Desk no longer owns.

### What the user sees

- **In the browser:** the setup dialog shows the refusal instead of sitting on "waiting for the
  terminal". The EA performs the pairing, so the refusal is recorded on the desk and returned by
  `GET /api/bridge/status` as `lastPairingError`.
- **In MT5:** the Experts log prints `PAIRING REFUSED — …` (or `DISCONNECTED — …` on a
  superseded heartbeat) with the server's own wording.

A refused pairing deliberately does **not** burn the pairing code. The EA retries every few
seconds, so keeping the code alive means one clear repeated explanation instead of "unknown or
expired code" — and the terminal connects by itself, with no user action, the moment the other
Desk lets go. The EA backs off to 60 s on a 409 so it does not hammer the endpoint.

### Caveat

When the database is unreachable the guarantee degrades to the in-process registry: this process
still refuses a duplicate pairing, but a second application instance would not be blocked. That
is deliberate — refusing to pair at all would be worse than a narrower check — and it is logged
once as a warning.

### Files

| Area | Path |
|---|---|
| Registry | `artifacts/api-server/src/lib/multiasset/claims.ts` (new) |
| Routes | `artifacts/api-server/src/routes/bridge.ts` (`/pair`, `/unpair`, `/sync`, `/status`) |
| Schema | `lib/db/src/schema/mt5_account_claims.ts` (new), `lib/db/src/index.ts` (INIT_DDL) |
| Frontend | `src/components/terminal/bridge-dialog.tsx`, `src/lib/desk.ts` |
| EA | `artifacts/mt5-ea/NeurotradeBridge.mq5` (v3.01) |
| Tests | `src/lib/multiasset/claims.test.ts`, `src/routes/mt5-account-claims.test.ts` (26 cases) |
