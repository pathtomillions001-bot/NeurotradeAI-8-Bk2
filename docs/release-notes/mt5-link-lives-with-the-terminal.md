# Change: the MT5 link now lives only as long as the terminal

## Problem

The MT5 bridge had grown a *durable link*: the pairing code and the bearer token
were persisted on the server (`mt5_pairing_codes`, `mt5_bridge_links`) and the
same two values were saved by the EA inside the MT5 common `Files` folder
(`NeurotradeBridge_<login>_<server>.link`). The intent was that nothing short of
**Unlink terminal** could end a connection. Three things came out of it, all of
them the user's:

```
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

1. **A credential that outlived the session that created it** — in the terminal's
   common folder and in the database, reconnectable by nobody in particular.
2. **An old code that still worked.** Closing MT5 did not release anything: the
   terminal came back and re-paired with the code it had saved, so reconnecting
   never required the user to be present.
3. **A `503` that read as a heartbeat.** A `git push` that lost the rows, a
   replica that had not seen them, or a bootstrap DDL window made `/sync` answer
   "I could not check", which the terminal could not tell apart from "the Desk
   says no".

## Change

**The pairing code now connects one MT5 terminal session, and nothing else.**
Closing MT5 ends the link; reconnecting needs a new code from the Desk.

| | before | now |
|---|---|---|
| Bearer token | common-folder file + database row | **EA memory only** |
| Pairing code | remembered in the file + database row | the user's `PairingCode` input only |
| Closing MT5 | next start resumed the link | the link ends, the code is spent, the account claim is released, the Desk's terminal data is cleared |
| Old `.link` file on disk | read on `OnInit` | deleted by `RemoveLegacyLinkFile()` on `OnInit` |
| A configured symbol/timeframe change | resumed | still resumes — the EA is reloaded, the terminal never left |
| An API redeploy while MT5 is open | resumed | still resumes — the terminal re-pairs on its live code |
| An API redeploy while MT5 is closed | resumed | ends with the session, as it should |

**Server.** A link ends in three ways, and all three now release everything the
session held — token, pairing code, account claim, Desk terminal data:

* `POST /api/bridge/disconnect` from the terminal. `OnDeinit` sends it for
  `REASON_CHARTCLOSE`, `REASON_CLOSE`, `REASON_INITFAILED` and `REASON_ACCOUNT`.
  It is token-scoped, so one chart leaving a two-chart terminal does not kill the
  link the other chart is still streaming on.
* The 15 s sweeper, once a link has been silent past `BRIDGE_LINK_LEASE_MS`
  (120 s, the same order as the desk's own staleness ceiling). This is the
  backstop for a kill, a power cut or a reboot, where no shutdown code runs.
* `POST /api/bridge/unpair` — the one answer the EA treats as final, because the
  user asked for it.

**A code is still re-presentable while its link is alive** (an EA reload, a
second chart, an API redeploy the terminal survived) and refused everywhere else
with `401 pairing_code_spent`, which now says what to do:

> This pairing code is no longer active: the MT5 terminal session that used it
> has ended, or a newer code replaced it … generate a NEW code in the Desk
> (Link MT5) and paste it into the EA's PairingCode input.

A spent code is *retired* rather than deleted — kept for 30 minutes, unable to
mint a token, purely so the terminal is told that instead of "unknown code".

**`503` is now rare and honest.** A live link never consults the store (the
in-process mirror serves the heartbeat), reads retry 3 × 120–240 ms before
giving up, and a `503 bridge_store_unavailable` still revokes nothing. The
reported failure — a terminal retrying, forever, on a session that no longer
existed — cannot be produced by this design.

**EA v3.08.** Nothing about a session is written to disk. `EffectivePairingCode()`
is the user's input and nothing else. `RemoveLegacyLinkFile()` deletes what an
older build left behind. `DisconnectBridge()` tells the server when the session
ends. The token is deliberately kept after the disconnect POST, because MT5 may
re-attach the EA while the link is still alive.

## Proofs

* `artifacts/api-server/src/routes/mt5-bridge-session.test.ts` — 16 tests:
  a code is idempotent while its terminal is open and rotated only on request;
  the same account may re-present a live code (two charts, two tokens, both
  heartbeat) while a **different** account on that code is refused; once the
  terminal goes, code ⇒ `401 pairing_code_spent`, token ⇒ `401
  bridge_token_unknown`, and a fresh code reconnects; `/disconnect` releases
  token, code and claim, and reports `remaining: 1` when one of two charts left;
  a silent terminal is swept with its claim released; a **live** link is served
  with the store down, and an unreadable store answers `503` while revoking
  nothing; the Desk is told `linkModel: "terminal-session"`,
  `linkEndsWithTerminal: true`, `leaseMs: 120000`.
* `artifacts/trading-platform/src/lib/ea-bridge-resilience.test.ts` — the EA
  has no `SaveLink`/`LoadSavedLink`/`g_savedCode`; the only code that names a
  `.link` file deletes it; the only `FileWriteString` calls are the position
  manager's and none carries the token; `OnDeinit` disconnects for the four
  session-ending reasons and **not** for `REASON_REMOVE` (MT5 reports ordinary
  symbol/timeframe changes with it); a spent code gets its own actionable line.
* `artifacts/trading-platform/src/lib/ea-download-parity.test.ts` — the
  published download is byte-identical to the source and carries the v3.08
  contract markers.

Full analysis: `docs/mt5-bridge-session-link.md`. The 401 fix that this builds
on is unchanged and still documented in `docs/mt5-bridge-401-resilience.md`.
