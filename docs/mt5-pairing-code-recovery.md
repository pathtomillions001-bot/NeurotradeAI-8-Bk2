# MT5 pairing-code failure: findings and recovery

## Investigation and evidence

PR [#156](https://github.com/pathtomillions001-bot/NeurotradeAI-8-Bk2/pull/156) introduced hashed, durable pairing credentials in `mt5_bridge_links`. The Desk's `POST /api/bridge/pairing-code` route does not return a code until `createPairingCode()` has inserted its hash in that table.

### Confirmed defects and reproductions

- The pre-fix `schemaReady` promise resolved after the **first failed** DDL attempt even though a retry loop continued in the background. `bootstrapDb()` could therefore proceed against an unavailable or incomplete database, and requests were not reliably held until schema creation actually succeeded.
- The pairing route had no local error handler. A rejected durable `INSERT` fell through to Express's default error response.
- The old dialog did not render the mutation error or provide a Retry action. With no code and no pending request it displayed “Try again shortly.”
- Before making changes, a healthy local PGlite-backed `POST /api/bridge/pairing-code` returned HTTP 200 with a nonempty code. With a controlled, connection-refused PostgreSQL endpoint, the pre-fix API logged the failed `INSERT INTO mt5_bridge_links` and returned HTTP 500 with an HTML stack trace. This reproduces the failure path; it is **not production telemetry**.
- After the fix, a healthy local PGlite-backed API reports `db.ok: true`, `tablesMissing: []`, `columnsMissing: []`, and a ready schema; pairing returns HTTP 200. With the same controlled database outage, the API now keeps schema readiness false and returns a structured HTTP 503 instead of attempting the write and returning HTML 500. The API continues its bounded-backoff DDL retry.

### What could not be confirmed about production

No production URL, API/database telemetry, deployment SHA, or GitHub production deployment record was available in this checkout. The local frontend and API source are from the same checkout, but both local release SHAs report `unknown`; that does **not** verify the deployed services are aligned. The exact production HTTP status/body and whether its table was absent, partially migrated, or unreachable remain unverified.

The production hypotheses consistent with the confirmed code path are a database outage during bootstrap or a missing/incomplete `mt5_bridge_links` table/column. A frontend/API release mismatch is also possible but was not established. Check the live health endpoints below before attributing the incident to one of these.

## Changes in this fix

- Schema readiness now resolves only after the full idempotent DDL succeeds. Failed attempts retain a safe SQLSTATE/driver code in diagnostics and retry with backoff; raw database messages and connection strings are not exposed.
- Pairing-table repair is additive (`CREATE TABLE IF NOT EXISTS`, `ALTER ... ADD COLUMN IF NOT EXISTS`, and uniqueness indexes). It does not delete/rewrite pairing credentials, terminal settings, account claims, or other user data. A duplicate uniqueness conflict fails closed rather than deleting rows.
- Normal API requests wait for bootstrap only up to a deadline and receive a safe structured 503 while the schema is unavailable. `/api/healthz` remains available to diagnose recovery.
- `GET /api/healthz` now reports the MT5 pairing table, required columns, schema retry state, and whether storage is actually external PostgreSQL.
- `POST /api/bridge/pairing-code` catches storage failures, logs a request ID plus a safe error code/stage (never the code/token/DB URL), and returns a structured retryable error.
- The Desk validates that a 2xx response contains a nonempty `pairingCode`. Its dialog has explicit loading, saved-code and actionable error states with a Retry button. It makes one automatic request per dialog opening cycle; status polling and reopening after an error do not rotate the code. Retry is user-triggered and shown only when no code is displayed.

Durable hashed storage, browser/account scoping, single-account claims, explicit-unlink revocation, EA token handling, and trading/risk/news/freshness gates are unchanged. No in-memory credential fallback was added.

## Deployment and verification

1. Deploy the API and web services from the **same commit**. Keep production on durable Postgres; do not reset the database, drop `mt5_bridge_links`, clear claims, or run a destructive credential migration. The embedded DDL will retry and apply safe additive changes.
2. Check the public API `GET /api/healthz`. Confirm:
   - `db.ok` is `true`;
   - `db.tablesMissing` and `db.columnsMissing` are empty;
   - `db.schemaReadiness.ready` is `true` (and no unresolved retry state remains).
3. Compare `release.sha` from `/api/healthz` with `web.sha` from the web service's `/__release` report, or `sha` from `/release.json`. From a checkout containing the intended web build, `corepack pnpm --filter @workspace/trading-platform check:release https://<web-domain>` also verifies deployed release/asset alignment. If releases differ, redeploy the matching web/API pair before diagnosing the client response.
4. If health reports the schema is not ready, use the API log's request ID and safe failure code to diagnose the database. The service retries automatically; pairing requests return 503 until storage is ready. Do not delete existing rows to make the check pass.
5. Open **Desk → Link MT5**. Wait for “Code saved,” copy the displayed code, and paste that exact code in the EA. If an error appears, use Retry only when ready to use the newly displayed code; use the newest code after a successful retry.
6. Verify pairing on a demo MT5 account, then test explicit unlink and confirm it revokes the credential/releases the account claim. Keep existing trading consents, risk limits, quote/news gates, and live-account protections enabled.

## Regression coverage

The added tests cover failed schema initialization followed by recovery, bounded readiness timeouts and safe diagnostics, failed durable writes with explicit retry and successful persistence, hashed storage, malformed 2xx responses, loading/success/error UI states, and the one-shot auto-request rule. The existing MT5 account-claim/bridge suite continues to cover durable pairing, account isolation, restart persistence, and explicit revocation.
