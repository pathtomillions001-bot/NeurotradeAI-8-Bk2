# "Deriv rejected 3 consecutive 1-tick buys — last: Unknown contract proposal"

**Symptom.** On one connected Deriv account the autonomous engine starts, places
nothing, and stops itself within a few seconds with
`Deriv rejected 3 consecutive 1-tick buys — last: Unknown contract proposal`.
Pressing start again does exactly the same thing, every time. On a different
Deriv login in the same app the engine runs normally.

## What the message actually is

The sentence is assembled in
`artifacts/api-server/src/lib/autonomous-hedge/cycle.ts` when the live buy path
catches a rejection:

```
host.stop(`Deriv rejected ${CONSECUTIVE_EXEC_FAILURE_LIMIT} consecutive 1-tick buys — last: ${message}`)
```

`message` is the broker's own `error.message`, re-thrown verbatim by
`executeLiveTrade` (`lib/deriv.ts`) from one of two places — the `proposal`
(quote) half or the `buy` half of the trade. So "Unknown contract proposal" is
**Deriv's wording, not ours**, and before this change the app threw away
everything that would have explained it: `error.code`, `error.details`, which of
the two halves refused, and the exact request that was refused. That is why the
message was undiagnosable — one sentence was carrying at least four different
problems:

| the same sentence can mean | what actually differs |
| --- | --- |
| this account is not allowed to quote that contract type on that market | account market access / contract availability / jurisdiction |
| the stake is outside this account's bounds | stake limits are per **currency**: 0.35 means 35 ¢ in USD and a third of a bitcoin in BTC |
| the proposal is priced in the wrong currency | every proposal carries `currency`, read from the stored account row |
| the buy could not resolve the proposal it was handed | a quote/buy split across a reconnected socket |

## Why one account and not the other

Everything in that table is a property of the **Deriv account**, not of the app
session, which is exactly the "works on login A, always fails on login B" shape.
The three the code made possible, verified in this repo:

1. **Currency was never verified.** `loadHedgeContext` sent
   `currency: account?.currency ?? "USD"` — the stored row — into every proposal,
   and nothing ever compared it with the login behind the socket. A row that
   disagrees (an old row, a login whose account was re-created in another
   currency, a multi-currency login where the app picked a different account)
   makes *every* proposal fail while the rest of the app looks healthy.
2. **Stake limits were hard-coded in USD.** `MIN_STAKE = 0.35` and
   `Math.round(stake * 100) / 100` are USD assumptions. On a non-USD login the
   floor is meaningless and the 2-decimal rounding can turn a crypto minimum into
   zero.
3. **Contract availability was never checked.** The engine's first act on a live
   account was spending real money. An account that cannot quote the selected
   families could only discover that by having buys refused.

## What was wrong with the handling

Independently of which of those it was, the reaction made it unrecoverable:

- **A permanent, account-scoped fact was treated as a transient broker outage.**
  Every rejection incremented one counter, and at 3 the engine stopped with no
  cooldown. The ranker is evidence-driven, so the next start ranked the same
  contracts and the broker refused them again: three strikes, every time,
  forever. That is the "cannot start at all, no matter how many times I try".
- **Nothing was excluded.** A contract the broker will not quote stayed in the
  rotation, so the same impossible quote was re-sent on the next tick.
- **Nothing was reported.** No Deriv code, no contract, no market, no currency —
  so neither the user nor a log reader could tell configuration from outage.

## The fix

**1. The broker's verdict travels with the error.** `lib/deriv.ts` now throws
`DerivApiError` (carrying `code`, `phase` = proposal/buy, the rejected request
and `details`), and `classifyDerivRejection(err)` turns it into one of
`contract-unavailable`, `stake-out-of-bounds`, `funds`, `auth`, `transient`,
`unknown`. The classifier reads the code *and* the wording, so
"Unknown contract proposal" is classified as `contract-unavailable`. Transient
answers are checked first: a throttled or restarting broker can never be read as
"this account cannot trade that contract".

**2. Capability rejections quarantine instead of striking.**
`lib/autonomous-hedge/contract-availability.ts` keeps a per-session quarantine
and `cycle.ts` uses it. On a `contract-unavailable` rejection the engine fires
two follow-up **quotes** (no money), each changing exactly one variable:

| same contract, other market | same market, other contract | scope quarantined |
| --- | --- | --- |
| ok | ok | `candidate` — that contract on that market |
| rejected | ok | `family` — that contract everywhere |
| ok | rejected | `market` — that market for every contract |
| rejected | rejected | `account` — nothing selected is tradable |
| unknown | unknown | `candidate` — a probe that did not answer never widens the scope |

The quarantined contracts are filtered out before ranking, so they can never be
picked and refused again, and they do not consume the 3-strike budget — that
budget is now only for genuine broker failures. The engine keeps trading
everything the account *can* quote. It stops only when nothing selected is left,
and then it says which contracts and which Deriv code made that true. Barriers
are not part of the key: a broker that will not quote `DIGITOVER` on a symbol
will not quote it at barrier 3 and barrier 4 either.

**3. The pre-flight asks before it spends.**
`lib/autonomous-hedge/preflight.ts` quotes every family in the user's normal +
recovery selection — one quote per family, rotated across the watched markets —
before the engine is allowed to trade. It runs on the manual toggle and on the
boot auto-resume. Blocked families are quarantined at candidate scope (one
market's verdict never silences a family everywhere). A start is refused only
when *every* selected family got a definitive capability verdict, those verdicts
span more than one market, and nothing was inconclusive; the response is
HTTP 422 with the contracts and the broker codes, which the dashboard already
shows as a toast and in `stopReasons`.

**4. The currency is the broker's.** `verifiedAccountCurrency()` (deriv.ts) reads
the account list that is already cached for balance checks, falls back to an
authenticated `balance` call, and wins over the stored row; a disagreement is
logged and the row is corrected. Proposals are now priced in the currency the
socket is actually authenticated as.

**5. Stakes respect the account's own bounds.** `getAccountStakeBounds()` reads
`min_stake`/`max_stake` from `contracts_for` for that symbol in the account's
currency (cached per session), and `clampStakeToBounds()`
(`autonomous-hedge/stake-bounds.ts`) brings the stake inside that range with
currency-aware precision. The 0.35 floor survives only as a fallback for
two-decimal currencies, and only when the broker reports no minimum. A stake that
cannot fit the range holds instead of sending a proposal the exchange must
refuse.

## What you see now

- Engine starts and trades: nothing changes.
- One family unavailable: `contract_quarantined` SSE event, a journal row marked
  `EXECUTION FAILED: … (Deriv code …)`, and the engine carries on with the rest.
- Nothing available: start refused up front — `This Deriv account cannot quote
  any of the contracts the engine is set to trade … DIGITOVER on 1HZ100V (Deriv
  code UnknownContract): Unknown contract proposal …`.
- Deriv throttling or a dropped socket: unchanged — transient answers never
  quarantine and never refuse a start.

## Tests

`pnpm --filter @workspace/api-server run test` runs:

- `src/lib/deriv-rejection.test.ts` — the classifier, including the exact
  sentence from the report and the guarantee that throttling is never read as a
  capability verdict.
- `src/lib/autonomous-hedge/contract-availability.test.ts` — scope inference,
  quarantine matching (barrier-independent), `hasTradeableContract`, summaries,
  per-session isolation.
- `src/lib/autonomous-hedge/stake-bounds.test.ts` — currency-aware rounding and
  clamping, including the crypto-precision case.
- `src/lib/autonomous-hedge/preflight.test.ts` — the whole pre-flight decision
  with an injected probe: rotation across markets, per-family barriers, partial
  blocking, refusal only when everything is blocked, never on a throttle, and
  re-verification on every start.

## What this change cannot prove

Deriv's own meaning of "Unknown contract proposal" is not documented in this
repo, and this sandbox has no route to `api.derivws.com`, so the mapping from
that sentence to `contract-unavailable` rests on the wording, not on a broker
specification. The design does not depend on getting that right: an
unrecognised answer classifies as `unknown`, which counts as an ordinary
failure and never quarantines anything, and the Deriv `code` is now logged and
surfaced, so the next occurrence names itself.
