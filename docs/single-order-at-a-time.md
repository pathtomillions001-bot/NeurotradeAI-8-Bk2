# One trade at a time: why the autonomous engine stopped with "Deriv rejected 3 consecutive 1-tick buys"

## The report

```
Deriv rejected 3 consecutive 1-tick buys — last:
Unknown contract proposal (Deriv code InvalidContractProposal)
```

The engine stopped by itself. The wording ("3 consecutive 1-tick buys") made it look
like three trades were fired at the same moment.

## What was actually happening

There were two defects stacked on top of each other. Neither of them was "three trades".

### 1. ONE trade was re-sent three times, inside a second

The 1-tick cycle is tick-driven and **coalesces** ticks: a tick that lands while a cycle
is running sets `pending`, and the moment the cycle returns the follow-up runs
(`requestHedgeCycle` in `lib/autonomous-hedge/cycle.ts`).

A refused buy returns in milliseconds. So:

```
tick → cycle → decision → buy  → refused       (strike 1)
                     ↑ coalesced tick re-runs immediately, same tape, same decision
                             → buy  → refused   (strike 2)
                             → buy  → refused   (strike 3) → host.stop(...)
```

Three attempts, three strikes, but **one** analysed decision — the same tape, the same
contract, the same tick. That is the "three trades at the same time" the report describes,
and it is why the stop message names three consecutive buys.

### 2. The buys carried a proposal id the broker could not resolve

Deriv's `InvalidContractProposal` / "Unknown contract proposal" on a **buy** means the
proposal id is unknown to the session that received the purchase. On the shared account
socket that happens two ways, both routine:

- the socket **re-handshook** between the quote and the buy (pong timeout, OTP re-issue,
  idle teardown) — the id belonged to the previous session;
- the id **aged out** behind the paced send queue (10 msg/s) or a `RateLimit` pause (4 s),
  i.e. the buy was sent later than the proposal lived.

The old code quoted, then bought, and only reacted if the broker refused. A refusal was
counted as an engine strike, so a dead quote could stop the engine — and, with defect 1,
it stopped it in under a second.

## The fix

Order integrity is now enforced in `lib/deriv.ts` (the one place every engine buys through),
and the engine no longer re-sends a refused trade.

| Invariant | Where | What it does |
| --- | --- | --- |
| **Session-bound quote** | `DerivAccountConnection.sessionGeneration()` + `proposalNeedsRefresh()` | A quote records the socket session that issued it; if the session changed, the id is replaced before the buy. |
| **Freshness ceiling** | `PROPOSAL_MAX_AGE_MS` (3 s) | A quote older than a proposal's life is replaced instead of being bought. |
| **Priority buy** | `AccountRequestHooks.priority` | The buy jumps the paced send queue, so polls cannot push it past the id's life. |
| **One order pipeline per account** | `executeLiveTrade` single-flight + `LiveOrderInFlightError` / `isLiveOrderInFlight` | No two proposal → buy pipelines can interleave on one socket. The second caller is **skipped**, not raced. |
| **One analysed attempt** | `liveAttemptHoldReason` / `recordRefusedLiveAttempt` in `cycle.ts` | After a refusal: 5 s backoff **and** a new analysed tick before another live buy. A coalesced tick can never re-send the refused decision. |
| **Skips are not strikes** | `cycle.ts` catch block | `LiveOrderInFlightError` is recorded as `[NOT SENT]` and does **not** increment `execFailures`. |

The reactive replay (re-quote once and buy the fresh id) is kept as the last-resort repair,
and now runs through the same integrity check as the first attempt.

## Deliberately unchanged

- The **3-strike stop** stays. With the dead-quote case prevented it can only fire on a
  genuine, deterministic broker refusal (e.g. the account is not offered that contract on
  that market) — where stopping is the right answer, not retrying forever.
- The **proposal-stage rule** stays: the same broker sentence from `{proposal: 1}` is a
  capability verdict and is never retried. See
  `.agents/memory/deriv-buy-stage-unknown-proposal.md`.
- The **exposure gate** (one live exposure at a time) is untouched; this change is about the
  order pipeline, not settlement.

## Tests

- `src/lib/single-trade-execution.test.ts` — one purchase pipeline per account (the skipped
  caller never quotes, exactly one buy leaves the account, the slot is always released,
  even on a refusal); a re-handshake after the quote re-quotes and buys the fresh id; an
  aged quote is replaced; a fresh quote is bought as-is with `priority: true`; the
  classification helper itself.
- `src/lib/autonomous-hedge/cycle.test.ts` — the live attempt gate: first attempt passes,
  the refused tick is never re-sent, everything waits out the backoff, a new tick is allowed
  afterwards, and a purchase that went through releases the gate.

## Correction (proposal-stage refusals)

The "proposal-stage rule" above was wrong, and it was the surviving half of
this bug: when Deriv answers `{proposal: 1}` itself with
`InvalidContractProposal`, no proposal is created and no contract exists —
yet the engine counted it as a strike, so three analysed decisions that never
reached a buy stopped it with the same message. The identical contract buys
fine from the bot builder, which can buy with full parameters and no proposal
id at all (`tradeOptionToBuy`: `{buy: "1", price, parameters: {…}}`).

`executeLiveTrade` now completes that one purchase, once, with a
parameterised buy when (a) the proposal stage refuses with
`InvalidContractProposal` (`UnknownProposalError`), or (b) a fresh re-quoted
id is still unknown at the buy stage. The parameterised buy is never repeated:
a refusal surfaces unchanged, and an unacknowledged one raises
`TradeOutcomeUnknownError` as before. It carries the same analysed contract,
stake and barrier, inside the same per-account single-flight slot — so it is
still exactly one trade at a time, never a second contract.
