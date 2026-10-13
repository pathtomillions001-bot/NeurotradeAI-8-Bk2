> **HISTORICAL — this contract was overturned in v3.09.**
>
> The rule below ("a link lives only as long as the terminal session") is what
> shipped in EA v3.08, and it is what the owner then reported as *the Desk keeps
> disconnecting itself*. The current contract — a link ends only when the user
> unlinks it in the Desk or closes MT5 — is `docs/mt5-bridge-link-lifetime.md`.
> This file is kept as the record of what was tried, why the server-side version
> of it looked reasonable, and which tests pinned it; those tests were rewritten
> with the contract, not worked around.

# The MT5 link lives only as long as the terminal (v3.08 — SUPERSEDED)

This supersedes `docs/mt5-bridge-durable-link.md`. The rule it describes — a
link that survives closing MT5, closing the browser and redeploying the API, and
that only the user's "Unlink terminal" can end — is gone, deliberately. What
replaced it is narrower and simpler to reason about:

> A pairing code connects **one MT5 terminal session**. It is active only while
> that terminal is open. Closing MT5 ends the link, retires the code, releases
> the account claim, and the next session starts from a NEW code in the Desk.

Nothing is stored for next time — not in the terminal, not on the server.

---

## 1. What was reported

```
NeurotradeBridge (US100.std,H1)  NeurotradeBridge v3.07 attached…
NeurotradeBridge (US100.std,H1)  NeurotradeBridge: restored the saved link for
                                 account 2001244359@JustMarkets-Demo. No pairing
                                 code is needed — the connection resumes
                                 automatically.
NeurotradeBridge (US100.std,H1)  NeurotradeBridge: HTTP 503 from
                                 /api/bridge/sync — The bridge link store could
                                 not be reached, so this terminal's saved link
                                 could not be verified. Nothing was revoked —
                                 the terminal should retry.
```

Three complaints were in that log at once: a terminal that reconnects with a key
nobody asked to keep, a link that outlives the session that created it, and a
`503` on every beat from a store that could not be read.

---

## 2. The persistence, removed

v3.03 saved the bearer token **and** the pairing code in the terminal's common
`Files` folder (`NeurotradeBridge_<login>_<server>.link`) and restored them in
`OnInit`. v3.06 made the server keep the same pair in Postgres. Together they
produced a credential that survived the thing it was supposed to represent.

What happens now:

| | v3.07 and earlier | v3.08 |
|---|---|---|
| Bearer token | common-folder file + Postgres row | **EA memory only** |
| Pairing code | remembered in the file + Postgres row | the user's `PairingCode` input only |
| MT5 closed | next start resumed the link | link ends; a **new code** is needed |
| EA reload in the same terminal (recompile, input change, timeframe change) | resumed | resumes — the link is still live |
| API redeploy while MT5 is open | resumed | resumes — the terminal re-pairs on its live code |
| API redeploy while MT5 is closed | resumed | **ended** — the rows are gone |
| An old `.link` file on disk | read on startup | **deleted on attach** |

`RemoveLegacyLinkFile()` runs in `OnInit` and deletes the file an older build
left behind, so an upgrade cannot silently restore the old behaviour.
`EffectivePairingCode()` returns `StringTrimmed(PairingCode)` and nothing else:
there is no remembered fallback to fall back to.

## 3. How a link ends

**Deliberately, from the terminal.** `OnDeinit` calls
`POST /api/bridge/disconnect` for the reasons that mean the session is over —
`REASON_CHARTCLOSE`, `REASON_CLOSE`, `REASON_INITFAILED`, `REASON_ACCOUNT`. It
is best effort (MT5 does not wait for an expert's shutdown), and it is
token-scoped: one chart leaving a two-chart terminal drops only that chart's
token, and the link survives for the chart that is still streaming.

`REASON_REMOVE` is deliberately **not** on that list. MT5 reports some symbol
and timeframe changes with it instead of `REASON_CHARTCHANGE`, so disconnecting
there would drop a live link every time a user switched from H1 to M15. An EA
removed by hand stops beating, which the next mechanism catches.

**By lease, from the server.** A kill, a power cut or a VPS reboot runs no
shutdown code at all, so the API sweeps on a 15 s timer: any link whose last
heartbeat is older than `BRIDGE_LINK_LEASE_MS` (120 s — the same order as the
desk's own staleness ceiling) is ended. Tokens are deleted, the account claim is
released, the pairing code is retired, and the Desk's terminal data is cleared.

**By the user, explicitly.** `/api/bridge/unpair` still revokes rather than
deletes, because it is the one answer the EA may treat as final: it prints
"unlinked", stops retrying and asks for a new code.

## 4. What the pairing code may still do

A code is single-use in the sense that matters — it belongs to the link it
created — but it is not destroyed at the first `/pair`, because three cases must
keep working while the terminal is open:

* an EA reload (recompile, input change, symbol/timeframe change);
* a second chart running the same EA on the same account;
* an API redeploy the terminal survived (its token is re-adopted from the
  store; if its in-memory token was ever lost, the code still re-pairs it).

All three are the same request: `/pair` with a code whose link is **alive** and
whose **account matches**. Anything else is refused:

| Situation | Answer |
|---|---|
| Code never used, within its 15-minute TTL | pairs |
| Code used, its link is alive, same account | pairs (second chart / reload / redeploy) |
| Code used, its link is alive, **different** account | `401 pairing_code_spent` |
| Code used, its link has ended | `401 pairing_code_spent` — "generate a new code" |
| Code rotated away, expired unused, or unknown | `401 pairing_code_unknown` |
| The store cannot be read at all | `503 bridge_store_unavailable` — nothing revoked, retry |

A retired code is kept for 30 minutes only so the server can answer the fourth
row with something actionable; it can never mint a token.

## 5. The `503` on every beat

The reported `503` came from `/sync` reaching the store for a token this process
had not seen, finding it unreadable, and answering "I could not check" on every
subsequent beat — from a terminal whose session had, in fact, already ended on
the user's side.

Two changes make that class of failure much smaller:

1. **A live link never consults the store.** The in-process mirror serves the
   hot path, so a beating terminal keeps syncing through a database failover.
   The store is only asked about a token this process has never seen.
2. **Reads retry before giving up.** A read that throws is attempted three
   times, 120–240 ms apart, so one slow query during a failover no longer
   surfaces as a `503` on a 500 ms heartbeat.

When the store genuinely cannot be read, the answer is still `503` with
`retryAfterMs` and `code: "bridge_store_unavailable"`, and nothing is revoked —
the terminal keeps its token and comes back on its own. What is *gone* is the
old failure mode: a terminal retrying a credential for a session that no longer
exists, forever.

## 6. What the Desk shows

`/api/bridge/status` reports the contract (`linkModel: "terminal-session"`,
`linkEndsWithTerminal: true`, `leaseMs`) with or without a linked terminal, and
the setup dialog states it next to the code:

> This code connects one MT5 terminal session, and it is active only while that
> terminal is open. Nothing is saved in the terminal: when MT5 closes, the link
> and this code are released, and reconnecting needs a new code from this
> dialog.

## 7. Where this lives

| Concern | File |
|---|---|
| Codes, links, lease, retirement | `artifacts/api-server/src/lib/multiasset/bridge-links.ts` |
| `/pairing-code`, `/pair`, `/disconnect`, `/unpair`, `/status`, the sweeper | `artifacts/api-server/src/routes/bridge.ts` |
| The sweeper is started | `artifacts/api-server/src/index.ts` |
| The link tables (`code` column, `expires_at_ms = 0` sentinel) | `lib/db/src/index.ts` |
| Terminal half | `artifacts/mt5-ea/NeurotradeBridge.mq5` (v3.08 notes 28–29) |
| Contract tests | `artifacts/api-server/src/routes/mt5-bridge-session.test.ts` |
| Terminal-half tests | `artifacts/trading-platform/src/lib/ea-bridge-resilience.test.ts`, `ea-download-parity.test.ts` |
