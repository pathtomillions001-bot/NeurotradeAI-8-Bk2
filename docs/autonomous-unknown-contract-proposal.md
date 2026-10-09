# "Deriv rejected 3 consecutive 1-tick buys — last: Unknown contract proposal"

## Symptom

One connected Deriv account starts the autonomous engine, it immediately stops
with:

```
Deriv rejected 3 consecutive 1-tick buys — last: Unknown contract proposal
```

and restarting the engine reproduces the same stop every time, within seconds.
A different Deriv account connected to the same app runs the same engine, the
same markets and the same contract sets without ever hitting it.

## What the message actually is

"Unknown contract proposal" is Deriv's `InvalidContractProposal` error. It is
**not** a message about the market, the digit or the stake — it is the broker
saying *"the proposal I was asked to act on does not exist here"*.

The engine buys in two steps (`executeLiveTrade`, `artifacts/api-server/src/lib/deriv.ts`):

1. `{ proposal: 1, amount, basis: "stake", contract_type, currency, duration: 1, duration_unit: "t", underlying_symbol }`
   → Deriv answers with a **proposal ID** and an `ask_price`.
2. `{ buy: <proposal ID>, price: <ask_price> }` → the contract.

A proposal ID is only valid **inside the session that issued it**, and only
until it goes stale. So `InvalidContractProposal` can come from two different
requests, and the two mean opposite things:

| Stage | Meaning | Deterministic per account? |
|---|---|---|
| `buy` | The ID we quoted is no longer known to the session that received the purchase. **No contract was created.** | No — it is a timing/session race |
| `proposal` | This account is not offered that contract on that market (market access, closed market, unsupported contract type or barrier, currency). | Yes — every tick, every restart |

`executeLiveTrade` used to throw `new Error(msg.error.message)` for both, so the
stage and the Deriv error **code** were discarded before the engine ever saw
them. The engine could only react to the text.

## Why one account and not another

Ranked by how well each explains "always this account, never the other one,
never survivable by a restart":

1. **The quote goes stale before the purchase is sent (buy stage).**
   Every Deriv account has ONE pooled, multiplexed trading socket
   (`getAccountConnection`), shared by trade execution, settlement polling,
   balance sync and the journal. That socket paces sends at 10 msg/s
   (`ACCOUNT_SEND_INTERVAL_MS = 100`) and **pauses everything for 4 s** whenever
   Deriv reports a rate limit (`ACCOUNT_RATE_LIMIT_PAUSE_MS = 4_000`) — and
   Deriv's rate budget is per *user*, not per account. A 1-tick quote priced on
   the current tick is worthless a few seconds later, so an account whose socket
   is busy or throttled (more open contracts, a heavier journal, another app or
   browser tab trading the same Deriv login, a noisier reconnect history)
   reliably buys a dead proposal ID, while a quieter account never does.
2. **The session is replaced between the two steps (buy stage).** The pool
   reconnects (no pong for 60 s, socket error, idle destroy, OTP re-handshake).
   A proposal quoted on session N and purchased on session N+1 is "unknown" by
   definition. Accounts differ in how often their socket flaps.
3. **The account is not offered that contract (proposal stage).** Synthetic
   indices are not available to every landing company / country / account type,
   and a currency the engine assumes (`account.currency ?? "USD"`) may not be the
   account's. This is fully deterministic and would look exactly like the report.

Mechanism 3 is the one that makes the engine *unable to start at all*, and it is
the one the old code could never distinguish from 1 and 2.

## Why restarting never helped

`POST /api/ai/engine/toggle` → `startEngineFor` → `resetHedgeSession` clears the
per-run counters, so the engine starts clean. But the next tick re-ranks the same
tape, picks the same winner, quotes the same contract on the same throttled or
untradeable path, and fails three times again — a few seconds after every start.
The failure counter was reset; the *cause* was not.

## The fix

### 1. `lib/trade-rejection.ts` (new, pure)

One vocabulary for broker refusals, so every engine reacts to what Deriv meant
instead of string-matching its prose:

- `classifyDerivRejection({ stage, code, message })` →
  `unknown-proposal` | `contract-unavailable` | `account-blocked` | `transient` | `unspecified`
- `stage` breaks the tie for the ambiguous codes: `InvalidContractProposal` from
  a `buy` is a broken handoff; from a `proposal` it is an untradeable contract.
- `describeDerivRejection(...)` builds a sentence that names the **market**, the
  **contract** ("Over 3 on R_100") and the **Deriv code** — none of which the raw
  broker text carries.
- `rejectionFromEnvelope(msg, fallbackStage)` reads code + stage straight off a
  WebSocket reply.

### 2. `lib/deriv.ts` — `executeLiveTrade` completes the purchase instead of losing it

- Throws `DerivTradeError` (still an `Error`, message keeps the broker's own
  words and appends `(Deriv code …)`) carrying `stage`, `code`, `kind`,
  `brokerMessage`, `symbol`, `contractType`, `barrier`, `stake`, `currency`.
- **One re-quote when, and only when, the buy is rejected as an unknown proposal
  ID.** That rejection is proof no contract exists, so buying the *fresh* ID
  completes the single purchase the caller asked for. It is not a repeated buy:
  every other rejection — including a transient one such as `RateLimit` — is
  still thrown on the first attempt, and an unacknowledged buy is still a
  `TradeOutcomeUnknownError` that is never replayed.
- Logs which mechanism fired: `DerivAccountConnection.sessionSeq` (new) is read
  before and after the quote, so `sessionChanged: true/false` in the warning
  separates "the socket re-handshook mid-flight" from "the quote simply expired".
- `awaitSendWindow()` waits out a rate-limit pause **before** quoting, so the
  purchase is never sent from a queue that is 4 s behind its own quote.

### 3. `lib/autonomous-hedge/execution-failure.ts` (new, pure)

What the engine does with a refusal:

| Kind | Action |
|---|---|
| `unknown-proposal`, `transient` | Hold, re-quote next tick. Counted in a separate `quoteFailures` budget (8), **not** the 3-strike counter. Stops only after 8, and says plainly that nothing was purchased. |
| `contract-unavailable` | Quarantine that `symbol:contract:barrier` for the run and trade the rest of the selected set. Stop only when the account has refused everything it was offered — with the offending contracts named. |
| `account-blocked` | Stop immediately with the reason and the way out (top up / lift self-exclusion / reconnect). No strikes wasted. |
| `unspecified` | Unchanged: 3 consecutive definite rejections stop the engine — but the reason now names the market, contract and code. |

### 4. `lib/autonomous-hedge/cycle.ts`

- `HedgeSession` gains `quoteFailures` and `blocked` (cleared by
  `resetHedgeSession`, so a restart re-probes contracts rather than remembering
  a refusal forever).
- `collectMarketCandidates` skips quarantined candidates and reports which keys
  were skipped; when the broker's offer list is now empty the engine stops with
  `"Stopped: this Deriv account refused every contract it was offered (…)"`
  instead of holding silently — the case that looks like "the engine will not
  start".
- A placed purchase clears both counters.
- `trade_completed` SSE now carries `errorKind`, `errorCode`, `retryable` and
  `quarantined`, and the journal's `agentReasoning` records the full sentence.

### 5. `lib/friendly-error.ts`

Code → trader-readable text for `InvalidContractProposal`, `UnknownContract`,
`InvalidSymbol`, `InvalidBarrier`, `MarketClosed`, `ContractBuyValidationError`,
`SelfExclusion`, `InsufficientBalance`, so any surface that sanitises a raw
broker error says something useful.

## What the user sees now

- If it was a stale quote or a replaced session: nothing. The engine re-quotes
  and trades; at most the journal shows one held attempt.
- If the account genuinely cannot trade the selected contracts: the engine skips
  them, keeps trading the rest, and if there is nothing left it stops with
  *"this Deriv account cannot trade any contract in your selected set — Unknown
  contract proposal (Deriv code InvalidContractProposal) — Over 3 on R_100: this
  Deriv account is not offered that contract on that market. Pick different
  contracts or markets, or connect an account that can trade synthetic indices."*
- If the account is out of balance / self-excluded / de-authorised: it stops on
  the first refusal with the fix ("Reconnect this Deriv account from the Connect
  page", "Lower the stake or top up this Deriv account").

## Confirming which mechanism an account hit

`executeLiveTrade` logs one line per occurrence:

```
executeLiveTrade: the trading session was replaced between quote and purchase — re-quoting on the live session
executeLiveTrade: the proposal ID was unknown when the purchase arrived — re-quoting once
```

and the engine logs the classified refusal:

```
Autonomous 1-tick buy rejected by Deriv
  code: "InvalidContractProposal"  stage: "buy" | "proposal"
  kind: "unknown-proposal" | "contract-unavailable" | ...
  symbol: "R_100"  contract: "DIGITOVER"  barrier: 3
  quoteFailures: n  blockedCount: n
```

`stage: "proposal"` ⇒ mechanism 3 (account/market access — check the account's
country, landing company, currency and whether it can trade synthetic indices at
all on app.deriv.com). `stage: "buy"` with `sessionChanged: true` ⇒ reconnects;
`false` ⇒ throttling/staleness (close other apps trading the same Deriv login).

## Tests

- `lib/trade-rejection.test.ts` — the same broker text classifies differently by
  stage; transient, account-level and availability codes; envelope parsing;
  described text.
- `lib/autonomous-hedge/execution-failure.test.ts` — a handoff refusal no longer
  stops the engine at three; quarantine keeps the run alive and stops only when
  nothing is left; account refusals stop at once; the unclassified 3-strike path
  is unchanged.
- `lib/single-trade-execution.test.ts` — one re-quote buys the FRESH proposal ID;
  never a third purchase; a refused proposal is never bought; the pre-existing
  invariants (no repeat of a transient-refused buy, no repeat of an
  unacknowledged buy) still hold.
