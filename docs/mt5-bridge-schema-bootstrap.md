# Why MT5 could not connect to the Desk: a schema that was one statement short

## The report

The terminal, on every heartbeat:

```
NeurotradeBridge: HTTP 503 from /api/bridge/sync — The bridge link store could not
be reached, so this terminal's link could not be verified. Nothing was revoked —
the terminal should retry.
```

The EA's half of this is correct and was left alone: a 503 revokes nothing, so it
keeps its token and retries. That is why this failure looks like a terminal that
is "just not connecting" — it never gives up, and it never re-pairs either,
because the pairing code is not the credential the Desk refused.

## What it was NOT

The link store was up. The database answered queries, the MT5 tables existed on
a healthy deploy, and `SELECT … FROM mt5_bridge_links WHERE token_hash = $1`
returned the terminal's row with `revoked_at_ms IS NULL`. The sentence "the
bridge link store could not be reached" was true about the *server's* opinion,
not about the *store*.

## The two defects

### 1. One failing statement silently disabled every statement after it

`lib/db/src/index.ts` applied the whole bootstrap script as **one query**:

```ts
await poolInstance.query(INIT_DDL);      // external Postgres
await pgliteInstance!.exec(INIT_DDL);    // embedded PGlite
```

`pg` sends a parameterless query over the **simple protocol**, and Postgres runs
a multi-statement simple query in **one implicit transaction**. So the first
statement that fails rolls back everything before it *and skips everything after
it* — on every boot, on the same database, forever.

Several statements in that script are **data-dependent**:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS accounts_session_login_unique ON accounts (session_id, login_id);
CREATE UNIQUE INDEX IF NOT EXISTS session_links_kind_key         ON session_links (kind, key);
CREATE UNIQUE INDEX IF NOT EXISTS market_win_rates_key           ON market_win_rates (session_id, symbol, contract_type, barrier);
CREATE UNIQUE INDEX IF NOT EXISTS deriv_journal_unique           ON deriv_journal (session_id, account_id, transaction_id);
```

A database that already holds rows which duplicate each other under one of those
keys can never build that index, and no amount of retrying will change that. The
MT5 bridge's own tables sit near the **end** of the script
(`mt5_account_claims` → `mt5_bridge_links` → `mt5_pairing_codes`), so on such a
database they were never created at all.

Reproduced against Postgres (PGlite, same engine) with a legacy duplicate pair:

```
--- boot: `pool.query(INIT_DDL)` (what the API did) ---
THREW: could not create unique index "accounts_session_login_unique"
mt5_bridge_links present after the batch: 0
session_links (created AFTER the failing statement) exists: 0   <- the batch SKIPPED it
  -> a second boot repeats this, forever

--- boot: statement by statement (the fix) ---
  statement failed (carrying on): could not create unique index "accounts_session_login_unique"
statements: 68, failed: 1
mt5_bridge_links present after statement-by-statement pass: 1
session_links present after statement-by-statement pass: 1
```

### 2. A link lookup was gated on that script's flag

`bridge-links.ts` refused to read the store while `schemaApplied()` was false:

```ts
if (typeof mod.schemaApplied === "function" && !mod.schemaApplied()) {
  return { ok: false, detail: "schema bootstrap has not been applied yet" };
}
```

`schemaApplied()` is a **process-local opinion about a whole script**. With
defect 1 in place it could never become true, so a *schema* problem was reported
as an unreadable *store* — for a row that was readable the entire time. The
in-process mirror hid it until the API restarted, which is exactly when a
terminal that saved its link needs the store.

## Why it looked fine until it didn't

1. `POST /api/bridge/pairing-code` answered 200 — the code was kept in process
   memory (`savePairingCode` swallows a failed INSERT with a single warning).
2. The EA paired, received a token, and saved it (v3.09 keeps it per account).
3. Heartbeats were served from the in-process mirror: 200, healthy Desk.
4. The API restarted (deploy, cold start, second replica).
5. The terminal presented the token it had saved. This process had never seen
   it, so the lookup had to go to the store — and the gate refused to look.
6. 503 on every beat, forever. The EA does the right thing with a 503 (keep the
   credential, retry), so it never fell back to pairing either.

## The fix

| File | Change |
|---|---|
| `lib/db/src/index.ts` | `splitSqlStatements()` + `applySchemaStatements()` apply the script **one statement at a time**. A statement that cannot apply is reported (clipped statement + SQLSTATE + message) and the rest of the script still runs. A **connection**-level failure still aborts the pass, so the existing back-off/retry handles a dead database. `schemaFailures()` / `schemaPasses()` expose the outcome; `schemaApplied()` now means "a pass ran to the end", and says so in its doc comment. |
| `artifacts/api-server/src/lib/multiasset/bridge-links.ts` | Reads **attempt the read**. `storeConsultable()` (the flag gate) is gone. `checked: false` is reserved for a missing pool or a query that did not run. A table that genuinely does not exist answers `health: "not-ready"` **with the table's name**, instead of blaming the connection. `BridgeStoreReport` carries `schemaFailures`. |
| `artifacts/api-server/src/routes/health.ts` | `/api/healthz` reports `db.schemaFailures` and `db.schemaPasses` next to `tablesMissing`, and logs a warning when the script ran short. |

No EA change is needed: the contract the terminal implements (503 = retry,
nothing revoked; 401 with `bridge_link_revoked` = final) is unchanged.

### What each side now answers

| Situation | Old answer | New answer |
|---|---|---|
| Row exists, script ran short | `503 bridge_store_unavailable` (forever) | `200` — the row is served |
| Row does not exist, script ran short | `503` (forever) | `401 bridge_token_unknown` — a verdict the EA can act on |
| Table genuinely missing | `503` "store could not be reached" | `503 … not-ready`, detail names the table and the DDL |
| Store really unreachable (no pool, query failed) | `503` | `503` (unchanged — this is the case it was written for) |

## Verifying on a deployment

```bash
curl -s https://<api-host>/api/healthz | python3 -m json.tool | sed -n '/"db"/,/}/p'
```

Health looks like `"schemaFailures": []` and `tablesMissing: []`. A degraded
schema says so by name — e.g.

```json
{
  "ok": true,
  "tablesMissing": [],
  "schemaApplied": true,
  "schemaPasses": 2,
  "schemaFailures": [
    {
      "statement": "CREATE UNIQUE INDEX IF NOT EXISTS accounts_session_login_unique ON accounts (session_id, login_id)",
      "message": "could not create unique index \"accounts_session_login_unique\"",
      "code": "23505"
    }
  ]
}
```

`db.ok: true` with a populated `schemaFailures` is a schema with one statement
missing — the bridge tables exist, the MT5 link works, and the operator knows
which statement to resolve (here: the duplicate `(session_id, login_id)` rows in
`accounts`).

After deploying the fix to a database that was short, the bridge tables are
created by the next bootstrap pass. A terminal whose saved token predates the
fix has no row in the store (the INSERT that would have written it failed
silently on the old code), so its first beats answer `401 bridge_token_unknown`;
the EA tolerates four of those and then falls back to its saved pairing code. If
that code was also minted before the fix it is not in the store either, and the
Desk will ask for a NEW code once — after that, links persist. The journal says
which of those it is (`pairing_code_unknown` vs an accepted re-pair).

## Where to look when a terminal will not connect

1. `/api/healthz` → `db.tablesMissing`, `db.schemaFailures`, `db.durable`.
2. The API log: `[db] bootstrap statement NOT applied …` (once per distinct
   failure) and `[db] bootstrap pass N ran to the end, but …`.
3. The MT5 journal: `503` (server could not check — look above),
   `401 bridge_token_unknown` (this store has no such link), `401
   bridge_link_revoked` (the user unlinked it), `401 pairing_code_spent`.

## Tests that pin this

- `artifacts/api-server/src/lib/multiasset/bridge-schema-bootstrap.test.ts` —
  the script applied statement by statement creates the bridge tables on a
  database where an unrelated statement cannot apply; the same script as ONE
  batch still loses them (so going back to a single query fails here first); a
  connection failure still aborts the pass; the splitter never splits inside a
  literal, comment or dollar-quoted block.
- `artifacts/api-server/src/lib/multiasset/bridge-store-reads.test.ts` — a link
  row is served while the schema flag is false; a missing table is *named*; a
  store that truly cannot answer still says "retry, nothing revoked".
- `artifacts/api-server/src/routes/mt5-bridge-session.test.ts` — route level:
  `/sync` answers `200` (not `503`) from the store while the flag is false, and
  still answers `401` when the row really is absent.
