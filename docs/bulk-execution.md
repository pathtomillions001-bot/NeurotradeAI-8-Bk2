# Bulk trades — how N legs become ONE entry

A bulk trade is `count` identical contracts (2–10) placed *as one logical entry*:
they must open on the same tick — the same entry digit for digit contracts — and
close together. This document describes how that is guaranteed, how it is
verified, and where it was broken.

Files: `artifacts/api-server/src/lib/deriv.ts` (executor, pooled socket, tick
window), `artifacts/api-server/src/lib/bulk-sync.ts` (verdict + settlement
decision), `artifacts/api-server/src/routes/trades.ts` (`POST /api/trades/bulk`),
`artifacts/trading-platform/src/pages/market-detail.tsx` (the bulk dialog).

---

## 1. The failure that was reported

> "I tried executing 5 bulk trades but the app did not execute them to my Deriv
> account, and they were not at the same time / same digit."

Two independent defects, both silent:

### 1.1 The burst was never a burst

`executeBulkLiveTrades` was documented as firing "all proposals in one
unscheduled burst — same event-loop tick, same millisecond". That was true only
for the socket its **tests** injected (`opts.otpUrl` → `openDirectSocket`, a raw
`ws`). Production used `getPooledSocket()`, whose `send()` is the account
connection's **paced queue**:

```ts
// DerivAccountConnection
const ACCOUNT_SEND_INTERVAL_MS = 25;   // 40 messages / second, by design
processQueue() { /* … sends at most ONE queued message per 25 ms … */ }
```

So a 10-leg batch was really emitted at `0, 25, 50, … 225 ms`, and each buy was
appended *behind* the quotes still in the queue. The batch spread over roughly
half a second — on a 1–2 s tick market that straddles tick boundaries: legs
entered on different ticks (different entry digit) and closed seconds apart. The
pacing was our own scheduler, not Deriv's rate limiter.

### 1.2 A batch could die without anyone being told

The socket could drop mid-batch. The pooled socket forwards no `close`/`error`
(a batch must not be declared dead by a transient drop), so the executor simply
waited out its 25 s deadline and — because nothing had been *confirmed* — the
route wrote every leg as `status = "error"` with `profit = 0`, even for legs
Deriv had accepted, and even though the settlement sweep was only slow. That is
how real trades came to look like trades that "never executed".

---

## 2. The contract the executor now keeps

```
QUOTE   →  all N proposals leave in ONE burst (ws.burst, no queue)
BARRIER →  wait (≤ 450 ms) for every leg's quote so the commit is ONE event
ALIGN   →  hold the commit until a FRESH tick window (commitDelayMs)
COMMIT  →  all N buys leave in ONE burst, same millisecond
VERIFY  →  every leg carries Deriv's own start_time + the burst that carried it
```

Latency budget: quote round trip + one tick period at worst (`BULK_MAX_ALIGN_WAIT_MS`
caps the alignment hold at 2.2 s). A leg that cannot be quoted in time is
re-quoted and committed in a **follow-up burst** and flagged `splitTick`, so a
split entry is reported as a split, never as a synchronization.

### 2.1 `burst()` — the primitive that was missing

```ts
connection.burst(messages, hooks?) // straight to the socket, one event-loop turn
```

The paced queue still governs every ordinary request (`portfolio`,
`profit_table`, journal polling). A burst is bounded by construction (≤ 10 legs ×
2 phases), stays far under Deriv's 100 msg/s per-connection ceiling, and the
pacing resumes immediately afterwards.

### 2.2 Tick alignment — `commitDelayMs()`

A same-millisecond burst can *still* be overtaken by a tick boundary while the
messages are in flight. The only defence is to give the burst a whole window:

```ts
commitDelayMs(now, { periodMs, windowStartMs })
// 0  → commit now: no window data, feed rolled over/stalled, plenty of headroom,
//      or the next boundary is further away than maxWaitMs
// >0 → ms until the next boundary + 120 ms offset
```

- `windowStartMs` is the **epoch Deriv stamped on the last tick**, not our
  receipt time, so a delayed feed cannot shift the boundary
  (`tickManager.getTickWindow(symbol)`).
- Headroom target: `min(450 ms, periodMs / 2)`. On a 1 s market the batch waits
  at most ~1 s and then has ~880 ms of window in front of it.
- Only the FIRST burst is aligned — a later leg is a second tick by definition
  and is flagged as such.

### 2.3 Reconnect — a dropped socket no longer strands a batch

`DerivAccountConnection` emits `dropped` when its transport dies. The executor
puts every unconfirmed leg back in the queue and re-quotes it on the reconnected
socket (the pool reconnects transparently and fetches a fresh OTP). Attempt-
suffixed `req_id`s (`bulk-{proposal|buy}-{leg}-{attempt}`) mean a late response
from a superseded attempt can never double-buy a leg — asserted by the tests.

---

## 3. Verification, because a claim is not a measurement

Every delivery carries a receipt:

```ts
{ contract, receipt } | { error, receipt }
receipt = { index, startedAtMs, confirmedAtMs, burst, splitTick }
```

`bulk-sync.ts` converts receipts (plus Deriv's `sell_time` from the settlement
sweep) into one verdict, which the API returns as `sync` and the UI shows:

| verdict         | meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| `synchronized`  | every leg Deriv accepted shares one start time (and closes together) |
| `split`         | all legs opened, but at different start times — names the legs       |
| `partial`       | only some legs opened                                                |
| `failed`        | no leg opened                                                        |
| `unverified`    | a start time is missing, so sync can be neither proven nor disproven |

`unverified` exists so a missing field can never be reported as a success.

---

## 4. Settlement: a live contract is never an error

```ts
decideLegSettlement({ opened, result, stake, … })
```

- confirmed → `won` / `lost` with Deriv's exact profit, payout `stake + profit`
  (rounded to cents, never IEEE-754 residue);
- **opened but not journalled yet → stays `open`** with its `deriv_contract_id`,
  a journal note, and no completion event — the reconciliation sweep
  (`lib/trade-reconciler.ts`, first pass +15 s then every 60 s) settles it from
  Deriv's own profit table;
- never opened → `error` with Deriv's reason.

The route writes each leg's `deriv_contract_id` **the instant the buy returns**,
exactly like the single-trade path (`routes/trades.ts`), so an interrupted request
can always be reconciled exactly instead of guess-matched by
symbol/stake/time (N identical legs made that guessing ambiguous).

---

## 5. Limits and guards

- 2–10 legs per request, enforced in the API and clamped in the UI.
- A batch whose total stake exceeds the wallet balance is refused **up front**:
  Deriv would otherwise open the first legs and reject the rest, producing
  exactly the partial batch this feature exists to prevent.
- The whole batch shares one 25 s execution deadline; on expiry it resolves with
  per-leg outcomes (never a blanket failure).

---

## 6. Tests

| file                                     | proves                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `bulk-execution.test.ts`                 | injected-socket behaviour: hostile throttle → every leg bought once; single hard rejection isolated |
| `bulk-pooled-execution.test.ts`          | **the production transport**: fake Deriv REST + WS, real `getPooledSocket`; 10 quotes and 10 buys each leave in ONE burst (< 20 ms; the paced queue would be ≥ 225 ms), alignment holds the commit and still fires one burst, and a socket killed mid-batch still buys every leg exactly once |
| `bulk-sync.test.ts`                      | the verdict table and `decideLegSettlement` (including "opened but unsettled stays open") |

```
pnpm --filter @workspace/api-server run test
```

---

## 7. Debugging a live batch

The server logs (and the `sync` block of the response) carry everything needed:

- `executeBulkLiveTrades: QUOTE burst …` — `asked`/`sent` per burst;
- `executeBulkLiveTrades: holding the commit for a fresh tick window …` — `delayMs`;
- `executeBulkLiveTrades: COMMIT burst …` — `burst`, `legs`, `splitTick`,
  `alignedToTick`;
- `Bulk batch synchrony report` — `verdict`, `sameEntryTick`, `sameExitTick`,
  `entryTimes`, `localConfirmSpreadMs`, `splitTickLegs`;
- `trade-reconciler: Reconciler settled an interrupted trade …` — any leg that
  had to be settled asynchronously.
