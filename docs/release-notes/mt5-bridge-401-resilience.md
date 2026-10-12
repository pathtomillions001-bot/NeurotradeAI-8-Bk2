# Fix: the MT5 terminal lost its Desk link by itself (401 on sync, then 401 on pair)

## Problem

A paired terminal stopped feeding the Desk with nobody having pressed **Unlink
terminal**, and the MT5 journal showed both credentials dying together:

```
HTTP 401 from /api/bridge/sync — {"error":"Invalid or revoked bridge token."}
HTTP 401 from /api/bridge/pair — {"error":"Unknown or expired pairing code."}
```

It was reported as "the EA detaches itself from the chart after some time". The
EA was still attached — it has no `ExpertRemove()` call and its `OnInit()` always
returns `INIT_SUCCEEDED` — but it had stopped trading and the Desk said *not
linked*, which looks exactly like a detachment from the chart.

## Root cause

Two defects, one on each side of the wire.

**The server answered 401 for "I could not check".** `loadBridgeLink()` and
`loadPairingCode()` returned `null` for three different situations: the row is
not there, the row is revoked, and **the store could not be read**. The third one
happens on every deploy, on a database failover, while the bootstrap DDL is still
being applied in the background (the HTTP port opens first, and `schemaReady`
resolves even when the DDL *failed*), and on any replica that has not seen a row
another replica wrote — which was then remembered as "not a link" for 60 seconds
by a negative cache.

**The EA treated every 401 as final, and did it in the wrong place.**
`HttpPost()` — the lowest level, which cannot know whether a refusal was verified
— emptied `g_token` and called `SaveLink()`, writing that empty token over
`NeurotradeBridge_<login>_<server>.link` in the terminal's **common** folder.
That file is shared by every chart of the account on purpose, so one chart's bad
answer disarmed all of them. The EA then fell back to its pairing code, which was
unreadable for the same reason the token was, and settled into a sixty-second
loop it could never win.

A few seconds of unreadable database therefore ended a link permanently, and only
a human pasting a fresh code could restore it. Where the deployment had no
`postgres://` `DATABASE_URL` at all, the store was embedded PGlite — a file inside
the container — so both tables were wiped on every restart and this happened on
schedule. `replit.md` documented the `postgresql-16` module as provisioned;
`.replit` did not list it.

## Fix

**Server.** Link lookups now report *why* they came back empty
(`{ record, checked, health, detail }`). `/api/bridge/sync` and
`/api/bridge/pair` answer **503 `bridge_store_unavailable`** with a
`retryAfterMs` when a credential could not be verified, and revoke nothing. A
real 401 carries a verdict the terminal can act on: **`bridge_link_revoked`**
(the user unlinked — the only final answer), **`bridge_token_unknown`**,
**`pairing_code_unknown`**. The negative cache is no longer populated by a query
that threw, stale entries are dropped rather than re-trusted, and its window is
10 s instead of 60. `storeConsultable()` refuses to answer from a store whose DDL
has not been applied, using a new `schemaApplied()` from `@workspace/db`.

**Visible.** `/api/healthz` now reports `db.backend`, `db.durable`, `db.detail`
and checks that `mt5_bridge_links` / `mt5_pairing_codes` exist; `/api/bridge/status`
and `/api/bridge/pairing-code` carry the same report, and the bridge dialog says
outright when the link store is not durable or cannot be reached, instead of
promising "only Unlink ends this" to a deployment that cannot keep it.

**Terminal — EA v3.06.** `HttpPost()` no longer touches the saved link; it
publishes the status, the error and the server's `code`. `Sync()` splits the 401:
a revocation clears the token at once (so a restart cannot resurrect a link the
user ended), anything else is unverified — the token is **kept** and retried four
times, fifteen seconds apart, before it is abandoned in favour of the pairing
code, and `OnTimer` honours that spacing so a 500 ms heartbeat cannot become a
500 ms 401 loop. **5xx is transient**: nothing is cleared, the next
attempt waits for the server's `retryAfterMs` hint rather than beating a
struggling service twice a second, and `WarnServerOnce()` prints at most one line
every five minutes so a rolling deploy cannot refill the journal. The
server-silence budget still counts every failed beat, so a long outage pauses new
entries on schedule. A confirmed heartbeat resets the budget, so a later outage gets its own
retries.

**"It detached itself" is now answered.** `OnDeinit()` named the reason as a bare
number (`stopped (reason 4)`). It now translates all ten MQL5 `REASON_*` codes —
recompiled, chart symbol or timeframe changed, inputs changed, another account
activated, template applied, chart closed, terminal closed, init failed — and for
the six that come from the terminal rather than from a person it says plainly
that nobody unlinked anything and that the saved link resumes on the next start.

**Config.** `.replit` provisions `postgresql-16`, matching `replit.md`. On
Railway the equivalent is the Postgres service plus
`DATABASE_URL = ${{Postgres.DATABASE_URL}}`.

**Version.** `EXPECTED_EA_VERSION` is `3.06`, and the parity test now reads that
constant from the route instead of pinning a second literal — the two had already
drifted (`3.04` in the route against a `3.05` EA).

## What users must do

1. **Re-download, recompile and re-attach the EA** (Desk → bridge dialog →
   download). The saved link resumes by itself; no new pairing code is needed.
   Until then the Desk shows *"this terminal is running an older EA"*, because a
   v3.05 terminal still wipes its link on the first unverified 401.
2. **Check `/api/healthz`** (or the bridge dialog). If it reports a non-durable
   store, set a `postgres://` `DATABASE_URL` — otherwise the rows themselves
   still vanish on every deploy, and there is nothing for the terminal to
   reconnect to.

## Proofs

* `artifacts/api-server/src/routes/mt5-bridge-durability.test.ts` — a simulated
  store outage answers 503 and revokes nothing, and the **same** token and the
  **same** code work again the moment the store can be read; `bridge_link_revoked`
  appears only for a real revocation; an unissued token is `bridge_token_unknown`;
  a rotated code is still refused outright rather than blamed on the store.
* `artifacts/trading-platform/src/lib/ea-bridge-resilience.test.ts` — `HttpPost`
  cannot clear the token or rewrite the link file; every `g_token = ""` in `Sync()`
  sits under a final verdict; the refusal budget and its spacing exist and
  `OnTimer` honours them; a 5xx cannot reach the "your code is dead" branch; all
  ten `REASON_*` reasons are translated, **by name and by value** (MQL5's are
  0–9 and are not the MQL4 numbers; the `DEINIT_*` spelling that an earlier draft
  of this change used does not exist and would not have compiled), and the EA
  still never removes itself.
* `artifacts/trading-platform/src/lib/ea-download-parity.test.ts` — the published
  download is byte-identical and its version equals the API's expectation.

Full analysis: `docs/mt5-bridge-401-resilience.md`.
