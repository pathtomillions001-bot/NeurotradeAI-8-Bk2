---
name: MT5 bridge 503 — the bootstrap DDL must not be all-or-nothing
description: A single failing statement in the one-shot bootstrap DDL denied the deployment every table after it, and a lookup gated on that flag answered 503 for a readable link row. Apply the script statement by statement; readiness means the required tables exist.
---

## Rule

1. `INIT_DDL` in `lib/db/src/index.ts` is applied **one statement at a time**
   (`splitSqlStatements()` + `applyDdlStatements()`). Never go back to
   `pool.query(INIT_DDL)`.
2. `schemaApplied()` / readiness means **"the tables in `REQUIRED_TABLES` exist"**,
   never "the script returned without throwing".
3. A lookup must never refuse to read a stored row because of a *schema* flag.
   `storeConsultable()` only checks that a pool exists; a genuinely missing table
   fails truthfully (query throws → `checked: false` → retryable 503, nothing revoked).

**Why:** Postgres runs a multi-statement simple query in ONE implicit
transaction (`pg` uses the simple protocol when there are no values). The first
statement that fails rolls back everything before it and silently skips
everything after it — so a data-dependent failure (e.g.
`CREATE UNIQUE INDEX accounts_session_login_unique` over duplicate legacy rows)
happens on every boot, forever, and `schemaApplied()` was false forever with it.
`storeConsultable()` answered that flag as *"the bridge link store could not be
reached"*, so a terminal whose link row was readable and un-revoked got
`HTTP 503 … schema bootstrap has not been applied yet` on every heartbeat, and
could never come back after an API restart. Reproduced end to end against a real
Postgres and fixed; `artifacts/api-server/src/lib/bridge-store-readiness.test.ts`
pins both halves.

**How to apply:**
- A connection-level failure (SQLSTATE 08xxx / 57P0x / 53300 / 40001, ECONN*,
  pool timeouts) still aborts the pass, so `ddlRetryLoop()`'s back-off and retry
  for a dead database are unchanged.
- A statement that fails is logged once per process
  (`[db] DDL statement N failed — continuing with the rest of the schema: …`)
  and the schema continues. Do not "fix" this by deleting user rows to make an
  index creatable — report it instead.
- `bridgeStoreReport()` / `/api/healthz` still *report* `schemaApplied`; that is
  diagnostics, not a gate.
- See `docs/mt5-bridge-bootstrap-readiness.md` for the reproduction and proof.
