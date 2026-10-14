# The bootstrap script is not allowed to be all-or-nothing

> **Why the MT5 EA was refused with `HTTP 503 … The bridge link store could not
> be reached` on every heartbeat** while its link row sat in the database,
> readable and un-revoked — and what was changed so that a single statement the
> data will not accept can no longer take a deployment's schema with it.

## What the user reported

```
2026.10.13 23:03:15  NeurotradeBridge (BCHUSD.m,M5)  resuming the saved link for account 2001244359@JustMarkets-Demo …
2026.10.13 23:03:16  NeurotradeBridge (BCHUSD.m,M5)  HTTP 503 from /api/bridge/sync — The bridge link store could
                                                     not be reached, so this terminal's link could not be verified.
                                                     Nothing was revoked — the terminal should retry.
```

…repeating for as long as the terminal stayed open. The EA behaved correctly at
every step (v3.09 keeps its token through a 5xx and retries on the server's own
`retryAfterMs`); it was the server that could not answer.

Per the link contract (`docs/mt5-bridge-link-lifetime.md`) a link ends in exactly
two ways — the user unlinks it in the Desk, or the user closes MT5. A server that
cannot verify a live terminal is a broken **server**, not a broken link.

## Root cause (reproduced end to end)

Two independent defects, and they had to be fixed together.

### 1. One failing statement silently disabled every statement after it

`lib/db/src/index.ts` applied `INIT_DDL` as **one** query:

```ts
await poolInstance.query(INIT_DDL);   // 68 statements in a single string
```

`pg` sends a parameterless query with the simple protocol
(`Query.prototype.requiresPreparation()` is false when there are no values), and
Postgres runs a multi-statement simple query in **one implicit transaction**.
The first statement that fails therefore rolls back everything before it — and
**skips everything after it**. A data-dependent failure, such as

```
CREATE UNIQUE INDEX IF NOT EXISTS accounts_session_login_unique ON accounts (session_id, login_id)
```

over legacy rows that duplicate each other, then happens on **every boot, on the
same database, forever**. Reproduced locally against a real Postgres:

```
boot #1 (clean DB): whole batch applied, all tables exist
dropped the index over accounts and inserted two identical (session_id, login_id) rows
--- boot #2: whole batch as ONE query ---
  THREW: could not create unique index "accounts_session_login_unique"
  zzz_marker_introduced_later: null   <- statements after the failure are SKIPPED
  mt5_bridge_links (created by an earlier boot): mt5_bridge_links
--- boot #3 ---
  THREW again: could not create unique index "accounts_session_login_unique"
```

Note the third line of the marker check: the tables an **earlier** deploy created
are still there (except for the bridge's, which sit later in the script). That is
why the app looked healthy while the schema was not — and why the one caller that
asked "was the script applied?" was answered *no* for months.

### 2. A read was gated on that flag, so "unknown schema" was reported as "unreadable store"

`artifacts/api-server/src/lib/multiasset/bridge-links.ts`:

```ts
if (typeof mod.schemaApplied === "function" && !mod.schemaApplied()) {
  return { ok: false, detail: "schema bootstrap has not been applied yet" };
}
```

`storeConsultable()` consulted a **global bootstrap flag** before reading
anything. With defect 1 in place the flag could never become true, so every
lookup — including one whose row was readable the whole time — was answered:

```
HTTP 503 {"code":"bridge_store_unavailable","storeHealth":"not-ready",
          "detail":"schema bootstrap has not been applied yet","retryAfterMs":5000}
```

byte-for-byte the line in the user's MT5 journal, produced against a database
where `SELECT … FROM mt5_bridge_links WHERE token_hash = $1` returned the
terminal's row with `revoked_at_ms = NULL`.

The in-process mirror hid this until the API restarted — and a restart (redeploy,
cold start, scale event) is exactly when a terminal that saved its link needs the
store.

## The fix

| File | Change |
|---|---|
| `lib/db/src/index.ts` | `splitSqlStatements()` applies `INIT_DDL` **one statement at a time**, reporting each failure once and carrying on. A **connection**-level failure still aborts the pass, so the existing back-off/recovery for a dead database is unchanged. `REQUIRED_TABLES` + `requiredTablesPresent()` make readiness mean *"the tables this API needs exist"* — not *"the script returned without throwing"*. |
| `artifacts/api-server/src/lib/multiasset/bridge-links.ts` | `storeConsultable()` no longer consults `schemaApplied()`. The read is the authority: a table that really is missing fails truthfully (`checked: false` with the real error → the same retryable 503, nothing revoked). The flag is still **reported** by `bridgeStoreReport()`/`/api/healthz` for diagnostics. |
| `artifacts/api-server/src/lib/bridge-store-readiness.test.ts` | New regression test (see below). |

**Nothing else moves.** The two endings, the pairing-code semantics, the 401
verdicts (`bridge_link_revoked` / `bridge_token_unknown` / `pairing_code_unknown`
/ `pairing_code_spent`), the 503 body and `retryAfterMs`, the Desk dialog and
**EA v3.09 — no recompile, no re-pairing** — are untouched.

### Why not just drop the gate?

Because the deployment would still be missing whatever the aborted batch never
reached. Verified: with the same duplicate rows and the bridge's own tables
dropped, the statement-by-statement bootstrap creates them, and only the poisoned
`CREATE UNIQUE INDEX` is reported:

```
[db] DDL statement 5 failed — continuing with the rest of the schema: could not create unique index "accounts_session_login_unique"
     CREATE UNIQUE INDEX IF NOT EXISTS accounts_session_login_unique ON accounts (session_id, login_id)
[db] Initial DDL applied
[db] 1 of 68 DDL statement(s) could not be applied to the existing data — every table this API needs is present anyway
```

The duplicate rows themselves are **not** deleted: the failed index is a fact
about the user's data, the log now names it precisely, and the rest of the schema
— including the entire bridge — is unaffected.

## Proof

Replay of the deployed state, real Postgres, the app's own code path:

| Step | Before | After |
|---|---|---|
| Whole script as one query | throws; statements after it skipped (marker table `null`) | — |
| Statement-by-statement bootstrap | flag false forever; bridge tables never created | failing statement logged once, rest applies, `schemaApplied: true`, `tablesMissing: []` |
| `/api/bridge/sync`, **cold** process, link row present, DDL poisoned | **503** `bridge_store_unavailable` / `not-ready` / `schema bootstrap has not been applied yet` | **200 in 14 ms** |
| Desk `/api/bridge/status` (the dialog's own view) | `linked: false` | `linked: true`, `2001244359@JustMarkets-Demo`, `stale: false`, store `durable: true, reachable: true` |
| Regression test `bridge-store-readiness.test.ts` | — | 4/4 pass |
| Full API suite | — | **1260 tests / 154 suites, 0 fail** |
| `pnpm run typecheck` (libs + all artifacts) | — | clean |

The new test pins both properties that failed here: **(a)** a statement the data
will not accept cannot hide the statements after it (the real script is split,
one statement is poisoned, and the test asserts `mt5_bridge_links` was still
created and `requiredTablesPresent()` is true), and **(b)** the store is *read*
afterwards — a cold process finds the terminal's row with `checked: true`.

## What the user has to do

**Nothing on the terminal.** This is server-side: redeploy the API service. The
next boot applies the script statement by statement, so anything the aborted
batch had been denying the deployment — including the bridge's tables — is
created there and then, and the terminal reconnects on the link it already holds.

If a statement still cannot be applied it is now one line in the log
(`[db] DDL statement N failed — continuing with the rest of the schema: …`) plus
a one-line summary, instead of the whole schema being reported as unapplied.

## Files

| Path | Role |
|---|---|
| `lib/db/src/index.ts` | `splitSqlStatements()`, `applyDdlStatements()`, `REQUIRED_TABLES`, `requiredTablesPresent()`; readiness = required tables present |
| `artifacts/api-server/src/lib/multiasset/bridge-links.ts` | `storeConsultable()` reads without the schema gate |
| `artifacts/api-server/src/lib/bridge-store-readiness.test.ts` | the regression test |
| `artifacts/api-server/src/routes/health.ts` | unchanged — already reports `tablesMissing` / `schemaApplied` / durability |
