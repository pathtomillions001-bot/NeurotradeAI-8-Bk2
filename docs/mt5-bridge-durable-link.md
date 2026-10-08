# The MT5 link is durable, and the news window is the window the Desk describes

Four reports arrived together, and three of them were the same failure seen from
different angles.

```
NeurotradeBridge (GBPUSD.m,M15)  HTTP 401 from /api/bridge/pair —
                                 {"error":"Unknown or expired pairing code."}
                                 … every 5 seconds, forever

Desk header                      Reconnecting to the MT5 terminal — last heartbeat 23s ago …

News pane                        Next 24 h · 0 red-folder events
                                 No high-impact events in the next 24 hours.
                                 The gate stays armed …

Plans                            armed, but nothing executed
```

---

## 1. Why the terminal was stuck in a 401 loop

The bridge was entirely process-local. The **pairing code** lived in a
`Map<string, PendingPairing>` and the **bearer token** in another
`Map<string, string>`. Both were created by a process that restarts on every
deploy, crash, scale event and cold start.

What a restart does to a paired terminal:

1. the token mapping disappears → the next heartbeat is `401 Invalid or revoked
   bridge token`;
2. the EA clears its token (`HttpPost`, authenticated 401) and falls back to its
   pairing code — which also disappeared with the process;
3. the EA retries that dead code every 5 seconds, and every retry prints
   `HTTP 401 … Unknown or expired pairing code`;
4. no heartbeat lands, so the Desk shows *reconnecting*, and the command outbox
   is never drained — armed plans simply expire untriggered.

There was a second, independent way to kill the same code: the setup dialog
calls `POST /api/bridge/pairing-code` whenever it is opened, and that route
deleted **every** existing code for the session and minted a new one. Opening
the dialog to read the code out loud invalidated the code the EA was already
using. Two charts running the same EA compounded it — each re-pair rotated the
token the other held, so the pair invalidated each other in a loop.

### The fix

**Server — `mt5_bridge_links` and `mt5_pairing_codes` (Postgres).**

* Pairing codes are persisted, scoped to the browser session, and stay valid
  until the user unlinks the terminal (`POST /bridge/unpair`), explicitly
  requests a new one (`{ "rotate": true }`), or a sliding 30-day TTL lapses.
* `POST /bridge/pairing-code` is **idempotent**: it returns the session's live
  code instead of rotating it, so re-opening the dialog is harmless.
* Bearer tokens are stored **hashed** (sha256). Unpair marks them revoked
  rather than deleting the row, so a link the user ended cannot be resurrected
  by a later restart.
* `POST /bridge/sync` **rehydrates**: an unknown-but-durable token rebuilds the
  Desk, re-takes the account claim and continues. A restart is now a journal
  line, not a disconnection.
* `deskForRequest` resolves any token belonging to the session's link instead of
  comparing against one "current" token, and `desk.terminal.tokens` holds them
  all — so a second EA instance **adds** to the link instead of rotating it.
  Exactly-once command delivery is unaffected: `drainOutbox` already removes a
  command when it is handed to whichever instance beats first.

**Terminal — the EA saves the link.** `NeurotradeBridge.mq5` v3.03 writes the
token and the pairing code into the terminal's **common Files folder**
(`NeurotradeBridge_<login>_<server>.link`) and restores them in `OnInit`. The
common folder is shared by every chart of that installation, so a second chart
adopts the existing link rather than pairing again.

The connection now ends in exactly one place: **"Unlink terminal"** in the
Desk. Closing MT5, closing the browser, rebooting the VPS and redeploying the
API all reconnect by themselves.

## 2. "Fix this so we always have stable connection"

Three things made the connection flap, and all three are addressed above:

| Cause | Fix |
|---|---|
| Token lost on restart → 401 → no heartbeats | Durable links + `/sync` rehydration |
| Pairing code invalidated by the dialog or a restart | Idempotent, persistent codes; EA saves the code |
| Two instances invalidating each other's token | One link, many valid tokens |
| A 401 retried every 5s forever, burying the reason | One clear message, then a slow (60 s) background retry |

The EA also stops hammering: a definitive 401 prints **once** ("this pairing
code is not valid any more … open the Desk, copy the current code"), clears the
saved token, and backs off to 60 seconds. Transient failures still retry in 5.

## 3. Why the news pane said "0 red-folder events" while MT5 showed three

Two defects, both in the EA that the Desk's own **download button** served.

**The served EA was a stale build.** `artifacts/trading-platform/public/downloads/NeurotradeBridge.mq5`
was still `#property version "2.00"` while the source EA had moved to 3.02 — it
predated the whole v3 rewrite. A build re-publishes it (`scripts/copy-mt5-ea.mjs`),
which is why a deployed bundle could be correct while the repository copy, and
anyone who self-hosted or reviewed the download, got the old one. That build:

* sent `MqlCalendarValue.time * 1000` with **no UTC conversion** (MT5 calendar
  times are in trade-server time, so every event was hours off);
* read only `[now − 15 min, now + 2 h]` — a two-hour window, while the Desk
  renders the last 12 hours plus the next 24;
* reported no `rawCount`, so the pane's "the terminal returned nothing" check
  could never fire and the empty list rendered as an **all-clear**.

Two red-folder releases earlier in the day were simply never fetched, and the
pane had no way to say so. It printed the calmest possible sentence over a
calendar it had never read.

**The read window is now the window the Desk describes.** The EA fetches
`[now − 12 h, now + 24 h]` (matching `NEWS_LOOKBEHIND_MS` / `NEWS_LOOKAHEAD_MS`
server-side), falls back to an open-ended read when the windowed one returns
nothing at all, and publishes `windowFromMs` / `windowToMs` alongside
`rawCount` / `redCount`.

The pane now states what was read — *"No red-folder releases in the range the
terminal read (08:30 → Thu 10:45)"* — and if the reporting terminal covers less
than a day ahead it says so and points at the download, instead of narrowing its
claim silently.

A parity test (`src/lib/ea-download-parity.test.ts`) now fails the build if the
published EA and the EA source ever drift apart again, and `/api/bridge/status`
reports `eaVersion` / `expectedEaVersion` / `eaUpdateAvailable` so a stale
terminal is visible in the dialog rather than guessed at.

## 4. Armed plans that never executed

A consequence of §1: with the link dead, `drainOutbox` had no terminal to drain
to, so arm commands were never delivered and plans expired untriggered. Two
additional repairs make plans survive the cases that remain:

* **Sequence numbers are per instance.** `seq` was compared against a single
  stored value, so a second chart (or a restarted EA) starting near zero looked
  like "the terminal restarted" — which cleared every armed plan and dropped the
  setup the user had just approved. The EA now sends an `instanceId`; a lower
  counter from the *same* instance is still a genuine restart, while a *new*
  instance gets the Desk's armed plans **re-sent** (`resendArmedPlans`) instead
  of the Desk discarding them.

## Files

| Path | Role |
|---|---|
| `lib/db/src/index.ts` | `mt5_bridge_links`, `mt5_pairing_codes` DDL |
| `artifacts/api-server/src/lib/multiasset/bridge-links.ts` | durable code + link store (hashed tokens, sliding TTL, revocation) |
| `artifacts/api-server/src/routes/bridge.ts` | idempotent codes, durable pairing, `/sync` rehydration, instance-aware restart detection, EA version reporting |
| `artifacts/api-server/src/lib/multiasset/store.ts` | `tokens[]`, `instanceId`, `eaVersion`, `adoptBridgeToken`, `rememberBridgeToken`, `revokeBridgeTokens`, `resendArmedPlans` |
| `artifacts/mt5-ea/NeurotradeBridge.mq5` | v3.03: saved link, refusal backoff, instance id, 12 h → 24 h calendar window |
| `artifacts/trading-platform/public/downloads/NeurotradeBridge.mq5` | the same file, published (parity-tested) |
| `artifacts/api-server/src/routes/mt5-bridge-durability.test.ts` | restart, resume, unlink, two-instance and plan-re-delivery proofs |
| `artifacts/trading-platform/src/lib/ea-download-parity.test.ts` | the download can never go stale again |

## Operating notes

* Re-downloading the EA is the one manual step: existing terminals run the old
  build. Recompile and re-attach it — **the link is restored automatically**, no
  new pairing code is needed.
* Only `POST /api/bridge/unpair` ends a link. If a user unlinks, the EA prints a
  single instruction and waits; pasting the dialog's current code reconnects.
* A Desk rehydrated from a durable link after a restart has no candles or quotes
  until the next heartbeat (≈0.5 s) reseeds them, and its armed plans are
  re-delivered on the first sync from a new instance.
