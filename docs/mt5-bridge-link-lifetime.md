# The MT5 link ends when the user ends it

This document supersedes `docs/mt5-bridge-session-link.md`, whose rule — a link
lives only as long as the terminal session that created it — was overturned by
the owner after on-desk experience. That file is kept in the repository as the
record of the v3.08 contract, with a banner pointing here. The complaint was exactly the rule:

> The Desk keeps disconnecting itself from MT5. The connection must persist
> until (a) the user closes MT5, or (b) the user disconnects the account from
> the Desk. Nothing else may sever it.

The contract that is implemented now:

> A link ends for **exactly two reasons**: the user unlinks the terminal in the
> Desk, or the user closes MT5. Everything else — a reboot, an MT5 restart, an
> API redeploy, a database failover, a sleeping laptop, a weekend, a broker
> maintenance window — costs nothing and needs no user action.

---

## 1. The two endings

**1. The user unlinks the terminal in the Desk.** `POST /api/bridge/unpair`
REVOKES rather than deletes: every token goes in, the account claim is released,
the link's pairing code is retired, the Desk's terminal data is cleared. The
revocation is what makes this the **one** answer the EA may treat as final —
`401 { code: "bridge_link_revoked" }` — and it is the **only** place the EA
deletes the credential file it has saved (see §3).

**2. The user closes MT5.** The EA's `OnDeinit` posts
`POST /api/bridge/disconnect` for `REASON_CLOSE` **alone**. Chart closes,
`REASON_REMOVE`, recompiles, input changes, timeframe changes, symbol changes,
failed attaches and account switches are all things the user does to a *chart* —
none of them is a decision to end the connection, and none of them reports a
disconnect any more. The last token of the link leaving ends it: tokens are
deleted, the code is retired, the claim is released, the Desk is cleared, and
the next MT5 session starts from a new code — which is what "the user closed
MT5" means.

`/disconnect` stays best-effort (MT5 does not wait for an expert's shutdown).
An explicit terminal-close report ends the whole link, including credentials
left behind by earlier attaches. A legacy token-scoped goodbye without a
terminal-close reason still drops only that token. A hard kill or unreachable
server cannot deliver a goodbye; silence alone is never proof of a close.
See `mt5-bridge-store-recovery.md` for deployment requirements and limitations.

## 2. Silence is a display state, not an ending

`BRIDGE_LINK_LEASE_MS` (120 s) no longer revokes anything.
`sweepExpiredLinks()` — the 15 s timer in `src/index.ts` — **returns 0 and ends
nothing**:

* a link with no heartbeat is shown to the Desk as **STALE** (`terminalIsFresh`,
  the two-stage window in `live.ts`), new entries pause, and the next beat
  clears it;
* the only rows housekeeping deletes are already-REVOKED ones (after the EA has
  had its spaced retries to read that final answer). Quiet charts' unrevoked
  tokens are never pruned: they can resume after a reload or API restart.

Because nothing is released, the **account claim survives silence too**: another
Desk cannot take an account by waiting for it, which is the point. `linkIsValid`
is `!revokedAt` — revocation is the only gate.

## 3. The terminal half (EA v3.09)

| | v3.08 | v3.09 |
|---|---|---|
| Bearer token | EA memory only | **saved per MT5 account** in the terminal's common folder |
| Pairing code | the user's `PairingCode` input only | the input, falling back to the **saved** code when the input is empty |
| MT5 closed | link ended; new code needed | `/disconnect` for `REASON_CLOSE`; a new code next session |
| Terminal rebooted / crashed, API redeployed, network down | new code | **resumes automatically** — same link, same code, no user action |
| EA reload in the same terminal | resumes | resumes |
| Old `.link` file | deleted on attach (`RemoveLegacyLinkFile`) | re-adopted by `OnInit` — that file IS the persistence now |
| Credential deleted | on every 401 | in exactly **one** place: the `bridge_link_revoked` branch (`DeleteLinkFile`) |

The file is `MQL5/Files/NeurotradeBridge_<login>_<server>.link` in the
terminal's common folder, body `v1|<token>|<code>`, written by `SaveLinkFile()`
on a successful `/pair` and read by `LoadLinkFile()` in `OnInit`. Every chart of
one MT5 account shares it, which is exactly the scope of one link.

A consequence worth stating: the saved pairing code must stay valid on the
server for as long as the link lives — which it does, because a code is spent
only when its link is (unlink), or when the user rotates it in the dialog.

## 4. What the pairing code may do

| Situation | Answer |
|---|---|
| Code never used, within its 15-minute TTL | pairs |
| Code used, its link alive, same account | pairs — the next MT5 session, a second chart, an EA reload, a redeploy |
| Code used, its link alive, **different** account | `401 pairing_code_spent` |
| Code used, its link was revoked or deleted | `401 pairing_code_spent` — "generate a new code" |
| Code rotated away, expired unused, or unknown | `401 pairing_code_unknown` |
| The store cannot be read at all | `503 bridge_store_unavailable` — nothing revoked, retry |

Retired codes are kept for 30 minutes only so the fourth row can say something
actionable; they can never mint a token.

## 5. `503` on every beat — fixed, and now much rarer

A live link never consults the store (the in-process mirror serves the hot
path), reads retry three times 120–240 ms apart before giving up, and an
unreadable store answers `503` with `retryAfterMs` while revoking nothing. The
old failure mode — a terminal retrying a credential forever — is gone for a
second reason too: under this contract a 401 is either a revocation (final) or
"unknown to this process", and the EA keeps its saved credential through the
latter.

## 6. What the Desk shows

`GET /api/bridge/status` reports the contract **in both branches** (linked and
unlinked, so the dialog can state it next to the code before the user trusts it
with an account):

```json
{
  "durable": true,
  "linkModel": "unlink-or-terminal-close",
  "linkEndsWithTerminal": false,
  "resumesAutomatically": true,
  "leaseMs": 120000,
  "stale": false
}
```

`/pair` answers with the same model (`durableLink: true`,
`resumesAutomatically: true`). The bridge dialog's copy is written from it:
two reasons end the link, the credential is saved in the terminal, silence
shows STALE and never disconnects.

## 7. Where this lives

| Concern | File |
|---|---|
| Codes, links, lease window, retirement | `artifacts/api-server/src/lib/multiasset/bridge-links.ts` |
| `/pairing-code`, `/pair`, `/disconnect`, `/unpair`, `/status`, housekeeping | `artifacts/api-server/src/routes/bridge.ts` |
| The 15 s timer (housekeeping only now) | `artifacts/api-server/src/index.ts` |
| The link table (`code` column, `expires_at_ms = 0` sentinel) | `lib/db/src/index.ts` |
| Terminal half | `artifacts/mt5-ea/NeurotradeBridge.mq5` (v3.09 notes 30, 33) |
| Contract tests | `artifacts/api-server/src/routes/mt5-bridge-session.test.ts` |
| Terminal-half tests | `artifacts/trading-platform/src/lib/ea-bridge-resilience.test.ts`, `ea-download-parity.test.ts` |
| Historical (superseded) | `docs/mt5-bridge-session-link.md` (v3.08), `docs/mt5-bridge-durable-link.md` |
