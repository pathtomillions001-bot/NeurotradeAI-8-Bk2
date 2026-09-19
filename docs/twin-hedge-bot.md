# Twin-Lock Hedge Sentinel — the paired same-tick bot (`twinhedge`)

## What it trades (hard-wired, no user choice)

| Phase    | Contracts (both on the SAME tick, SAME stake) | Trigger |
|----------|-----------------------------------------------|---------|
| Normal   | **Over 4** + **Under 5**                      | shared ledger says "no debt" |
| Recovery | **Over 5** + **Under 4**                      | ONLY when a normal round lost BOTH legs |

- A **split round** (one leg wins, one loses) is the hedge working as designed. It
  never touches the recovery ledger — the small payout-vs-stakes tax it pays
  (≈ `|m − 2| · stake` per round) lands in session P&L only.
- A **both-win** round (rare — only when broker latency lets the legs settle on
  different ticks with a downward boundary crossing) pays roughly `2 · (m − 1)`
  and counts as a win.
- A **both-lose** normal round is the ONLY recovery trigger. Its full stake
  (2 × base) becomes the ledger debt, and the recovery pair is sized to digest
  that **total** — lose $2 across two $1 legs → attack $2.
- A recovery round settles on its own combined result: any covered digit nets
  `S · (m_rec − 2)` per leg stake and pays down debt; a second both-lose grows
  the debt by the recovery round's total stake and advances the step counter.

## Why digits 4 and 5 are the entire strategy

The 4|5 line is the shared boundary of both pairs:

1. **Normal pair is complementary** — Over 4 wins on 5–9, Under 5 wins on 0–4.
   On a single exit tick exactly one leg ALWAYS wins. The only way to lose both
   is to settle the two legs on *different* ticks while the stream crosses the
   boundary upward (≤4 then ≥5). Digits 4 and 5 are where those crossings start.
2. **Recovery pair is the complement of the gap** — Over 5 ∪ Under 4 covers
   8/10 digits; the ONLY both-lose outcome is an exit digit of exactly 4 or 5.

With equal stakes `S` per leg and winning payout `m`, the recovery round nets
`+S(m−2)` on a covered digit and `−2S` on a gap digit, so the pair is break-even at

```
q* = 2 / m          (q = P(exit digit ∉ {4,5}))
m = 2.43  ⇒  q* = 82.3 %
```

The scanner computes each market's **worst-case** q̂ (5th-percentile style lower
bound on an autocorrelation-corrected effective sample) and marks a market
below `q*` as unable to digest debt — because there, the ladder is the thing
that kills the account, not a losing streak.

## Execution: speed, latency, same-tick

- **Tick-driven, never timer-driven**: every fire decision is taken
  immediately after a fresh tick arrival for the working symbol, giving both
  buys the maximum time (a full tick period) to be confirmed before the
  settlement tick.
- **One burst, one socket**: both legs go through `executeBulkLiveTrades` —
  the same atomic batch executor the manual bulk panel uses — which sends all
  proposals for the round in a single burst over the account's persistent
  socket (with the throttle-aware per-leg retry logic that keeps every leg
  exactly-once), and both contracts are then settled in one `profit_table`
  sweep (`waitForBulkContractResults`), so entry AND exit are tick-aligned.
- **Stale-feed refusal**: if the symbol's ticks are older than a safe window,
  the engine will not fire ("next tick" would be unknowable).
- **A rejected leg never arms recovery**: if the broker executes only one leg,
  the round settles on the confirmed leg alone, the failed leg's stake was
  never taken, and per product rule the both-lost condition (BOTH legs traded
  and lost) cannot fire.

## The entry gate (per tick)

The live gate (`twinEntryGate`) refuses an entry when any of these is true:

1. the current tick **is** digit 4 or 5 (entering from the boundary);
2. the last tick **crossed** the 4|5 boundary (a flip in progress);
3. fewer than 3 clean ticks since the most recent gap hit (post-gap cool-down);
4. the fused worst-case hazard `P(next ∈ {4,5})` is above the ceiling
   (23% normal, 26% recovery);
5. recovery-only: the safe-rate lower bound sits under the `q*` digest line —
   this never blocks, but the round is logged **FORCED** (stranded debt is
   worse than an unfavourable recovery).

Patience valve: after 12 refused ticks a **recovery** round fires regardless —
debt must be attacked; **normal** rounds keep waiting (entry is optional).

The hazard estimate fuses three estimators in inverse variance — Dirichlet
marginal, first-order Markov row on the current digit, and a boundary-side
(LOW/HIGH) chain — over the autocorrelation-corrected effective sample
`n_eff = n(1−ρ₁)/(1+ρ₁)`, and always acts on the posterior 95th percentile of
hazard (worst case), never the point estimate.

## Market selection — chosen AFTER the scan, never in the settings

`POST /api/bots/twin/scan` evaluates every digit-enabled market on the live
buffer: gap hazard, crossing rate & asymmetry, loss clustering ξ,
block-stationarity of the hazard series (Wilson–Hilferty χ²), the recovery
digest test with Benjamini–Hochberg screening across the whole universe, and a
10-tick block bootstrap of the real digit stream through the real round
mechanics (debt-driven recovery stakes, max steps, TP/SL) that prints
P(take-profit before stop-loss).

The console then offers the only choice this bot makes, presented the same way
as in the Match Nexus console — two stacked deploy buttons directly under the
candidate card, no separate mode toggle:

- **`Trade Locked on {market}`** (primary) — freeze the chosen market for the
  session; hazard decay warns only.
- **`Trade with Smart Market Switching`** (outline) — when the live gate stays
  shut (dry stream) or the hazard measurably decays, the engine re-scores the
  scanned universe and rotates to a market that beats the current one by ≥6
  points. **Contracts never rotate.**

A market selected from the scanned-universe list shows the same two buttons for
that market; a market the scan refuses to deploy on (below the digest line) is
explained instead. When the best market is viable but under the composite
deployment floor, the buttons become `Lock {market} anyway` /
`Start with Smart Market Switching` — the deliberate-choice pattern, the same
as the Kill-Shot family consoles.

## Recovery / staking system — the same as every other bot

One account-global ledger (`lib/agents/recovery-engine.ts`), one executing
engine at a time (arbiter owner `bots`), one debt-driven stake formula — fed
the pair's net-profit rate so its divisor becomes `m − 2`:

```
stake per leg = unrecoveredDebt · (1 + markup%) / (m_rec_min − 2)
```

A recovery win (any covered digit) applies its combined profit to the debt and
exits recovery the moment the debt clears at account precision, exactly like
the other five bots. Circuit breakers: consecutive recovery failures beyond
`maxRecoverySteps` halt the session, as does a realised loss-run deeper than
the bootstrap's p95 + 2.

## Files

- `artifacts/api-server/src/lib/twin-hedge-analysis.ts` — pure math (hazard,
  crossings, gate, digest test, bootstrap) — unit-tested in
  `twin-hedge-analysis.test.ts`.
- `artifacts/api-server/src/lib/twin-hedge-engine.ts` — session loop, bulk
  execution, ledger integration, market rotation.
- `artifacts/api-server/src/routes/bots.ts` — `/api/bots/twin/{scan,start,stop,status,contracts}`.
- `artifacts/trading-platform/src/components/twin-hedge-console.tsx` — the
  console (console contract id `twin-hedge@1`).

## Honest caveat (read this before going live)

On the canonical payout table the normal pair pays `m ≈ 1.95 < 2` per leg, so a
same-tick split round is a small STRUCTURAL tax, not a profit — the round is
ignored by design but it does not ADD money; the profitable modes of the
normal pair are the rare both-wins, and the profit engine of the bot is the
recovery pair's 8/10-digit coverage on markets that clear the 82.3% digest
line. If the live quote for BOTH normal legs pays over 2.0× (markets with a
skewed last-digit distribution do quote this), every one-winner round is
profitable and the whole design turns positive at once — the scan prints the
quoted multipliers so this is verifiable per market before you deploy. No
analysis can make a complementary pair settle off the boundary; what the
analysis does is refuse every tick where the boundary could catch both legs on
different digits. That is the honest edge of this bot: catastrophe avoidance,
not a promised win rate.
