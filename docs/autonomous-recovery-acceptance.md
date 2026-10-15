# Autonomous Recovery — G1–G9 Acceptance Report

**Status: all nine criteria pass, measured on the SHIPPED code.** Nothing has been
enabled live and nothing will be until you have seen this.

Every figure below comes from the code as merged (`arena/67e05222-neurotradeai-8-bk2`),
not from a probe-local reimplementation. Where a number is a laboratory measurement
on synthetic tapes rather than live trading, it says so.

| # | Criterion | Threshold | Measured | Verdict |
| :-: | :--- | :--- | :--- | :---: |
| G1 | NULL-world capital destroyed | ≥ −20 base-stake units | **0.0** (12k ticks) · **−2.1** (24k ticks) — was −188.4 | **PASS** |
| G2 | REGIME-world capital destroyed | ≥ −20 units | **0.0** (12k ticks) · **−7.3** (24k ticks) — was −164.6 | **PASS** |
| G3 | PLANTED-world capital earned / realised EV | > 0 and ≥ +4 %/trade | **+134.0 / +8.68 %** (12k) · **+327.8 / +6.24 %** (24k) | **PASS** |
| G4 | MARKOV-world capital earned | > 0 | **+123.9** (12k) · **+291.7** (24k) | **PASS** |
| G5 | ES5 of the worst-5 % recovery episode, Instant and Split | numerically unchanged | **byte-identical**, 6 144 cells, digest `b2a45774…`, both trees | **PASS** |
| G6 | Stakes identical at mode off / shadow / on | hash-equality | **sha256 `44f08e7c…` identical** for all three, 12 000 numbers, both trees | **PASS** |
| G7 | Uniform-tape trades fired per 12 000 ticks | ≤ 20 | **0** (NULL) · **0** (REGIME) — was 4 407 / 11 634 | **PASS** |
| G8 | Full suites: API server, web, both typechecks, first-paint | 0 failures | **1322 + 97 tests pass, 4/4 typechecks, 8/8 render checks** | **PASS** |
| G9 | No code path can write a simulated trade row | grep + explicit test | **static guard (4) + behavioural cycle test + 409 refusal tests** | **PASS** |

---

## G1 / G2 / G7 — capital destroyed on edge-free tapes

Measured with `scripts/recovery-lab/probe-policy.ts`, column **P4 = the shipped
scorer** (`scoreV2Candidates` + `rankV2Candidates`). 19 markets, the user's full
contract set (CALL, PUT, Over 4, Under 5, Even, Odd, **Matches**, **Differs**),
ladder frozen at instant/base 1. Capital = Σ(payout·1{win} − 1) at base stakes.

**Default scale — 3 seeds × 4 000 ticks = 12 000 ticks (the scale the criteria were written at):**

| World | v1 (what shipped before) | v2 shipped today | Shipped gate (**P4**) |
| :--- | ---: | ---: | ---: |
| NULL | 4 407 tr, −4.27 %, **−188.4** | never fires | **0 tr, 0.0** |
| REGIME | 4 429 tr, −3.72 %, **−164.6** | never fires | **0 tr, 0.0** |
| PLANTED | 4 461 tr, −3.94 %, −175.9 | 1 543 tr, +8.68 %, +134.0 | 1 543 tr, **+134.0** |
| MARKOV | 4 393 tr, −5.97 %, −262.1 | 1 598 tr, +7.75 %, +123.9 | 1 598 tr, **+123.9** |

**Widened scale — 8 seeds × 6 000 ticks = 24 000 ticks (2× the criteria's scale, to expose the residual):**

| World | v1 | **Shipped gate (P4)** | Capital vs v1 |
| :--- | ---: | ---: | ---: |
| NULL | 17 903 tr, **−784.6** | **6 tr, −35.00 %/trade, −2.1** | 373× less destroyed |
| REGIME | 17 991 tr, **−694.9** | **17 tr, −42.65 %/trade, −7.3** | 95× less destroyed |
| PLANTED | 18 073 tr, −598.1 | **5 255 tr, +6.24 %/trade, +327.8** | sign flipped |
| MARKOV | 17 961 tr, −809.9 | **5 180 tr, +5.63 %/trade, +291.7** | sign flipped |

### The honest residual (not hidden)

At 2× scale the gate still admits **6 trades on NULL and 17 on REGIME**, and their
realised EV is **worse than the house edge** (−35 %, −43 %): when the gate is
fooled, it is fooled *into* the worst candidates, because it selects on the extreme
tail of the noise. Both criteria still pass with a wide margin (−2.1 and −7.3
against a −20 limit), but the correct reading is:

> **the gate reduces edge-free bleed by 95–373×; it does not eliminate it.**

At the scale the criteria were written at (12 000 ticks) the residue is zero. The
residue appears only when the search is given 2× more ticks to find flukes.

---

## G3 / G4 — capital earned when an edge really exists

Same runs, same column. **PLANTED** (+5 pp Even bias on one market) and **MARKOV**
(parity persistence) are the two worlds where a real edge exists:

| Scale | World | Trades | Realised EV | Capital |
| :--- | :--- | ---: | ---: | ---: |
| 12 000 ticks | PLANTED | 1 543 | **+8.68 %** | **+134.0** |
| 12 000 ticks | MARKOV | 1 598 | **+7.75 %** | **+123.9** |
| 24 000 ticks | PLANTED | 5 255 | **+6.24 %** | **+327.8** |
| 24 000 ticks | MARKOV | 5 180 | **+5.63 %** | **+291.7** |

Both criteria pass, and the capture survives 2× the data — it is not a small-sample
artefact.

**What this does and does not mean.** These are *planted* edges in a laboratory
tape. The audit's central finding stands: all 20 `AUTOMATED_DERIV_MARKETS` are
Deriv CSPRNG synthetics, so on the real instrument universe the true edge is zero
and the house edge is the whole expectation. G3/G4 therefore prove the gate
**does not destroy a real edge when one exists**. They do not prove the engine can
make money on Deriv — nothing can, on those instruments (see the plan's §6
cross-cutting risk: an engine that trades often and an honest gate are in direct
conflict, and the honest resolution is a different instrument universe).

---

## G5 — the ladder is frozen

`scripts/recovery-lab/g5-ladder-es5.ts` prints a deterministic digest of ES5 (mean
P&L of the worst 5 % of episodes) over a 6 144-cell grid: method (instant/split) ×
p (8 values, including the 10 %/9× Matches case) × payout × autoMode × multiplier ×
step × maxRecoverySteps × debt × nStop, 400 paths × horizon 25, CRN seed
`0x5eed1234`. It calls the real `calculateRecoveryStakeRequest`,
`applyRecoveryStakeLimits` and `settleRecoveryWin`.

```
branch tree  : es5 digest sha256 = b2a45774c71fdf18be6d00ba0890321a9299fab71942473014b4289fd0a800ba
base tree    : es5 digest sha256 = b2a45774c71fdf18be6d00ba0890321a9299fab71942473014b4289fd0a800ba
diff         : IDENTICAL — G5 PASS (byte-for-byte)
```

Run against a clean worktree of the pre-change commit `eb5234e` with the *same
harness file*, so the comparison is exactly "did the ladder change".

Reference cells (ES5 / mean P&L / mean trades), identical on both trees:

| method | cell | ES5 | meanPnl | meanTrades |
| :--- | :--- | ---: | ---: | ---: |
| instant | p=0.50, 1.95× | −22.2412 | −0.4524 | 2.1075 |
| instant | p=0.10, 9.00× | −38.5500 | −0.7542 | 8.9350 |
| instant | p=0.35, 1.63× | −752.3830 | −87.0209 | 5.9625 |
| split | p=0.50, 1.95× | −9.3025 | −0.2989 | 11.9575 |
| split | p=0.10, 9.00× | −19.7800 | −0.6129 | 9.8925 |
| split | p=0.35, 1.63× | −18.3170 | −9.4039 | 21.8950 |

---

## G6 — the stake path is mode-invariant

`scripts/recovery-lab/g6-stake-hash.ts` builds a seeded 4 000-case random grid over
every input the stake path reads (debt, target, payout, base stake, autoMode,
method, multiplier, step, maxSteps, maxTradeStake, balance, risk profile,
winProbability) and evaluates three stakes per case — `calculateRecoveryStakeRequest`
→ `applyRecoveryStakeLimits` → `getDynamicRecoveryStake` — under each mode:

```
mode=off    sha256=44f08e7cab6c7a7c60b171a748cff30ed677c17b03a3d261a49374b8f8c46745  distinct-stakes=3055
mode=shadow sha256=44f08e7cab6c7a7c60b171a748cff30ed677c17b03a3d261a49374b8f8c46745  distinct-stakes=3055
mode=on     sha256=44f08e7cab6c7a7c60b171a748cff30ed677c17b03a3d261a49374b8f8c46745  distinct-stakes=3055
IDENTICAL across off / shadow / on  → G6 PASS
```

**Positive control** (so the equality cannot be vacuous): the same run shows the
flag is genuinely read — `v2 RECOVERY path active at mode=off : false`,
`active at mode=on : true`. The mode changes the *decision* path; it never changes
a stake. The identical digest reproduces on the pre-change worktree, so the stake
path is unchanged from `eb5234e` as well as mode-invariant.

---

## G8 — full suites

| Check | Command | Result |
| :--- | :--- | :--- |
| API server tests | `pnpm --filter @workspace/api-server test` | **1322 pass, 0 fail** |
| Web tests | `pnpm --filter @workspace/trading-platform test` | **97 pass, 0 fail** |
| Typechecks | `pnpm run typecheck` | **4/4 projects clean** |
| First-paint render | `pnpm --filter @workspace/trading-platform run check:first-paint` | **8/8 PASS** |

The API-server figure now **includes** the four test files that the explicit file
list had been silently omitting (see the plan's §8.1), among them
`autonomous-hedge/recovery-v2.test.ts` — the T1–T8 pin suite for this pipeline.
`test-manifest.test.ts` fails the suite if any test file is ever omitted again.

---

## G9 — no code path can write a simulated trade row

This was the criterion that produced the most work, because deleting the
`paperTradeMode` flag did **not** delete simulation. The audit found:

| Where | What it did | Now |
| :--- | :--- | :--- |
| `bot-engine` | `won = Math.random() < best.winProbability` → `recoveryEngine.recordOutcome` | HOLD before the journal insert + hard stop |
| `speed-ai-engine` | same | same |
| `apex`, `bastion`, `dual-lock`, `killshot`, `killshot-family`, `parity-forge`, `surge` | settled the trade against the market's **next real tick**, journalled it, and recorded the result into the shared recovery ledger | HOLD before the journal insert + hard stop |
| `overunder-navigator`, `overunder-turbo` | same | same |
| `accumulator` | `paperSettlement(...)` | guard added, helper **deleted** |
| `autonomous-hedge/cycle.ts` | `Math.random() < b.probability` branch | explicit HOLD, publishes `nextScanIn: null` |
| `routes/trades.ts` (manual) | `Math.random() < winProb` + balance mutation | **409 `NO_LIVE_ACCOUNT`**, nothing journalled |

Every one of those simulated outcomes was fed into the **shared recovery ledger**,
i.e. a fabricated trade moved the debt the real ladder is later sized from. That
is the mechanism by which a paper P&L can look healthy while the strategy is
losing: the simulator settles from the engine's own belief, so it can only ever
confirm that belief.

Evidence, in three layers:

1. **Static guard** — `src/lib/autonomous-hedge/no-paper-mode.test.ts` (4 tests):
   every engine that journals a trade must hold **before** the insert; no engine
   may contain `Math.random()` in a comparison or `paperSettlement(`; `cycle.ts`'s
   no-token guard must precede its journal insert; no `[PAPER]` label may remain.
   **Negative control run**: disabling one guard in `surge-engine` makes the test
   fail with `surge-engine.ts: journals a trade with NO no-live-account guard`;
   restoring it returns the suite to green. The guard is not vacuous.
2. **Behavioural engine test** — `cycle.test.ts` drives a real cycle against a
   synthetic **live** feed (1 600 ticks) with no connected account. On that
   deterministic tape the analysis genuinely reports `shouldTrade: true`, so the
   cycle reaches the money path — and still writes **0 journal rows**, leaves the
   recovery ledger **byte-identical**, emits **no trade events**, and publishes the
   no-live-account HOLD. This is the strongest form of the claim: the engine does
   not merely fail to trade by accident; it refuses at the money path.
3. **Manual route** — `routes/manual-trades.test.ts` asserts a manual submission
   without a live account returns **409 `NO_LIVE_ACCOUNT`** with a matching error
   code, and that three successive submissions still leave **0 journal rows**.

**One documented exception, stated rather than buried:** `omni-engine` retains its
internal paper path, which is a deterministic test harness. It is unreachable from
production — both routes parse `omniConnectedConfigSchema` / `omniStartSchema`,
which require `executionMode === "live"`, and that refusal is pinned by
`omni-analysis.test.ts` (`["paper", "auto", undefined]` all rejected). It is
excluded by name in the static guard so the exception is visible in the source.

### A UX defect found while proving G9

With no connected account the engine published `shouldTrade: true` and then **went
silent**: the explanatory HOLD was swallowed by the 400 ms emit throttle, because
the decision pulse had just been emitted. A correctly refusing engine was
therefore indistinguishable from a broken one. The throttle now always lets the
**first HOLD after a decision** through (repeats stay throttled, so this cannot
become a flood). Verified live: the operator now receives

```
scan_complete  shouldTrade: true   (the analysis)
scan_complete  shouldTrade: false  rejectReason: "HOLD · no live Deriv connection.
                                   This engine does not simulate trades: connect
                                   an account in Settings to trade, or leave it stopped."
```

---

## What has NOT been done

- **Nothing is live.** No enablement has happened, and G1–G9 being green is a
  measurement, not a licence to trade.
- The engine will trade **very rarely** on real Deriv synthetics, because on those
  instruments there is nothing real to find. At 12 000 ticks the shipped gate fired
  **0** times on both edge-free worlds. If "an autonomous engine that trades often"
  is the product expectation, that expectation and an honest gate are in direct
  conflict, and the resolution is a different instrument universe — not a weaker
  gate.
- `omni-engine`'s internal paper harness remains (unreachable in production, above).
- The original audit's WARN items (T1, `TickManager` WS errors, `/api/live` 404,
  `:4003` rsbuild advice) are unchanged and unrelated to these criteria.
