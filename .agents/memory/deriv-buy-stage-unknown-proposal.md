---
name: Deriv "Unknown contract proposal" is stage-dependent
description: The same broker text from `buy` and from `proposal` means opposite things; only the buy stage may be re-quoted, and the error code must survive into the stop reason.
---

## Rule

Deriv's `InvalidContractProposal` / "Unknown contract proposal" is **stage-dependent**, and the two stages must never be handled alike:

- from `{ buy: <id> }` → the proposal id is unknown to the session that received the purchase. Resolving that id is the step *before* contract creation, so **no contract exists**. Re-quote ONCE and buy the fresh id at *that* quote's own ask price — that completes the single requested purchase, it is not a repeated buy.
- from `{ proposal: 1, … }` → this account is not offered that contract on that market (market access / landing company / country, closed market, unsupported contract type or barrier, wrong `currency`). Deterministic: it fails on every tick and after every restart, so it must never be retried.

Classify with `isUnknownProposalRejection()` in `lib/deriv.ts` and only ever on a **buy** reply. Keep the broker's error `code` in the thrown message (`describeDerivRejection`) so a UI panel, the engine stop reason and the journal can be told apart after the fact.

## Why

`executeLiveTrade` buys in two steps on the account's ONE pooled trading socket: `{proposal: 1, …}` → proposal **id**, then `{buy: <id>, price: <ask>}`. That id only exists inside the session that issued it, and it dies two ways that are both routine here:

1. `DerivAccountConnection.request()` calls `ensureConnected()` before *every* message, so a socket that re-handshook between the two calls (no pong in 60 s, OTP re-issue, idle `destroy()`) sends the buy on a **new session** carrying the old id.
2. Any `RateLimit` on that shared socket sets `pausedUntil = now + 4_000` and the queue paces at 10 msg/s, so a 1-tick quote can age out before its own buy is sent.

`deriv.ts` used to `throw new Error(msg.error.message)` for both stages, discarding `error.code` and the stage. `autonomous-hedge/cycle.ts` counted the sentence as a strike and `host.stop()`ed after three — so a dead quote killed the engine, and restarting re-ranked the same tape and died the same way three times again.

## How to apply

- The replay is capped at ONE re-quote and is triggered **only** by an unknown-proposal buy rejection. Transient buy rejections (`RateLimit`) and unacknowledged buys (`TradeOutcomeUnknownError`) are still never replayed — those invariants are tested in `single-trade-execution.test.ts`.
- A proposal-stage rejection throws before any buy is sent, so a capability verdict can never reach the replay path. There is a test for that; do not remove it.
- The engine's 3-strike stop is unchanged on purpose: with the dead-quote case repaired it now only ever fires on a genuine, deterministic broker refusal, where stopping is the right answer.
