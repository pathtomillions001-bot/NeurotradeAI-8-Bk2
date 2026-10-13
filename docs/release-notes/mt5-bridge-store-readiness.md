# The link store stops refusing a readable store

**Symptom, from a live MT5 journal (2026-10-13 23:03–23:17):**

```
NeurotradeBridge: HTTP 503 from /api/bridge/sync — The bridge link store could
not be reached, so this terminal's link could not be verified. Nothing was
revoked — the terminal should retry.. Nothing was revoked; this terminal's
token is kept and will be retried.
```

…repeating every few minutes on a terminal whose link row was in the database
the whole time, while the Desk itself worked normally. The owner's rule for this
link is that it ends in **exactly two** ways — the user unlinks it in the Desk,
or the user closes MT5 — so a server that cannot verify a live terminal is a
broken server, not a broken link.

## Root cause

Two faults, one visible as the other:

**1. The bootstrap DDL was applied as a single query.** `applySchemaDdl()` sent
the whole `INIT_DDL` script in one `query()`/`exec()`. Postgres runs a
multi-statement simple query inside an implicit transaction, so the **first**
statement that fails rolls back everything before it *and* skips everything
after it. On a database where one statement can never succeed, that failure
repeats on every boot:

* everything the script still had to create — missing tables, and columns such
  as `mt5_bridge_links.code` — was never created;
* `ddlSucceeded` could never be set, so `schemaApplied()` was false **forever**.

The trigger is data-dependent, which is why it never showed up on a fresh
database: a `CREATE UNIQUE INDEX` over legacy rows that duplicate each other.
Reproduced locally with two `accounts` rows sharing
`(session_id='legacy', login_id='VRTC90210')`:

```
OLD batch THREW: could not create unique index "accounts_session_login_unique"
OLD batch result -> mt5_bridge_links: null | settings: null
```

Not one table survives the batch. Meanwhile the rest of the app is fine — its
tables exist from an earlier deploy — which is exactly why the fault stayed
invisible until it reached the one caller that gated on the flag.

**2. The bridge lookup gated on that flag.** `storeConsultable()` returned
`not-ready` — "schema bootstrap has not been applied yet" — while
`schemaApplied()` was false, without ever trying the read. So a statement about
the *schema* was answered as a statement about the *store*, and every `/sync`
that could not be served from the in-process mirror (i.e. every beat after a
redeploy, a restart, or from a second chart) became
`503 bridge_store_unavailable`. The terminal kept its credential and retried
into a wall that never moved.

## The fix

| File | Change |
|---|---|
| `lib/db/src/index.ts` | `splitSqlStatements()` + `bootstrapDdlStatements()`; `applySchemaDdl()` now applies **one statement at a time**, reports each failure once and continues, and readies the schema on **"the tables this API needs exist"** (`requiredTablesPresent()`) instead of "the script returned without throwing". A connection-level failure still aborts the attempt so the retry loop backs off as before. |
| `artifacts/api-server/src/lib/multiasset/bridge-links.ts` | `storeConsultable()` no longer consults `schemaApplied()`. The read is the authority; a genuinely missing table fails truthfully (`checked: false` → `503`, nothing revoked). The flag stays in `bridgeStoreReport()` for `/api/healthz` and the Desk's diagnostics. |
| `artifacts/api-server/src/lib/bridge-store-bootstrap.test.ts` | New regression test: the splitter never cuts a statement in half, the real script applied per statement leaves every required table, and a poisoned statement costs only itself — with the old single-query behaviour pinned in the same test as the failure being fixed. |
| `artifacts/api-server/package.json` | Runs the new test in the API suite. |

Nothing else moves: the pairing-code contract, the two endings, the 401 verdicts
(`bridge_link_revoked` / `bridge_token_unknown` / `pairing_code_unknown` /
`pairing_code_spent`), the `503` wording and `retryAfterMs`, the Desk dialog and
the EA (v3.09, unchanged) all behave exactly as documented in
`docs/mt5-bridge-link-lifetime.md`. A terminal already holding a token keeps it:
no re-pairing, no new code, no EA recompile.

## Proof

Local replay of the deployed state — duplicate `accounts` rows so one DDL
statement can never succeed:

| Step | Before | After |
|---|---|---|
| Whole script as one query | `could not create unique index "accounts_session_login_unique"`; `mt5_bridge_links` and `settings` both `null` | — |
| Per-statement bootstrap | (flag stuck false) | the failing statement is logged once, the rest of the schema applies, `schemaApplied: true`, `tablesMissing: []` |
| `/api/bridge/sync`, cold process, saved token | **503 on every beat** | **200 in 24 ms** — the Desk re-attaches the live terminal |

Test suites: the new bootstrap test plus `mt5-bridge-session`, `mt5-account-claims`,
`multiasset/store` and `multiasset/claims` all pass; `pnpm run typecheck:libs`
and the API typecheck are clean.

## What to expect in production

This is a server-side fix only — the API service has to be redeployed; the
terminal does nothing. After the redeploy, the first boot applies the script
statement by statement, so any table or column that the aborted batch had been
denying the deployment is created there and then, and the 15 s housekeeping
timer keeps it that way. If the log still shows a statement failing (now: one
`[db] DDL statement failed — continuing with the rest of the schema: …` line
naming it), the rest of the schema — and the bridge — is unaffected; the named
statement is the one to look at on its own.

The heartbeat-latency warnings in the same journal ("heartbeat took 1.7–3.4 s —
payload build or server response was slow") are a separate, EA-side measurement
of the whole beat including building the quote payload; they are not caused by
this path (a local beat against the same endpoint answers in 4–24 ms) and are
untouched here.
