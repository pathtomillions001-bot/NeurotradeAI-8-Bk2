# Multi-Asset Desk — architecture & protocol

Status: **implemented (live-terminal-only v2)**
Scope: forex, metals, indices, commodities, crypto, futures CFDs and broker-listed
stocks/other products, executed on the user's own MetaTrader 5 account through a
local Expert Advisor bridge. The Desk intentionally has no replay/mock-data path;
see [`mt5-live-desk-v2.md`](./mt5-live-desk-v2.md) for installation and live-data safeguards.

This document is the contract. Every number the system computes is defined here,
and every module listed has unit tests that encode these rules.

---

## 1. Why this shape

The Deriv side of the platform talks to one broker over one websocket with one
contract model. Multi-asset cannot work that way:

* There is no free, licensable, real-time feed for FX + indices + futures.
* MetaQuotes publishes no REST API for MT5.
* Scalping cannot tolerate a server round trip on the trigger.
* Lot size means a different amount of money on every symbol.

All four are solved by the same decision: **the user's own MT5 terminal is both
the data feed and the execution venue**, and the decision logic is split across
two brains.

```
          ┌──────────────────────── user's machine / free broker VPS ───────────┐
          │  MetaTrader 5 terminal                                              │
          │    NeurotradeBridge.mq5  (the EA)                                   │
          │      • reports symbol SPECS, quotes, candles, positions, account    │
          │      • holds the ARMED PLAN and fires OrderSend locally  (<10 ms)   │
          │      • enforces MANAGEMENT PLAN tick-by-tick (BE, partials, trail)  │
          │      • enforces hard risk limits even if the server is unreachable  │
          └───────────────▲───────────────────────────────┬─────────────────────┘
                          │ POST /api/bridge/sync         │ commands + plans
                          │ (HTTPS, bearer, ~1 s)         ▼
          ┌───────────────┴─────────────────────────────────────────────────────┐
          │  api-server (this repo)                                             │
          │    lib/multiasset/*                                                 │
          │      spec registry → sizing engine → math (ATR/GARCH, Markov/HMM,   │
          │      Monte Carlo) → multi-timeframe confluence → plan builder       │
          │      → portfolio risk governor → command queue                      │
          └───────────────▲─────────────────────────────────────────────────────┘
                          │ /api/desk/*
          ┌───────────────┴─────────────────────────────────────────────────────┐
          │  trading-platform — Terminal (Bloomberg-style multi-pane UI)        │
          └─────────────────────────────────────────────────────────────────────┘
```

**Split-brain rule.** The server never says "buy now". It publishes an *armed
plan*: a trigger level, an invalidation level, SL/TP, a lot size and a hard
expiry. The EA evaluates that plan on every tick locally. Network latency
therefore affects only how fresh the *plan* is, never how fast the *trigger*
fires.

---

## 2. Symbol spec registry — the basis of all sizing

Nothing about a symbol is hardcoded. On subscribe the EA reports the broker's
own contract spec and the server stores it per account:

| Field | MQL5 source | Used for |
|---|---|---|
| `point`, `digits` | `SYMBOL_POINT`, `SYMBOL_DIGITS` | price ↔ points |
| `tickSize`, `tickValue` | `SYMBOL_TRADE_TICK_SIZE`, `SYMBOL_TRADE_TICK_VALUE_LOSS` | money per point |
| `contractSize` | `SYMBOL_TRADE_CONTRACT_SIZE` | notional, margin |
| `volumeMin/Max/Step` | `SYMBOL_VOLUME_*` | lot quantisation |
| `stopsLevel`, `freezeLevel` | `SYMBOL_TRADE_STOPS_LEVEL/_FREEZE_LEVEL` | SL/TP legality |
| `marginInitial` | `SYMBOL_MARGIN_INITIAL` | free-margin guard |
| `swapLong/Short`, `commissionPerLot` | `SYMBOL_SWAP_*`, broker | holding + round-trip cost |
| `spreadPoints` | live | cost + execution gate |

`tickValue` is reported **in the account currency**, which is what makes a
single formula correct for a USD, EUR or KES account with no FX conversion
table of our own.

### 2.1 Sizing formula (`lib/multiasset/sizing.ts`)

```
riskMoney   = equity × riskPct                       (risk budget, account ccy)
slPoints    = |entry − sl| / point
pointValue  = tickValue × (point / tickSize)         (account ccy per point per lot)
costMoney   = (spreadPoints × pointValue + commissionPerLot) × lots   (solved iteratively)
rawLots     = riskMoney / (slPoints × pointValue)
lots        = floor(rawLots / volumeStep) × volumeStep,  clamped to [min, max]
```

Then, in order, every one of these can **reject or reduce** the order:

1. `slPoints < stopsLevel` → widen SL to the broker minimum and re-size; if that
   breaks the reward:risk floor, **reject**.
2. `lots < volumeMin` → the smallest legal trade exceeds the risk budget.
   **Reject.** Never round up. (This single rule prevents the most common
   silent over-risk on indices with a small account.)
3. Margin: `OrderCalcMargin` estimate must leave post-trade margin level above
   `minMarginLevelPct` (default 500 %). Otherwise reduce, then reject.
4. Cost: spread + commission must be below `maxCostFractionOfRisk` — a scalp
   whose cost eats a third of its risk has no edge left. Both this and the
   spread ceiling are **per asset class** (`asset-costs.ts`): 35 % / 35 % for
   forex, 40 % for metals, 45–50 % for indices, commodities and futures, 55–60 %
   for crypto and stocks. A structurally wide quote on a crypto CFD is not
   judged by a rule written for EURUSD.
5. Portfolio: aggregate risk per currency/complex must stay under
   `maxCurrencyExposurePct`, using a correlation matrix, so three correlated
   1 % trades cannot become one 3 % bet.

Worked examples (fixed in the test-suite, $5 000 equity, 1 % = $50):

| Symbol | SL | pointValue/lot | lots |
|---|---|---|---|
| EURUSD | 12.0 pips | $1.00 / pip | 0.41 |
| XAUUSD | $3.50 | $1.00 / $0.01 → $100/$1 | 0.14 |
| US30 | 45 pts | $1.00 / pt | 1.11 |

Identical money at risk, three unrelated lot numbers.

---

## 3. The math layer

All pure functions, all deterministic, all unit-tested. No paid services.

| Module | What it computes |
|---|---|
| `math.ts` | EMA, SMA, stdev, ATR, Wilder RSI, linear-regression slope + R², z-score, swing structure, EWMA volatility |
| `markov.ts` | Discrete state = (direction bucket × volatility bucket). Transition matrix with Laplace smoothing, n-step distribution, stationary distribution, persistence of the current state |
| `regime.ts` | Per-timeframe classification: `trend_up`, `trend_down`, `range`, `volatile`. Uses slope/R², ATR ratio, Bollinger-width percentile. Produces a confidence in [0,1] |
| `montecarlo.ts` | Simulates N bootstrapped/GBM paths from current drift + EWMA vol. Returns P(TP before SL), P(timeout), expected R, and **expectancy after spread + commission** |
| `confluence.ts` | Scores the frames **inside the chosen mode's band** for trend, momentum, structure, S/R distance, volatility fit; weights by timeframe and mode; yields a 0–100 score and a grade. Bands are exclusive — scalp S10/M1–M3, intraday M5–M30, swing H1–W1 — and a band with no seeded frames is scored from the nearest available ones with the substitution flagged, never as 0 |
| `subminute.ts` | Builds the S10/S30 frames from the per-symbol tick stream (MetaTrader has no period below M1), gated on bar density so a slow feed yields no sub-minute frames rather than a one-tick "candle" |
| `asset-costs.ts` | Per-asset-class spread/commission/slippage policy, resolved from the broker-reported `assetClass` |
| `auto-select.ts` | Automatic best-market pass: evaluates the selected markets, ranks qualifying plans by expectancy after costs, arms one; reports what it did and, when nothing qualifies, the closest miss |
| `agent.ts` | Orchestrates the above into an `ArmedPlan` + `ManagementPlan`, or an explicit no-trade with reasons |
| `risk.ts` | Risk governor: per-trade, per-symbol, per-currency, daily loss, drawdown, consecutive-loss de-escalation, circuit breakers |

### 3.1 The A+ gate

A plan is only armed when **all** hold:

1. Confluence score ≥ mode threshold (scalp 62, intraday 60, swing 60) — computed
   over the mode's own band only.
2. Regime is tradeable for the mode.
3. Monte Carlo **expectancy after costs** ≥ `minEdgeR` (default 0.15 R). The
   spread, commission and slippage are charged inside the simulation — and the
   risk unit the gate is measured in is floored at four times that round trip
   (and at 0.8 ATR of the entry frame), so "one R" can always pay for entering.
   This is the only gate that decides the cost question; the timeout mass and
   its payoff are preserved in the blended expectancy rather than charged as
   losses.
4. Markov persistence of the current favourable state ≥ the mode's floor
   (`DEFAULT_MIN_PERSISTENCE = 0` — advisory by default, since persistence is
   already part of the evidence blend).
5. Risk governor returns `allow`.
6. Sizing accepts the plan: lots ≥ broker minimum, margin headroom, and a
   reward:risk the plan can honour. Sizing no longer refuses on cost at all —
   the spread is priced into gate 3 and into the risk unit itself. The only
   remaining spread number is the EA's fill-time guard
   (`plan.maxSpreadPoints`, asset-class-scaled), which refuses a *fill* into a
   spread that has run away from the one the plan was armed on.
7. The session filter is green and the news gate is open (no red-folder release
   within the blackout, from the same 24-hour window the calendar pane shows).

Failing any gate produces a *reasoned* no-trade, which the terminal displays.
"No A+ setup right now" is a first-class, visible output.

### 3.2 Position sizing is edge-aware

`riskPct = clamp(baseRiskPct × kellyFraction(edge, winProb) × regimeConfidence,
0.05 %, min(governor, perTradeBudget))` with fractional Kelly (¼ by default).
Size scales with *measured* edge and with how confident the regime read is, never
with recent losses. The per-trade budget is `PER_TRADE_RISK_BUDGET_PCT = 0.5 %`
of equity and is a **ceiling, not a size**: the risk policy can only tighten it,
the edge scale may only vote for *less* risk than the governor allows, and the
broker's indivisible minimum lot is judged against the budget rather than the
shrunken target (flagged `minLotApplied` when a trade is taken at the minimum).

---

## 4. Loss handling — explicitly NOT martingale

A stake that grows after a loss converts many small wins into one total loss.
With 1 % → 2 % → 4 % … a seven-loss streak ends the account, and at a 55 % win
rate that streak arrives roughly every 1 200 trades.

The governor therefore **de-escalates**:

| Consecutive losses | Action |
|---|---|
| 2 | risk × 0.75, require confluence +5 |
| 3 | risk × 0.50, require confluence +10, symbol cool-down 15 min |
| 4 | symbol suspended until a regime change is confirmed |
| 5 | account-wide halt for the session |

Plus hard circuit breakers, enforced **in both server and EA**: daily loss
limit (default 3 % of start-of-day equity), max drawdown from peak (default
10 %), max open positions, max correlated exposure, max spread, news blackout.
If the server is unreachable, the EA manages open positions and **opens
nothing new** — the fail-safe direction.

"Recovery" in this system means *controlled re-entry after the regime is
re-confirmed*, at normal or reduced size. It never means a larger stake.

---

## 5. Trade management

The server attaches a `ManagementPlan` to every position; the EA enforces it
locally on each tick.

```jsonc
{
  "ticket": 128374,
  "breakeven": { "triggerR": 1.0, "offsetR": 0.2, "structureBuffer": true },
  "partials":  [ { "atR": 1.0, "closePct": 50 }, { "atR": 2.0, "closePct": 25 } ],
  "trail":     { "mode": "atr_chandelier", "period": 14, "mult": 2.5,
                 "activateAtR": 1.2, "stepPoints": 20 },
  "pyramid":   { "maxAdds": 2, "addAtR": 1.5, "sizeRatio": 0.5,
                 "requireBaseAtBreakeven": true, "portfolioRiskCapR": 1.5 },
  "timeStop":  { "noProgressBars": 20, "timeframe": "M5" },
  "guards":    { "maxSpreadPoints": 18, "newsBlackoutMin": 15, "flatBeforeSessionClose": true }
}
```

Policy, not folklore:

* **Breakeven** is placed behind structure (last swing ± ATR buffer), and only
  once Monte Carlo P(retrace to entry) falls below 35 %. Blind BE-at-1R turns
  winners into scratches on volatile symbols.
* **Partials** fire when the marginal expectancy of holding that slice turns
  negative. Trend regime → take less off; range regime → bank more.
* **Trail vs fixed TP** is chosen by regime: persistent trend → chandelier
  trail (let it run); mean-reverting → hard TP at the band edge.
* **Pyramiding** requires the base at breakeven, uses decreasing size, and
  **never raises total portfolio risk above the original budget**.
* **Time stop** closes trades that are not working, freeing margin.

Every decision is journaled with its inputs so the backtester can later ask
"did BE-at-1R actually help on XAUUSD in the London session?" per symbol, per
regime, per session — and the thresholds are tuned from that evidence.

### 5.1 Broker-reality constraints handled

* **Netting vs hedging** account mode is reported by the EA; pyramiding merges
  into an averaged position under netting and the plan adapts.
* **FIFO** brokers: partial closes target the oldest ticket first.
* **Minimum partial volume**: a 50 % close of 0.01 lots is impossible, so the
  partial ladder is feasibility-checked against `volumeStep` and degrades to a
  single exit when it cannot be honoured.
* **Freeze level / modify rejection**: the EA retries with backoff and reports
  failures; the server never assumes a modify succeeded.

---

## 6. Bridge protocol

Transport: HTTPS `POST`, bearer token issued per linked terminal. MQL5
`WebRequest` works everywhere; `SocketTlsSend` is the low-latency upgrade path
and uses the same message bodies.

**No MT5 password ever leaves the user's machine.** Linking is a pairing code:
the terminal proves possession, the server issues a token. The server stores an
account id, never a credential.

### 6.1 `POST /api/bridge/pair`
```jsonc
→ { "pairingCode": "8F3K-29QD", "terminal": { "login": 51234567, "server": "ICMarkets-Demo",
     "company": "...", "currency": "USD", "accountMode": "hedging", "leverage": 500 } }
← { "bridgeToken": "…", "accountId": "mt5:51234567@ICMarkets-Demo", "syncIntervalMs": 1000 }
```

### 6.2 `POST /api/bridge/sync` (every ~1 s, bearer token)
```jsonc
→ {
  "seq": 10422,
  "account": { "balance": 5000, "equity": 5043.2, "margin": 120.5,
               "freeMargin": 4922.7, "marginLevel": 4184.4, "currency": "USD" },
  "specs":   [ { "symbol": "EURUSD", "point": 0.00001, "digits": 5, … } ],
  "quotes":  [ { "symbol": "EURUSD", "bid": 1.08431, "ask": 1.08444, "spreadPoints": 13, "ts": … } ],
  "candles": [ { "symbol": "EURUSD", "timeframe": "M5", "bars": [ [ts,o,h,l,c,v], … ] } ],
  "positions": [ { "ticket": 128374, "symbol": "EURUSD", "side": "buy", "volume": 0.41,
                   "openPrice": 1.08431, "sl": 1.08311, "tp": 1.08551, "profit": 12.4, … } ],
  "results": [ { "commandId": "uuid", "status": "filled", "ticket": 128374,
                 "price": 1.08433, "slippagePoints": 2, "error": null } ]
}
← {
  "serverTime": …,
  "commands": [ { "id": "uuid", "type": "arm_plan" | "cancel_plan" | "open" | "close" |
                                "close_partial" | "modify" | "flatten_all" | "set_management", … } ],
  "subscriptions": { "symbols": ["EURUSD","XAUUSD"], "timeframes": ["M1","M5","M15","H1","H4","D1"] },
  "limits": { "maxDailyLossPct": 3, "maxOpenPositions": 4, "tradingEnabled": true, "liveTradingEnabled": false }
}
```

### 6.3 Guarantees

* **Idempotency.** Every command carries a UUID. The EA keeps a seen-set and
  refuses duplicates, so a retried sync can never double-open.
* **Reconciliation.** `seq` gaps or reconnects trigger a full position diff;
  orphaned positions are adopted, phantom positions are dropped.
* **Fail-safe.** No contact for `staleAfterMs` (default 30 s) → EA enters
  manage-only mode. No contact for 5 min and `flatOnDisconnect` → flatten.
* **Demo gate.** `liveTradingEnabled` defaults to false; a real account is
  refused until the user explicitly enables it in settings.

---

## 7. Modules in this repo

```
docs/multi-asset-architecture.md             ← this file
artifacts/api-server/src/lib/multiasset/
  types.ts  math.ts  markov.ts  regime.ts  montecarlo.ts
  confluence.ts  sizing.ts  risk.ts  news.ts  agent.ts  store.ts
artifacts/api-server/src/routes/
  desk.ts     ← terminal-facing live-only API
  bridge.ts   ← EA-facing pairing/catalogue/sync API
artifacts/trading-platform/src/pages/terminal.tsx     ← responsive operations desk
artifacts/trading-platform/src/components/terminal/*  ← data/risk/news panes
artifacts/mt5-ea/NeurotradeBridge.mq5                 ← resilient MT5 EA v2
```

Tests: `sizing.test.ts`, `math.test.ts`, `markov.test.ts`, `montecarlo.test.ts`,
`confluence.test.ts`, `risk.test.ts`, `agent.test.ts`, `bridge.test.ts`.

---

## 8. Evidence before money

The build order is deliberately measurement-first:

1. Collect specs/quotes/candles through the bridge → store.
2. Backtest with **realistic costs** (per-session spread, slippage, commission, swap).
3. Walk-forward validation, never in-sample tuning.
4. Monte Carlo the equity curve → expected max drawdown, risk of ruin.
5. Forward-test on **demo ≥ 4 weeks**.
6. Live micro-lots only after 1–5 pass.

The system is built so that "no edge here today" is a valid, visible answer.
A desk that always finds a reason to trade is the failure mode.

---

## Corrections found during bridge integration

These were caught by testing the real server against a port of the EA's own
parsers. Each one is now covered by a test so it cannot regress.

### Size from the trigger, not from the quote

The agent originally sized the position against `entry` (the live quote at the
moment of analysis) while the EA fires at `trigger`, a deliberate displacement
of `0.08–0.12 × ATR` beyond it. The stop is structural and does not move, so
the fill always sits *further* from the stop than the quote did, and the
position therefore risked more than the budget:

| Mode     | Trigger offset | Typical stop | Risk overshoot |
|----------|----------------|--------------|----------------|
| Intraday | 0.12 ATR       | 1.5 ATR      | ~8%            |
| Scalp    | 0.08 ATR       | 0.5 ATR min  | up to ~16%     |

A 16% silent overshoot on every scalp defeats the entire risk framework.
`sizePosition` is now called with `entry: trigger`, so `riskPoints` on the wire
is the trigger-to-stop distance and realised risk equals the budget exactly.
Verified live: `0.53 lots × 63.36 pts × $1 = $33.58` against a `$33.58` budget,
**0.00% overshoot**.

### The command wrapper and the plan both carry `id`

`arm_plan` is `{ id: commandId, type, plan: { id: planId, … } }`. The EA's flat
substring reader returned the *command* id for both, so plans were registered
under the wrong key and a later `cancel_plan` could never match them — a
cancelled setup would have stayed armed. The EA now extracts the nested object
with a brace-matching `JsonObject()` before reading plan fields, and
`ea-contract.test.ts` asserts `planId !== commandId`.

### Sync payloads exceed Express's default body limit

A single symbol's seed (7 timeframes × 300 bars) is ~120 KB; seven symbols is
~800 KB. Against the 100 kb default every sync returned **413** and the bridge
never worked. `/api/bridge/sync` now has a scoped 12 MB parser — scoped so the
rest of the API keeps a tight limit.

Shipping full history on a 1 s heartbeat is also megabytes per second of
unchanged data, so the EA seeds once per symbol/timeframe and then sends only
the newest `DeltaBars` (default 4); the server merges by timestamp. The server
sets `needsHistory` when a symbol *the terminal actually carries* is short of
the 60 bars the Monte Carlo bootstrap needs, and the EA re-seeds. Scoping that
check to reported symbols matters: keyed off the desk watchlist instead, a user
watching seven symbols on a terminal offering three would re-seed forever.

### Rejection messages rounded to collision

`Confluence 68 is below the 68 required` — both sides were rounded to integers.
Now one decimal.
