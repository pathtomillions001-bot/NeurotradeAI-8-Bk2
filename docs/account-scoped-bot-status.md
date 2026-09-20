# Account-scoped bot status — one popup, tied to the connected Deriv account

## What was wrong

Two independent defects, both "the screen said something the engine was not doing":

1. **A running bot was attributed to whatever account was connected next.**
   A browser session can hold several linked Deriv accounts and switch between
   them, but an engine reads the active account **once**, when it starts, and
   then trades that account's token. `GET /api/bots/live`, `GET /api/bots` and
   `GET /api/bots/status` only ever answered "is a bot running?" — never
   "…on which account?". So a bot trading `CR777` was rendered as the live bot
   of `CR999`, with `CR777`'s P&L next to `CR999`'s balance.

2. **Two elements claimed to know that answer.** The layout's floating chip
   (polling `/api/bots/live`) and the Bot Arena's `Active Bot` / `No bot
   running` badge (polling `/api/bots/status` + the catalogue) were separate
   components reading separate endpoints, so they could — and did — disagree
   during the seconds around a start or a stop.

## The fix

### 1. Every running bot carries the account it was started on

`artifacts/api-server/src/lib/account-scope.ts` (new):

| scope | meaning |
| --- | --- |
| `this-account` | the bot's Deriv login is the account this browser is connected to |
| `other-account` | same browser, a **different** linked account — visible, but never presented as *your* bot |
| `other-session` | another browser session's engine — masked marker, no telemetry |
| `unattributed` | no account stamp (paper trading, or a start predating account linking) — treated as your own, because hiding a running engine is the one failure this subsystem exists to prevent |

- `stampActiveAccount(sessionId)` writes the account into a **session-scoped
  note** synchronously, and every start route calls it immediately before
  handing control to an engine (`dual-lock`, `killshot`, `killshot-family`,
  `prism`, and the generic specialist route).
- `registerLiveBot()` (`live-registry.ts`) reads that note **at registration
  time**, so the stamp is frozen when the bot starts: switching accounts a
  moment later cannot re-attribute a bot that is already trading.
- `botAccountScope(botAccount, activeAccount)` classifies a running bot; login
  ids are compared case- and whitespace-insensitively.

`GET /api/bots/live` now answers with the scope and the account per entry, and
`activeBotId` only names a bot that belongs to the **current** account:

```jsonc
{
  "bots": [
    { "botId": "match-prism", "console": "prism@1",
      "account": "CR777", "scope": "other-account", "status": { "running": true } }
  ],
  "activeBotId": null,                  // nothing of OURS is running
  "account": { "loginId": "CR999" }     // what the browser is on
}
```

`GET /api/bots` (catalogue) and `GET /api/bots/status` follow the same rule, so
a foreign bot gets no session attached to its card and cannot print its P&L on
this account's page. It is still **listed, openable and stoppable** — the popup
turns amber, names the account it is trading, and offers Stop.

### 2. One popup

`artifacts/trading-platform/src/components/live-bot-indicator.tsx` is **gone**;
`bot-status-popup.tsx` replaces it *and* the Bot Arena's separate badge.

- One poll for the whole app: `LiveBotsProvider` (in `App.tsx`) runs the single
  `useLiveBots(5000)` hook; the layout's popup and the Bot Arena read it
  through `useLiveBotsState()`, so they cannot disagree.
- The popup has four states: **active** (green, "Trading CR777"), **foreign**
  (amber, "Bot active on CR777" + "This account is CR999"), **masked** (another
  session) and **idle** ("No bot running") — the last one rendered only where it
  is useful (the Bot Arena) and silent elsewhere, so the floating popup still
  only exists while something is running.
- Compact (mobile header) and full (desktop, fixed top-right) variants keep
  Open + confirm-to-stop, exactly as before.
- Switching accounts calls `refreshLiveBots()` (account switcher + every connect
  path), so the re-scope is immediate instead of up to 5 s of wrong attribution.

## Verified

- `account-scope.test.ts` — the truth table, the per-session stamp, and the
  freeze-at-start invariant; plus structural guards that *every* start route
  stamps an account, that `/live` publishes a scope, and that the app has
  **exactly one** popup reading **exactly one** poll.
- `live-bots.test.ts` (web) — `ownAccountBot` / `otherAccountBot` /
  `otherSessionBot`, and every engine family's stop path (including
  `match-prism` → `/api/bots/prism/stop`).
- End-to-end over real HTTP (probe, deleted after use): a bot started on
  `CR777`, then the active account switched to `CR999`, reported
  `scope: "other-account"` and `activeBotId: null`; switching back to `CR777`
  flipped it to `scope: "this-account"` and `activeBotId: "match-prism"`, with
  the catalogue agreeing in both cases.
