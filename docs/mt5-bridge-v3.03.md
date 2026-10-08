# MT5 bridge v3.03 — durable pairing and reliable Desk transport

## Verified causes in the repository

1. `/api/bridge/pair` used an in-process, ten-minute, single-use code. The EA
   stored the returned token only in `g_token`. Restarting MT5, reattaching an
   EA, or attaching another copy on a second chart retried an already redeemed
   code. Restarting the API lost both the pending code and token index.
2. **The public download was v2.00 while the source was v3.02.** Users who
   downloaded through the Desk did not receive the existing UTC timestamp,
   expiry, heartbeat and empty-calendar fixes. On a GMT+2/+3 broker, that old
   expiry comparison could expire an approved plan immediately.
3. The supposedly heartbeat-first path still invoked calendar/history reads
   while constructing its request. `CopyRates` could be called ten times per
   symbol, for twelve symbols per heartbeat; MT5 synchronously waits for broker
   history. Independent charts could also compete for commands and execution.
4. The calendar primary query started only fifteen minutes in the past, even
   though the pane intended to list earlier releases. Event/country metadata
   lookup failures were silently skipped and could still produce an all-clear.
5. Temporary local guards silently deactivated plans. Execution outcomes sent
   using plan IDs were not recognised after the distinct arm-command ID had
   already been acknowledged, hiding useful execution diagnostics.

These are code-level findings, not a claim to have reproduced the user's broker
or independently verified October 8's three calendar releases.

## New behaviour

- A cryptographically random **128-bit private reusable code** replaces the
  short PIN. Codes and bearer tokens are stored **hashed**, in
  `mt5_bridge_links`. A code has no time-based expiration and binds to one MT5
  account. Retry returns the same token without clearing the watchlist or plans.
- Explicit unlink deletes the durable credentials, revokes the code/token and
  releases account ownership. Generating a replacement code revokes the old
  code; the active token stays valid until the replacement is paired.
- Account ownership no longer expires because MT5/browser is closed. A different
  browser cannot take over a quiet account. Use the owning Desk to unlink first.
- Pairing binds the durable browser/client identity. Reopening tabs in the same
  browser returns to the same Desk. Clearing browser storage is not equivalent
  to reopening it: retain access to the owning browser to disconnect safely.
- The EA saves its token and connector identity inside its **local MQL5 Files
  sandbox**, scoped to broker account, platform origin and configured code. Do
  not share those files or your code. No MT5 password is sent to the app.
- One local EA owns an exclusive account lock; other charts remain attached on
  standby and do not trade/manage positions. A server-side connector lease also
  prevents multiple terminal installations from consuming one Desk's commands.
  Cross-installation failover requires **150 seconds** of silence, longer than
  the EA's fixed **120-second** execution-silence guard. The local saved instance
  identity allows normal same-installation restarts without that wait.
- Each heartbeat serialises cached calendar/candles, with all selected quotes.
  One history call per successful timer cycle is prepared for the next upload,
  rather than up to 120 calls before an HTTP request. Cold history needs time
  proportional to the selection (10 timeframes × symbols). MT5's synchronous
  calendar/history/WebRequest APIs and network outages can still delay a beat;
  the warning remains truthful rather than being hidden by longer thresholds.
- Calendar reads cover **24 hours behind and 24 hours ahead**, with an open-end
  fallback. Empty reads or metadata failures are unavailable, not "zero news".
  The pane shows stale calendar status instead of an all-clear. News is still
  refreshed every minute; both server and EA fail closed after five minutes.
- Temporary local guards hold approved plans until a safe trigger or their TTL.
  Tick confirmation counts distinct MT5 ticks, not repeated timer visits. Plan
  expiry/invalidation/fills are reconciled and journaled using plan IDs.
- Risk/live-account consent, eight-second per-symbol tick checks, spread,
  calendar blackout, and plan expiry still apply. **Pairing does not guarantee
  execution:** an armed plan is conditional, not permission to buy at any price.

### Restart safety

The database restores connection identity, watchlist, mode, timezone, risk
policy/state and explicit auto-trade authorisation after an API restart. It
**never restores prices, candles or executable orders**. Fresh terminal truth is
required before analysis/arming. Terminal sequence reset and connector handover
clear pending server commands/plans rather than replay uncertain purchases.
A normal browser restart does not stop an already-running EA or clear server
plans. An MT5 restart reconnects automatically, then resynchronises safely; old
unexecuted plans are intentionally not blindly reissued.

## Deploy and upgrade (required)

1. Deploy API and web from this PR together. The embedded idempotent DDL creates
   `mt5_bridge_links`; its Drizzle declaration is included too. Use durable
   Postgres in production (or a persistent volume for the local PGlite fallback).
   **One API replica is required for the Desk's in-memory analytics/order state**;
   the durable account/connector registry is not distributed order-state storage.
2. Existing v2/v3.02 credentials were never persisted, so they cannot be recovered
   retroactively. In the original owning browser, unlink the old connection and
   obtain a new code once. Upgrade all attached old bridge copies.
3. Download `NeurotradeBridge.mq5` from the Desk (now v3.03, cache-busted URL), copy
   to `MQL5/Experts`, and compile in **MetaEditor**. Reattach to any chart with the
   exact public `ServerUrl` origin and new `PairingCode`. Allow that HTTPS origin
   under Tools → Options → Expert Advisors → WebRequest.
4. Enable Algo Trading/EA permissions. For a real account, the EA's
   `AllowLiveAccount` and the Desk's live-trading consent must both be enabled.
   Start with a demo account. Other charts on the same account may remain on
   standby, but all must be upgraded; old versions lack the exclusive lock.
5. Compare MT5 Calendar with the Desk's earlier/upcoming events, currencies and
   converted timestamps. Confirm a minute-by-minute checked time and actual
   quote ages. Test browser closure, MT5 restart and explicit unlink before
   considering live funds.

## Validation

Automated tests exercise real bridge routes with an isolated database, durable
identity resolution, idempotent retries, process-cache loss, revocation, account
isolation, connector leases, restart command clearing, calendar parsing, outcome
reconciliation and source/download equality. Source-contract tests cover the
new EA guards and non-blocking heartbeat construction. TypeScript checking and
API/web build checks run separately.

**Not validated here:** native MQL5 compilation, broker connectivity, MT5 calendar
availability, or actual broker fills. This Linux sandbox does not contain MT5 or
MetaEditor. The required terminal/demo smoke test above is a release acceptance
step, not something the automated source checks can replace.

For the follow-up pairing-code readiness incident, production-evidence limits,
health checks and safe recovery/deployment steps, see
[`docs/mt5-pairing-code-recovery.md`](./mt5-pairing-code-recovery.md).
