---
name: Deriv "Unknown contract proposal" is stage-dependent, and a buy must ride the session that quoted
description: The same broker text from `buy` and from `proposal` means opposite things; the dead-quote case is now PREVENTED (session-bound quote, freshness ceiling, priority buy, one order pipeline per account) rather than repaired after the fact.
---

## Rule

Deriv's `InvalidContractProposal` / "Unknown contract proposal" is **stage-dependent**, and the two stages must never be handled alike:

- from `{ buy: <id> }` → the proposal id is unknown to the session that received the purchase. Resolving that id is the step *before* contract creation, so **no contract exists**. Re-quote ONCE and buy the fresh id at *that* quote's own ask price — that completes the single requested purchase, it is not a repeated buy.
- from `{ proposal: 1, … }` → this account is not offered that contract on that market (market access / landing company / country, closed market, unsupported contract type or barrier, wrong `currency`). Deterministic: it fails on every tick and after every restart, so it must never be retried.

Classify with `isUnknownProposalRejection()` in `lib/deriv.ts` and only ever on a **buy** reply. Keep the broker's error `code` in the thrown message (`describeDerivRejection`) so a UI panel, the engine stop reason and the journal can be told apart after the fact.

## Why (the four invariants that keep the dead-quote case from happening)

`executeLiveTrade` buys in two steps on the account's ONE pooled trading socket: `{proposal: 1, …}` → proposal **id**, then `{buy: <id>, price: <ask>}`. That id only exists inside the session that issued it, and it dies two ways that are both routine here: a **re-handshake** between the two calls, and the id **aging out** behind the send queue / a `RateLimit` pause. The pipeline is now built so neither can reach the broker:

1. **Session-bound quote** — `DerivAccountConnection.sessionGeneration()` is bumped on every successful handshake; a quote records the generation it was issued in, and `proposalNeedsRefresh()` forces a re-quote when the live generation has moved on.
2. **Freshness ceiling** — `PROPOSAL_MAX_AGE_MS` (3 s): a quote older than that is replaced before the buy instead of being sent as a dead id.
3. **Priority buy** — `AccountRequestHooks.priority` puts the buy at the FRONT of the paced send queue, so a burst of settlement polls can never push it past the proposal's life.
4. **One order pipeline per account** — `executeLiveTrade` is single-flight per `accountId` (`LiveOrderInFlightError`, `isLiveOrderInFlight`). Racing purchases interleave proposals and buys on the shared socket; they are now skipped, never interleaved.

The reactive replay (re-quote once, buy the fresh id) is kept as the last-resort repair and runs through the same integrity check.

## How to apply

- Do NOT remove the reactive replay or the proposal-stage test (`single-trade-execution.test.ts`): the replay is the safety net, the stage rule is the classification.
- A skipped caller sees `LiveOrderInFlightError`. That is a **skip, not a broker refusal** — the autonomous engine must never count it as a strike (`cycle.ts` classifies it as `[NOT SENT]`).
- The autonomous engine's 3-strike stop is unchanged on purpose: with the dead-quote case repaired it only fires on genuine, deterministic broker refusals, where stopping is the right answer. What changed is that a refusal can no longer be re-sent on the same coalesced tick (`liveAttemptHoldReason`: 5 s backoff + a NEW analysed tick), so "3 consecutive buys" can never again mean one trade machine-gunned three times inside a second.
- Never re-introduce a caller that buys outside `executeLiveTrade` without the same three guarantees.
