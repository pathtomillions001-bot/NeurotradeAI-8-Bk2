# MT5 sync 503: persistence and lifetime fixes (2026-10-14)

## What the terminal log establishes

`HTTP 503 ... bridge link store could not be reached` is emitted by the API
when a bearer-token lookup cannot consult its store (schema not applied, pool
unavailable, or query failure). It is not an MT5 WebRequest allowlist failure:
the request reached our route. Recompile/timeframe-change messages are normal
MT5 EA lifecycle events. The other EA's CRTWhisperer messages are unrelated.

The log does **not** establish which production database failure occurred.
Inspect the API's matching structured warning (`health`, `detail`, `what`) and
DDL retry logs. The HTTP body already contains `storeHealth` and `detail`.
Do not infer "bad pairing code" or clear a token from a 503. The 1.5–3.4 second
heartbeat warnings indicate latency, not revocation; freshness gates must stay.

## Reproduced application defects and fixes

1. **Acknowledged but unsaved credentials.** Code/link writes swallowed database
   errors after publishing an in-process mirror. `/pair` could answer 201 even
   though a redeploy/another instance could not recover its token. Now new
   credentials require an acknowledged database write. Code redemption and
   token insertion are one atomic PostgreSQL statement. Failure returns a
   retryable 503, does not consume the code, and does not replace an existing
   Desk or release its original account claim. The EA retries the same code.
2. **Ten-minute ownership expiry.** Claims still pruned idle owners locally and
   allowed a SQL takeover by age. A second browser could claim an open but
   temporarily offline terminal's balance, triggering a 409 on its next sync.
   Both age-based release paths are removed. Explicit unlink/close releases it.
3. **Sibling-token pruning.** The sweeper deleted quiet tokens when another
   token in the same session was active. After restart the quiet chart received
   an unknown-token 401. Housekeeping now prunes only already-revoked rows.
4. **Incomplete terminal close.** Old attach tokens could keep a link alive
   after the EA's terminal-close report. The existing v3.09 payload
   `the terminal or chart was closed` (sent only for `REASON_CLOSE`) now ends
   the whole session link. Generic legacy token goodbyes remain token-scoped.
5. **False-positive deployment health.** `/api/healthz` deliberately always
   returns 200 for compatibility. Railway now probes `/api/bridge/ready`, which
   requires readable bridge tables, completed schema bootstrap, and PostgreSQL
   in production. Production issuance also rejects embedded container storage.
   A deployment with broken persistence is no longer advertised as ready.

No EA binary/version, trading strategy, order execution, quote timestamps,
freshness gates, risk limits or frontend bundle changes are required.

## Deployment and verification

- Attach a persistent PostgreSQL service and set **the API service's**
  `DATABASE_URL` to its connection URL via a provider variable reference. Never
  paste credentials into an issue, log screenshot, or PR. All API instances
  must use the same database. PGlite remains supported for local development
  and isolated tests, not production MT5 credentials on ephemeral containers.
- Use one API replica for this architecture: Desk live state, SSE delivery,
  token caches and command queues are process-local. Shared credential storage
  alone does not make the entire Desk safe for arbitrary load balancing.
  Distributed Desk state/revocation propagation is a separate architecture
  change, not something this focused fix claims to implement.
- Keep the web service's `API_UPSTREAM` and the EA's `ServerUrl` pointing to the
  same API deployment. Do not point the EA at an old deployment/database.
- Deploy this PR; check `/api/bridge/ready` is HTTP 200 and reports
  `backend: postgres`, `reachable: true`, `schemaApplied: true`. On 503 inspect
  `/api/healthz` DB diagnostics and server logs; fix connectivity, permissions,
  schema errors or provider networking before retrying. No code change can
  make an unavailable external database reachable.
- Pair a demo terminal, switch timeframe, recompile/re-attach the EA, briefly
  interrupt networking, and restart the API. The existing token must resume;
  temporary silence is stale, not unlinked. Unlink in Desk must refuse its old
  token. Closing MT5 normally must release its account/code, even with old
  attach tokens. An initial token that was **never persisted by the old code**
  cannot be reconstructed securely: after restoring the database, unlink any
  leftover Desk link and pair once with a fresh code if necessary.

## Honest availability boundary

A continuous network connection cannot be guaranteed during network/database
outages. Trading must pause on stale data. The guarantee is preserving a valid
pairing and automatically resuming when dependencies recover, not executing
through an outage. Likewise a killed/unpowered terminal cannot send its close
notification. Guessing "closed" from missed heartbeats would recreate the exact
unrequested disconnect bug; the Desk remains stale until a delivered close or
explicit unlink. If the database permanently loses its rows, do not accept an
unverifiable token just to make the UI green.

Tests use isolated PGlite with PostgreSQL SQL semantics. They cover outages,
real INSERT-constraint failure/transaction rollback, restart rehydration,
long-silent ownership, sibling tokens, terminal close and explicit unlink.
Windows MT5 / MetaEditor and the user's production database are not available
in the sandbox, so live terminal acceptance remains a deployment check.
