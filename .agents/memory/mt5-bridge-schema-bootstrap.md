# MT5 bridge 503 = a schema one statement short

**Symptom.** The MT5 journal, on every heartbeat:

```
HTTP 503 from /api/bridge/sync — The bridge link store could not be reached, so this
terminal's link could not be verified. Nothing was revoked — the terminal should retry.
```

**Cause.** Two defects, both in the server, neither in the EA.

1. `lib/db/src/index.ts` applied `INIT_DDL` as ONE query. `pg` uses the simple
   protocol for a parameterless query, and Postgres runs a multi-statement
   simple query in ONE implicit transaction — the first statement that fails
   rolls back everything before it and **skips everything after it**, on every
   boot, forever. Several statements are data-dependent (`CREATE UNIQUE INDEX
   … ON accounts (session_id, login_id)` over duplicate legacy rows). The MT5
   tables are created near the END of the script, so such a database never got
   `mt5_account_claims` / `mt5_bridge_links` / `mt5_pairing_codes`.
2. `bridge-links.ts` gated every read on `schemaApplied()` — a process-local
   flag about the whole script, false forever in that state. The read of a row
   that was right there was answered "the store could not be reached".

**Why it hides.** Pairing still worked from process memory (a failed INSERT is
swallowed with one warning), heartbeats were served by the in-process mirror,
and the terminal's saved token only needs the store after a restart — which is
exactly when the user sees "MT5 will not connect". The EA is right to retry a
503 (nothing was revoked), so it never falls back to pairing either.

**Where the rule lives now.** `splitSqlStatements` + `applySchemaStatements`
(statement-by-statement, connection failures still abort the pass);
`schemaFailures()` / `schemaPasses()`; `/api/healthz` → `db.schemaFailures`,
`db.schemaPasses`; bridge reads attempt the read and name a missing table.
`docs/mt5-bridge-schema-bootstrap.md` has the reproduction and the full table of
before/after answers.

**Tests.** `bridge-schema-bootstrap.test.ts` (statement-by-statement vs one
batch), `bridge-store-reads.test.ts` (flag false ≠ store unreachable; missing
table named), `mt5-bridge-session.test.ts` ("serves a link from the store while
the bootstrap flag says the schema is unfinished" — 503 before the fix).
