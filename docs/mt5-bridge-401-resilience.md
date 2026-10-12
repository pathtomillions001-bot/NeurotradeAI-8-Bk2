# A 401 the server could not verify ended the MT5 link permanently

> **Partly superseded.** v3.08 removed link persistence altogether
> (`docs/mt5-bridge-session-link.md`): there is no saved link in the terminal
> and no remembered pairing code on the server, so the "one chart's unverified
> 401 disarms every chart" path in §2 no longer exists. The diagnosis below —
> an unverified refusal must never be read as a verdict — is unchanged and still
> the contract the EA and the API implement.

## What the user reported

> I attach my MT5 to any chart and after some time it detaches itself without me
> removing it from the chart, and that means we lost our connection to the Desk
> section.

```
2026.10.12 10:46:14.624  NeurotradeBridge (US100.std,H1)  HTTP 401 from /api/bridge/sync —
                         {"error":"Invalid or revoked bridge token."}
2026.10.12 10:46:14.624  NeurotradeBridge (US100.std,H1)  the Desk no longer accepts this
                         terminal's link (401). It was most likely unlinked from the Desk. …
2026.10.12 10:46:28.860  NeurotradeBridge (AAPL.m,H1)     NeurotradeBridge v3.05 attached. …
2026.10.12 10:46:30.069  NeurotradeBridge (AAPL.m,H1)     HTTP 401 from /api/bridge/pair —
                         {"error":"Unknown or expired pairing code."}
```

Nobody pressed **Unlink terminal**. The EA was still on both charts — it says so
itself in the second line, and it has no `ExpertRemove()` call and its `OnInit()`
always returns `INIT_SUCCEEDED`, so it cannot remove itself or fail to attach.
What died was the *link*, and the two 401s are the two halves of it dying
together.

---

## 1. Why one unreadable row cost both credentials

`docs/mt5-bridge-durable-link.md` moved the pairing code and the bearer token
out of process-local `Map`s and into Postgres, so a restart would re-adopt a
paired terminal instead of disconnecting it. That is still the right design. It
left one assumption unexamined: **that a failed lookup means the row is not
there.**

`loadBridgeLink()` and `loadPairingCode()` each collapsed three different
outcomes into one `null`:

| Outcome | Correct answer |
|---|---|
| the row is not there | 401 — this credential is not a link |
| the row is there but revoked | 401 — the user unlinked the terminal |
| **the store could not be asked** | **retry — nothing is known, nothing is revoked** |

The third case is not rare, and none of it is the terminal's fault:

* **The bootstrap DDL is applied after the port opens.** `app.listen()` runs
  immediately while `ddlRetryLoop()` applies `CREATE TABLE IF NOT EXISTS …` in
  the background and *retries for minutes* on a bad connection. Worse,
  `schemaReady` deliberately **resolves even when the first attempt failed**
  ("don't block routes on a dead DB"), so awaiting it proves nothing. A
  heartbeat that lands in that window reads a table that does not exist yet, the
  query throws, and the route answers "invalid token" for a token that is
  perfectly good.
* **A deploy, a crash, a scale event, a cold start** — the window where the pool
  is not up yet.
* **More than one replica.** `.replit` sets `deploymentTarget = "autoscale"`.
  Instance A issued the token; instance B has never seen it. With a shared
  Postgres B rehydrates from the row — unless B looked that token up *before*
  the row existed, because `loadBridgeLink()` also kept a **negative cache**:
  a miss was remembered as "not a link" for **60 seconds**, so B kept refusing a
  token that was valid cluster-wide for a full minute.
* **No `DATABASE_URL` at all.** Then the "database" is embedded PGlite — a file
  inside the container. `docs/railway-deploy.md` already says it plainly:
  *"PGlite on ephemeral disk loses data on restart."* Every restart, every
  second replica and every cold start forgets **both** tables at once, which is
  the only thing that explains both 401s in the same breath. `replit.md` claims
  `.replit` provisions the `postgresql-16` module; **it did not** — the file
  listed `["nodejs-20", "web", "bash"]`.

## 2. Why the terminal never came back

The server's 401 was final, and the EA (v3.05, which is where this log came
from) honoured that contract at the *lowest* level it had — inside `HttpPost()`,
which cannot possibly know whether a refusal was verified:

```mql5
// v3.05 — removed in v3.08
if(status == 401 && authenticated)
{
   g_token = "";
   g_tradingEnabled = false;
   g_savedCode = EffectivePairingCode();
   SaveLink();          // ← writes the EMPTY token over the saved link
}
```

`SaveLink()` wrote `NeurotradeBridge_<login>_<server>.link` into the terminal's
**common** folder — deliberately, so a second chart adopts the existing link
instead of pairing again. The same sharing meant one chart's unverified 401
disarmed *every* chart of that account. That is the second half of the log:
`AAPL.m` attached fourteen seconds after `US100.std` was refused, restored a link
file whose token had just been emptied by the other chart, and went straight to
`/api/bridge/pair` with the saved code — which was unreadable for the same
reason the token was, so it too came back 401, and the EA backed off to a
sixty-second loop it would never win.

v3.08 deletes that whole mechanism rather than repairing it: no link file, no
remembered code, no shared credential for one chart to wipe on another chart's
behalf. The lesson kept from this report is the one that made the wipe possible
in the first place — **an unverified refusal is not a verdict**.

**One transient server fault became a permanent disconnection that only a human
pasting a fresh code could undo.** And if the Desk was reopened in a new tab in
the meantime, the code on screen was a *new* code for a *new* session, while the
account claim was still held by the old one — so re-pairing could answer 409
"already connected in another browser" instead.

## 3. What "detaches itself" actually was

Two different things, and only one of them is a bug:

* **The link died** (§1–§2). The EA stays on the chart, sets
  `g_tradingEnabled = false`, and stops feeding the Desk — which is what the
  user sees as "detached", because the Desk says *not linked* and the EA stops
  doing anything.
* **MT5 restarted or removed the expert.** The EA never does this to itself, but
  the terminal does it for six ordinary reasons, and `OnDeinit` reported all of
  them as a bare number: `stopped (reason 4)`. Recompiling the EA in MetaEditor
  under a running chart (`REASON_RECOMPILE`, 2), changing the chart's symbol or
  timeframe (`REASON_CHARTCHANGE`, 3), editing the inputs (`REASON_PARAMETERS`,
  5), switching accounts or reconnecting after an account-settings change
  (`REASON_ACCOUNT`, 6), applying a template (`REASON_TEMPLATE`, 7), closing the
  chart (`REASON_CHARTCLOSE`, 4) or the terminal (`REASON_CLOSE`, 9) — each one
  re-inits or removes the expert, and each one *used to* look like a mystery. It
  is now named in the journal.

  One caveat worth knowing, because it is exactly this complaint: MT5 sometimes
  reports a symbol or timeframe change as `REASON_REMOVE` (1) instead of
  `REASON_CHARTCHANGE`, so "removed from the chart" in the journal is not proof
  that a person removed it. Both are now worded so neither blames the user
  wrongly.

Note what is **not** in that list: a network failure, a 401, a missing pairing
code, or a blocked `WebRequest`. None of them can remove an EA, and the file has
said so since v3.00 — which is why the removal the user saw was worth
explaining rather than merely denying.

---

## The fix

### Server — "could not check" is never a verdict

`artifacts/api-server/src/lib/multiasset/bridge-links.ts`

* Lookups return **why** they came back empty:
  `{ record, checked, health, detail }`, with `health` one of `ok`,
  `unavailable`, `error`, `not-ready`. `checked: true` means the store was
  actually consulted and its answer can be trusted.
* `storeConsultable()` refuses to answer from a store whose bootstrap DDL has
  not been applied, using a new `schemaApplied()` from `@workspace/db` — the
  honest signal, where `schemaReady` is deliberately optimistic.
* The negative cache is **not** populated when a query threw (an error says
  nothing about whether the row exists), stale entries are dropped instead of
  being re-trusted, and the window is **10 s, not 60**, because with more than
  one replica a legitimate miss must not refuse a valid token for a minute.
* `bridgeStoreReport()` says which store the process is really using
  (`postgres` / `pglite`), whether a row written now survives a restart, and
  whether the two bridge tables can be read at all.

`artifacts/api-server/src/routes/bridge.ts`

* `/sync` and `/pair` answer **503 `bridge_store_unavailable`** (with
  `retryAfterMs`) when the credential could not be verified, and revoke nothing.
* A real 401 now carries a machine-readable verdict: **`bridge_link_revoked`**
  (the user unlinked — the only final answer), **`bridge_token_unknown`**,
  **`pairing_code_unknown`**.
* `/pairing-code` and `/status` report the store, so the dialog can qualify its
  own promise instead of repeating "only Unlink ends this" to a deployment that
  cannot keep it.
* `EXPECTED_EA_VERSION` is `3.06`, and the parity test reads it from the route
  instead of pinning a second literal — the two had already drifted (the route
  said `3.04` while the EA shipped `3.05`).

`lib/db/src/index.ts` exports `databaseBackend`, `databaseIsDurable`,
`databaseDetail`, `pgliteDirectory` and `schemaApplied()`.

`artifacts/api-server/src/routes/health.ts` reports the same thing and adds
`mt5_bridge_links` / `mt5_pairing_codes` to the missing-tables check, so
`GET /api/healthz` answers "is this deployment's MT5 link durable?" in one look,
and logs a warning when it is not.

### Terminal — the credential outlives a bad answer

`artifacts/mt5-ea/NeurotradeBridge.mq5` **v3.06** (published copy republished by
`scripts/copy-mt5-ea.mjs`, parity-tested)

* `HttpPost()` **no longer touches the credential.** (In v3.08 that means
  `HttpPost()` does not even have a saved link to touch.) It publishes the status,
  the server's `error` and the server's `code`, and returns. Deciding what a
  refusal means belongs to the caller, which is the only place that knows
  whether the server verified anything.
* `Sync()` splits the 401: `bridge_link_revoked` clears the token immediately
  (a restart must not resurrect a link the user ended); anything else is
  **unverified** — the token is kept, trading stays paused, and the link is
  retried **4 times, 15 s apart** before it is abandoned in favour of the
  pairing code. `OnTimer` honours that spacing, so a 500 ms heartbeat cannot
  become a 500 ms 401 loop.
* **5xx is transient**: nothing is cleared, nothing is printed beyond a
  rate-limited line, and the next attempt waits for the server's own
  `retryAfterMs` hint (bounded to 1–60 s) instead of sending a full payload —
  quotes, candles, positions — twice a second at a service that is already
  struggling. `WarnServerOnce()` prints at most once every five minutes, so the
  journal flooding the original backoff was written to stop cannot come back
  through a different door. The server-silence budget still counts every failed
  beat, so a long outage pauses new entries on schedule.
* A confirmed heartbeat resets the refusal budget, so a *later* outage gets its
  own retries and its own single journal line.
* `OnDeinit()` names the reason (`DeinitReasonText`) and, for the six causes
  that come from the terminal rather than from a person, says plainly that
  nobody unlinked anything. (In v3.08 those reasons *end* the link on purpose —
  closing MT5 disconnects the terminal, by design. See
  `docs/mt5-bridge-session-link.md` §3.)

### Config

`.replit` provisions `postgresql-16`, as `replit.md` has always documented. On
Railway the equivalent is the Postgres service and
`DATABASE_URL = ${{Postgres.DATABASE_URL}}` (`docs/railway-deploy.md` §2, §6).

---

## What a user has to do

1. **Re-download and recompile the EA** (Desk → bridge dialog → download), then
   re-attach it. A v3.08 terminal needs a **new** pairing code — the old one is
   retired when the session that used it ends, and the dialog hands out a fresh
   one when you reload it. Until then the Desk shows *"this terminal is running
   an older EA"*, because an older terminal still wipes its link on the first
   unverified 401.
2. **Check the store is durable.** Open `/api/healthz` on the API service, or
   the bridge dialog: if it says the link store is not durable, set a
   `postgres://` `DATABASE_URL`. Without it the link still dies on every deploy
   — the EA now survives it and reconnects when the store comes back, but there
   is nothing to come back *to* if the rows themselves were never persisted.

## Proofs

| Test | What it pins |
|---|---|
| `artifacts/api-server/src/routes/mt5-bridge-session.test.ts` | (supersedes `mt5-bridge-durability.test.ts`) a store outage answers **503 and revokes nothing**, and the *same* token works again the moment the store can be read; `bridge_link_revoked` is returned only for a real revocation; an unissued token is `bridge_token_unknown`; a rotated code is still refused outright, not blamed on the store; `/status` reports the store and the session-scoped contract |
| `artifacts/trading-platform/src/lib/ea-bridge-resilience.test.ts` | `HttpPost` cannot clear the token or rewrite the link file; every `g_token = ""` in `Sync()` sits under a final verdict; the refusal budget and its spacing exist and `OnTimer` honours them; a 5xx cannot reach the "your code is dead" branch; all ten MQL5 `REASON_*` reasons are translated **by name and by value** (they are 0–9, they are not the MQL4 numbers, and there is no `DEINIT_*` family — an earlier draft of this change used it and would not have compiled); the EA still never calls `ExpertRemove()` and still returns `INIT_SUCCEEDED` |
| `artifacts/trading-platform/src/lib/ea-download-parity.test.ts` | the published download is byte-identical, and its version equals the API's `EXPECTED_EA_VERSION` (read, not pinned) |

## Files

| Path | Role |
|---|---|
| `artifacts/api-server/src/lib/multiasset/bridge-links.ts` | lookups that report *why* they failed; bounded negative cache; store report |
| `artifacts/api-server/src/routes/bridge.ts` | 503 for "could not verify", machine-readable 401 verdicts (`bridge_link_revoked` / `bridge_token_unknown` / `pairing_code_unknown` / `pairing_code_spent`), store in `/status`, `EXPECTED_EA_VERSION` 3.08 |
| `artifacts/api-server/src/routes/health.ts` | bridge tables in the missing-table check; backend/durability in `/api/healthz` |
| `lib/db/src/index.ts` | `databaseBackend`, `databaseIsDurable`, `databaseDetail`, `schemaApplied()` |
| `artifacts/mt5-ea/NeurotradeBridge.mq5` | v3.08: refusal budget, 5xx handling, revocation-only clearing, named deinit reasons, and a link that ends with the terminal |
| `artifacts/trading-platform/public/downloads/NeurotradeBridge.mq5` | the same file, republished |
| `artifacts/trading-platform/src/lib/desk.ts` | `BridgeStoreReport` and the new fields |
| `artifacts/trading-platform/src/components/terminal/bridge-dialog.tsx` | says when the link store is unreachable, and that the code lives only as long as the terminal |
| `.replit` | provisions `postgresql-16`, as documented |
