---
name: Deriv "Unknown contract proposal" (InvalidContractProposal)
description: The same broker text from `buy` and from `proposal` means opposite things; classify by stage before reacting, and never let a stale quote stop an engine.
---

## Rule

Deriv's `InvalidContractProposal` / "Unknown contract proposal" is **stage-dependent**:

- from `{ buy: <id> }` → the proposal ID is unknown to the session that received
  the purchase (the quote went stale behind the socket's send pacing or a 4 s
  rate-limit pause, or the pooled socket re-handshook mid-flight). **No contract
  exists.** Re-quote ONCE and buy the fresh ID — that completes the single
  purchase, it is not a repeated buy.
- from `{ proposal: 1, … }` → this account is not offered that contract on that
  market (market access / landing company / country, closed market, unsupported
  contract type or barrier, wrong `currency`). Deterministic: it fails on every
  tick and after every restart, so quarantine the candidate instead of retrying.

Never throw away the error `code` or the stage: classify with
`lib/trade-rejection.ts` (`classifyDerivRejection`) and throw `DerivTradeError`
(carries `stage`, `code`, `kind`, `brokerMessage`, symbol/contract/barrier/stake).

## Why

The autonomous engine treated every definite rejection the same way — bump
`execFailures`, hard-stop after three with the broker's raw text. One account
therefore died with `Deriv rejected 3 consecutive 1-tick buys — last: Unknown
contract proposal` and restarted into the same three failures every time, while
another account (quieter socket / different market access) never saw it. The
message named no market, no contract and no code, so nobody could tell a stale
quote from an untradeable account.

## How to apply

- `executeLiveTrade` may re-quote exactly once, and ONLY for a buy-stage unknown
  proposal (`BUY_HANDOFF_REQUOTES = 1`). Transient buy rejections (RateLimit) and
  unacknowledged buys (`TradeOutcomeUnknownError`) are never replayed — those
  invariants are tested in `single-trade-execution.test.ts`.
- Read `DerivAccountConnection.sessionSeq` before and after quoting to log which
  mechanism fired (`sessionChanged: true` = reconnect, `false` = stale/throttled).
- Wait out a rate-limit pause BEFORE quoting (`awaitSendWindow`) — quoting into a
  4 s pause guarantees a dead proposal ID.
- Engine policy lives in `lib/autonomous-hedge/execution-failure.ts` (pure):
  `unknown-proposal`/`transient` → hold, separate `quoteFailures` budget of 8;
  `contract-unavailable` → quarantine `symbol:contract:barrier` for the run and
  trade the rest, stop only when nothing is left; `account-blocked` → stop at
  once with the way out; `unspecified` → the original 3-strike stop.
- Quarantine lives in `HedgeSession.blocked`, cleared by `resetHedgeSession`, so a
  restart re-probes instead of remembering a refusal forever.
- Full write-up: `docs/autonomous-unknown-contract-proposal.md`.
