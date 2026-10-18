# Hedge Pair Forge · as built — deep-tape analysis, market switching, pair-local recovery

> **BUILT.** This is the as-built record for the Hedge Pair Forge DBot factory
> (console revision `hedge-pair-forge@2`). It answers four user reports against
> the code that actually shipped, with the arithmetic, the file/line references
> and the tests that prove each fix. Read `docs/digit-forge-market-switching.md`
> first for the switching handshake this bot reuses, and
> `docs/recovery-trade-mathematical-design.md` for the repo-wide recovery rules
> this bot deliberately diverges from in exactly one place (§4.3).

Three layers, no server-side engine:

| Layer | Path | Role |
| --- | --- | --- |
| Console | `artifacts/trading-platform/src/components/hedge-pair-forge-console.tsx` | Chooses family, offsets, tape depth, watch list, risk limits; POSTs `/api/bots/hedge-pair/dbot`; loads the XML into the embedded Builder |
| Generator | `artifacts/api-server/src/lib/hedge-pair-dbot.ts` + `src/routes/hedge-pair.ts` | Validates, projects the recovery ladder, emits Blockly XML with 3 initialization notifies and 11 build warnings |
| Runtime | `artifacts/dbot-builder/.../tradeEngine/trade/HedgePair.js` + `hedge-pair-analysis.js` | The cycle itself: tape → replay → gate → rank → paired buy → monitor → settle → size recovery |

Everything below is in the generated DBot. **Create DBot only loads the
strategy; Deriv Builder's Run button is the sole trade-start control**, and the
paired buys are non-atomic (partial fills are compensated where the live API
allows it, then the bot halts).

---

## 0. Verdict — four reports, four distinct root causes

| # | Report | Root cause | Fix | Proof |
| --- | --- | --- | --- | --- |
| A | "Only Over 5 / Under 4 is analysed; the other pairs do nothing" | Three independent causes: one-pip offsets were rounded to **zero** by Blockly's number field; the 1 000-tick ring starved every expiry family; ONLY_UPS_DOWNS tripped its own double-loss breaker. And there was **no edge gate at all** | `OFFSET_PRECISION 1e-8`, deep tape (4 999 ticks), duration-aware sample floor that *names* its arithmetic, hard/soft blocker split, real EV gate | §1; `hedge-pair-analysis.spec.js` (46), preview round trip on a one-pip fixture |
| B | "No visible analysis flow, nothing in the journal" | `ntPairLogHold` was epoch-gated and 12 of its 15 call sites passed `epoch = 0`, so each hold printed **once**; flow labels were reused across symbols so the per-label rate limiter swallowed them; the XML had **zero** notifies and the status block had no analysis fields | Wall-clock 30 s heartbeat, symbol-keyed labels (`HP TAPE · R_50`), `HP ANALYSING` / `HP RANK` / `HP SWITCH` lines, 3 build notifies, 35 status fields | §2; `hedge-pair-markets.spec.js` (16) |
| C | "It cannot switch markets" | No `MARKETS` field existed, `nt_switch_market` was not in the block allowlist, and the cycle had no ranker — even though `Bot.ntSwitchMarket` already existed and was tested | Ranking + switching **inside** `ntHedgePairCycle` (no extra block in the XML), watch list normalized at build time and by the route, 8-market socket budget | §3; `hedge-pair-markets.spec.js` |
| D | "The recovery multiplier is wrong — two trades are risked at once" | Debt was already both premiums, but the sizing used the shared single-contract multiplier default (1.62) as a **ladder ceiling** that clamped the debt-driven size, and a split **disarmed** recovery, stranding the residual | Pair-local `RECOVERY_MULTIPLIER 2.43` + `MARKUP_PERCENT 40`, canonical debt-driven per-leg formula, re-arm fix, residual carry, refusal below a 2.00× winning leg, build-time projection | §4; `hedge-pair-analysis.spec.js`, `hedge-pair-dbot.test.ts` (11) |

Test totals after the change: Builder trade engine **203 passed / 3 failed**
(the 3 failures are pre-existing at HEAD — see §9), Builder preview **6/6**,
api-server **1271 passed / 0 failed**, trading-platform **97 passed / 0 failed**.

---

## 1. Report A — why only Over 5 / Under 4 ever traded

Over 5 / Under 4 is the **only** family whose offsets are digits, not prices.
Every other family's default offset is one pip (`10^-pipSize`, pipSize 4 for
R_50/R_75/RDBULL/RDBEAR and 3 for R_10/R_25/1HZ*V — `artifacts/api-server/src/lib/deriv.ts:368-382`),
so all five price-barrier families shared one bug and the two digit families
shared another.

### 1.1 One-pip offsets were rounded to zero by Blockly (kills 5 of 7 families)

The block declared `new FieldNumber(0.5, 0, 100000, 0.01)`. In Blockly 10.4.3
`FieldNumber.doClassValidation_` computes `decimalPlaces` from the precision
argument (0.01 → **2**) and rounds *every* value — including one read back from
XML — through `toFixed(decimalPlaces)`. So the generator's faithful `0.0001`
became `0.00`, `normalizePairConfig` threw `offsets must both be positive`, the
cycle caught it as a configuration error and held — forever, silently, having
analysed nothing.

Fix: `OFFSET_PRECISION = 1e-8` in the block definition, mirrored as
`MIN_REPRESENTABLE_OFFSET = 1e-8` in both the runtime
(`hedge-pair-analysis.js`) and the generator (`hedge-pair-dbot.ts:138`). Offsets
below it are refused at build time with a message that names the floor; the
console clamps its one-pip default to the same constant so it can never emit an
unrepresentable barrier.

Verified against the repo's **own vendored Blockly**, not a stub: the fixture
`hedge-pair-higher-lower-r50-one-pip.xml` loads, `getFieldValue('UPPER_OFFSET')
=== 0.0001`, `setFieldValue(1e-8)` survives, and the workspace compiles to

```js
Bot.ntHedgePairCycle("HIGHER_LOWER", 1, 0.0001, 0.0001, 4999, 80, 0, 2.43, 3, 40, 500, 10, 5, 6, 2, 3, "R_50", 0);
```

### 1.2 The 1 000-tick ring starved every expiry family

`ticks_service.js:448` asks Deriv for `count: 1000` and keeps a 1 000-tick ring,
and the analysis window was clamped to that same 1 000 (`maxTicks: 1000`,
`analysisWindow` default **500**). Replay is **non-overlapping** — one
observation costs `spanTicks` — so a tape of N ticks yields at most `floor(N /
span)` pairs. For a family whose shortest common duration is a minute (Ends
Between / Ends Outside and Stays Between / Goes Outside are expiry contracts, so
they are never tick-denominated), a 60-tick span over 1 000 ticks gives **16**
pairs against a configured floor of 80.

At HEAD this was made worse by a silent collapse:
`effectiveMinSamples = Math.min(events.length < 20 ? 20 : minSamples, minSamples)`
dropped the 80-pair floor to 20 exactly when fewer than 20 pairs existed — and 20
was still unreachable. The bot held with no explanation.

Fix: the cycle pulls Deriv's deep history directly and caches it per symbol.

```jsonc
{ "ticks_history": "R_50", "adjust_start_time": 1, "count": 4999, "end": "latest", "style": "ticks" }
```

4 999 is Deriv's hard maximum (5 000 is rejected outright), so
`MAX_ANALYSIS_WINDOW = 5000` and `DEFAULT_ANALYSIS_WINDOW = 4999`; the block's
window field now spans 100–5000. The same 60-second pair over 4 999 ticks yields
**83** reachable pairs, which clears the 80 floor without lowering it. This is
the same arithmetic that starved Kill-Shot (`replit.md`, "DATA STARVATION") and
the same fix (`deriv.ts` deep history).

The sample rule is now stated instead of silently relaxed
(`hedge-pair-analysis.js:735-756`):

```
samplesReachable   = floor(tape / spanTicks)            // what the tape can supply
samplesRequired    = max(hardSampleFloor 20, min(configured 80, samplesReachable))
lowConfidence      = samplesRequired < configuredMinSamples
```

`lowConfidence` is surfaced in the journal, in the status block
(`low confidence`) and as a build warning — the bot does not pretend a 20-pair
measurement is an 80-pair one. `estimateEventSpan` honours real epochs when the
tape carries them, so a tape with gaps is not treated as evenly spaced.

Deep history must **not** replace the live tick read: `latestEpoch` drives the
entry-confirmation counter, so the cycle keeps `ticksService.request` for the
live tail and joins the two with `mergeTapes`, which only merges **contiguous**
epochs into one tape. On a `{error}` (rate limit, unsupported symbol) the tape is
negative-cached and the cycle degrades to the live ring, printing
`Hedge Pair Forge TAPE · R_50 · … deep history unavailable · Rate limit reached · live ring 600`
rather than analysing nothing in silence.

### 1.3 ONLY_UPS_DOWNS trips its own double-loss breaker

Replaying a 5-tick random walk: `{ bothWin: 0, onlyA: 8, onlyB: 4, bothLose: 187 }`
— a **94.0 %** double-loss rate, because "only ups" and "only downs" are mutually
exclusive by construction and both lose whenever the path mixes. With the
double-loss breaker at 6 consecutive, `P(6 in a row) = 0.94^6 ≈ 68.9 %`. The
family is measurable now, and the measurement says it is untradeable: the hard
blocker `every one of N replayed pairs lost BOTH legs — no measurable repayment
path` fires when `repaymentSamples === 0`, and the breaker still halts the
session if a user forces it. That is the honest outcome, not a bug to hide.

### 1.4 There was no edge gate at all

At HEAD `eligible` depended only on samples and timing. `expectedEdge`,
`instability`, `stateCounts`, `breakEven` and `timingScore` were computed,
returned and **discarded**; only `lowerBound` was consumed (by the journal). The
`EDGE_HURDLE` block field existed with a 0.01 default and gated nothing.

For Over 5 / Under 4 at 2.43× the measured numbers were `expectedEdge −0.027`,
`lowerBound −0.065`, `eligible: true` — the bot was buying a pair that
`docs/digit-forge-market-switching.md` §4.1 prices at −2.8 %. That is *why* the
one family that traded was the one that should not have.

The gate now is (`hedge-pair-analysis.js:759-792`):

| Blocker | Kind | Fires when |
| --- | --- | --- |
| `complete paired samples N/M (a S-tick pair over a T-tick tape yields at most R; configured floor F)` | hard | `events.length < samplesRequired` |
| `every one of N replayed pairs lost BOTH legs — no measurable repayment path` | hard | `bothWin + onlyA + onlyB === 0` |
| `joint estimate unstable across windows (X.Xpt > 35pt)` | hard | `instability > maxInstability 0.35` |
| `timing: …` | hard | `requireTiming && !isRecovery && !timing.timingReady` |
| `joint EV X.XX% below the Y.YY% hurdle (break-even is 0.00% per combined stake; 95% LCB Z.ZZ%)` | **soft** | `expectedEdge < requiredEdge` |

`eligible = blockers.length === 0`, so the EV hurdle is real — but it is the one
blocker the **patience valve** may override (§5.4), because a negative-EV entry
is a risk decision, whereas an unmeasurable pair is not.

What the EV *is*: each replayed pair returns
`(winA·payoutA + winB·payoutB − 2) / 2` — net per unit of **combined** stake,
using the two live multipliers, so break-even is `0` by construction. Per scale,
`estimatePairReturn` shrinks the mean toward a zero-edge prior
(`priorStrength 20`, `priorStandardDeviation 0.5`) and takes a one-sided 95 %
lower bound from a HAC long-run variance. The reported
`expectedEdge = 0.45·all + 0.30·mid + 0.25·recent`, the reported
`lowerBound = all.lowerBound`, and `instability` is the spread of the three raw
means. The console default for the hurdle is **0 = break-even**; raising it above
0 demands a measured surplus.

---

## 2. Report B — making the analysis flow visible

Three separate things had to be fixed before anything appeared in the journal.

1. **Hold logging was epoch-gated and almost always passed `epoch = 0`.** 12 of
   the 15 `ntPairLogHold` call sites had no epoch, so the "log once per epoch"
   guard printed the first hold and then swallowed every subsequent one. It is
   now wall-clock throttled (30 s) and prints the *reason*, the family, the
   symbol and the sample arithmetic.
2. **Flow labels were shared across symbols.** A per-label rate limiter keyed on
   bare `'tape'` / `'analysing'` meant that after a market switch the new
   symbol's lines were suppressed as duplicates. Labels are now keyed on the
   symbol (`tape:R_50`, `analysing:R_100`, …). Never revert these to bare
   strings — that is what hid the switch.
3. **The generated XML emitted nothing.** The status block had 7 settlement-only
   fields and the strategy had no `notify` blocks, so the Builder showed a bot
   that appeared to be doing nothing between trades.

Now, in the Builder journal during a run:

```
Hedge Pair Forge TAPE · R_50 · deep history 4999 ticks, 12s old · live ring 600 · tick cadence 1s
Hedge Pair Forge ANALYSING · Only Ups / Only Downs · R_50 · 83 pairs (required 80) · EV −94.00% …
Hedge Pair Forge HP RANK · ONLY_UPS_DOWNS · 2 markets · R_100 82.74 · R_50 69.04 · holding R_50 (dwell 12/60)
Hedge Pair Forge HP SWITCH · R_50 → R_100 · evidence 82.74 vs 69.04 (+13.71pt ≥ 1.00pt) · repayment 82.0% · 100 pairs
Hedge Pair Forge SWITCH REFUSED · … / SWITCH FAILED · … / SWITCH UNAVAILABLE · …
Hedge Pair Forge PATIENCE VALVE · 240s of soft-blocked holding reached the configured 180s limit · entering anyway on R_50
PAIR DOUBLE LOSS · 3.92 total stake added to recovery debt · debt 5.08 · recovery armed · step 1/3
```

And at build time, in the XML's INITIALIZATION statement (3 `notify` blocks) —
the strategy announces what it will measure, which markets it watches, and the
recovery arithmetic including the **projected ladder** (§4.5). The generator also
returns 11 warnings in the summary (rendered in the console): expiry families
that will be low-confidence, a watch list that cannot switch, offsets below the
representable floor, a ladder ceiling too weak to repay a split, and so on.

The status block grew from 7 to **35** fields, so a user can put the live
measurement on the canvas: `samples`, `samples required`, `low confidence`,
`edge`, `lower bound`, `instability`, `timing`, `timing ready`, `both win`,
`only a`, `only b`, `both lost`, `repayment`, `hard blockers`, `soft blockers`,
`analysis`, `multiplier a`, `multiplier b`, `win multiplier`, `markets watched`,
`markets`, `best market`, `rank`, `switches`, `forced entry`, plus the original
`continue`, `debt`, `profit`, `step`, `reason`, `pairs`, `recovery armed`,
`target`, `market`, `mode`.

The app's `/trades` page is Deriv's profit table and stays that way — the
analysis flow is a **Builder journal** surface, which is what the user asked for
("like the Nexus Forge DBot").

---

## 3. Report C — market switching

### 3.1 Why switching lives inside the cycle

Digit Forge needed a separate `nt_switch_market` block because its rotation is a
user-visible step. Hedge Pair Forge's rotation is an *internal* consequence of
the analysis: the family and offsets are fixed at build time, only the symbol
moves. So the switch happens inside `ntHedgePairCycle` and **no `nt_switch_market`
block appears in the generated XML** — one fewer block for a user to misplace,
and `HEDGE_PAIR_BLOCK_TYPES` stays a tight allowlist. The transport is still
`Bot.ntSwitchMarket(nextSymbol, 'Hedge Pair Forge')`
(`Ticks.js`, `TicksInterface.js`), which already existed and is covered by
`market-switch.spec.js`.

### 3.2 Ranking is payout-free by necessity

`analyseHedgePairTape` hard-blocks with `live pair payout quotes unavailable`
without two positive multipliers, so a ranker cannot call it for 8 markets per
tick — that would be 8 × 2 live proposal round-trips and 8 × 4 999-tick replays
every evaluation. Instead:

- the **incumbent's** cached live multipliers are reused as a documented proxy
  for every candidate (same family, same offsets, similar barrier distance — the
  proxy is about *relative* evidence, never about a buy decision);
- ranking runs at most every `rankIntervalEvaluations = 15` evaluations;
- **only the winner is quoted live**, and then the full gate runs again on that
  quote before any purchase. A candidate can win the ranking and still be
  refused by the live gate; that is deliberate.

`pairEvidenceScore` blends repayment rate, estimate stability, entry-timing score
(15 %) and sample confidence; `pairEvidenceScore({})` scores 0.2 rather than NaN
(zero-sample guard). Unmeasured rows score 0 and rank last.

### 3.3 The anti-thrash conjunction

Straight from `docs/digit-forge-market-switching.md` §4.3(f), in
`rankHedgePairMarkets` (`hedge-pair-analysis.js:1059+`):

| Condition | Normal | Recovery |
| --- | --- | --- |
| Evidence gap `best − incumbent` | ≥ 1.00 pt (`switchEdgeDelta 0.01` on a 0–1 score) | ≥ 2.00 pt (×2) |
| Dwell on the current market | ≥ 60 evaluations | ≥ 60 |
| Since the last switch | ≥ 120 evaluations | ≥ 120 |
| Candidate analysable (no hard blockers) | required | required |
| A pair currently live | never switches mid-pair | never |

Ordering is `analysable` first, then evidence score, then sample count. All
per-market caches are cleared on a move. Recovery demands twice the gap because
the debt is compounding: a switch that is merely "a bit better" is not worth
re-pricing the ladder.

Behaviour verified with three synthetic markets (R_100 evidence 82.74 vs R_50
69.04): dwell 10/60 → holds; dwell 60 → switches with the reason string above;
cooldown 5/120 → holds; incumbent best → holds; `isRecovery: true` → needs
2.00 pt; single market or every market hard-blocked → holds the incumbent and
says why (`no watched market can be measured · best candidate R_50: …`).

### 3.4 The watch list

`MARKETS` is a new text field on the cycle block ("comma separated; empty = this
market"), emitted **last** in the field order (§6). `normalizeWatchMarkets`
dedupes, upper-cases, drops anything failing `/^[A-Z0-9_]{2,30}$/`, always puts
the seed symbol first and caps at `MAX_WATCH_MARKETS = 8` (the socket budget).
`normalizeWatchMarkets('R_50,R_100,r_25,R_50', 'R_50')` → `['R_50','R_100','R_25']`.

The route (`src/routes/hedge-pair.ts`) re-validates independently: any watched
symbol that is not in the automated-symbols list is a **400**, so a user cannot
inject an untradeable market through the console. The generator writes the
normalized list into the XML and into `summary.watchMarkets`, and the build
warning tells the user when only one market is watched (no switching possible).

---

## 4. Report D — recovery when two premiums are at risk

### 4.1 The debt was already right; the sizing was not

`applyPairSettlement` has always added `totalStake` — **both** lost premiums — to
the debt. Base $1 a leg → a double loss owes **$2.00**, not $1.00. What was
wrong was everything downstream:

1. The per-leg size came from the shared single-contract multiplier default
   (1.62), which is a **ladder ceiling** (`base × mult^step`), so the
   debt-driven $1.96 was clamped to $1.62 and the pair under-recovered silently.
2. `MARKUP_PERCENT` came from the shared server setting
   (`settings.botRecoveryMarkup`, default **10 %**), which is calibrated for one
   contract, not two.
3. A split set `recoveryArmed = false` unconditionally (HEAD
   `hedge-pair-analysis.js:692`), **stranding** the residual: `isRecovery` is
   `recoveryArmed && debt > 0`, so the unpaid $1.16 of a $2.00 debt was never
   sized again.

### 4.2 The formula, and why it is the repo's canonical one

```
stake per leg = ceil_to_cent( debt × (1 + markup) / (winMultiplier − 1) )
winMultiplier = the POORER of the two live leg payouts
markup        = 40 %   (pair-local; the shared 10 % default is not used here)
```

This is deliberately the same shape as `calculateBotRecoveryStake`
(`artifacts/api-server/src/lib/recovery-math.ts:210`) — one recovery formula
across the repo — with the pair's own debt and markup. The consequence, stated
plainly because the user accepted it: **one split win does not clear a pair
debt.** A winning leg returns `s·m` while the pair spent `2s`, so the split nets
`s·(m − 2)` and leaves a residual. The ledger therefore carries the residual and
re-sizes from it every pair.

### 4.3 Ceilings, floors and refusal

| Rule | Value | Why |
| --- | --- | --- |
| Ladder ceiling | `base × RECOVERY_MULTIPLIER^step`, default **2.43** | A pair needs a bigger ceiling than one contract: at 2.43 the caps are 2.43 / 5.90 / 14.35, so $1.96 stands; at 1.62 it would be clamped to $1.62 |
| Per-leg max stake | `MAX_STAKE` (default 500) | Broker/console limit |
| Balance guard | half the current balance | Two legs are bought at once |
| Floor | **0.35** (broker minimum), `floorBinding: true` | Small debts must not be stranded below the minimum |
| Refusal | `null` when the winning leg pays **≤ 2.00×** | Below that no split can shrink the debt, so sizing would only deepen it |
| Debt epsilon | `DEBT_EPSILON = 0.005` | Floating-point residue must not keep recovery armed forever |
| `capBinding` | `'none'` / `'ladder ceiling'` / `'max stake'` / `'balance'` / `'broker minimum stake'` | Named, not silent |

Verified sizing object for debt $2.00 at a 2.43× winning leg:
`{ stakePerLeg: 1.96, pairStake: 3.92, exactPerLeg: 1.958041958, ladderCap: 2.43,
targetDebt: 2.8, winMultiplier: 2.43, netRate: 1.43, markupPercent: 40,
capBinding: 'none', floorBinding: false, projectedNetOnPairWin: 0.8428,
repayableByPairWin: true, residualDebtAfterWin: 1.1572 }` — **the user's $1.96**.

Fail-closed cases, all asserted: no live multipliers → `null`;
`winMultiplier 1.0` → `null`; both legs 1.80 → sizes 2.43 with
`repayableByPairWin: false` and `projectedNetOnPairWin −0.486`;
`markupPercent: 10` → 1.54; balance 4 / debt 400 / mult 50 → 2 with
`capBinding 'max stake / balance'`; debt 0.22 → 0.35 with
`floorBinding` and `'broker minimum stake'`; balance 0.5 → `null`.

### 4.4 The ladder, end to end

Base $1 a leg, markup 40 %, ceiling 2.43, both legs paying 2.43×:

| Pair | Debt before | Per leg | At risk | Split net | Residual |
| --- | --- | --- | --- | --- | --- |
| 1 | 2.00 | 1.96 | 3.92 | +0.84 | 1.16 |
| 2 | 1.1572 | 1.14 | 2.28 | +0.49 | 0.667 |
| 3 | 0.667 | 0.66 | 1.32 | +0.28 | 0.3832 |
| 4 | 0.3832 | 0.38 | 0.76 | +0.16 | 0.2198 |
| 5 | 0.2198 | 0.35 (floor) | 0.70 | +0.15 | 0.0693 |
| 6 | 0.0693 | 0.35 (floor) | 0.70 | +0.15 | **0.00** |

Six consecutive split wins clear it: `recoveryArmed = false`,
`sessionProfit +0.0812`, cumulative exposure $9.68. If another **double loss**
lands mid-recovery the debt compounds and the size follows it — 2.00 → $1.96 a
leg; 5.08 → $4.98; 15.04 → $14.73 — until a ceiling binds, at which point
`capBinding` names the binding constraint in the journal instead of pretending
the debt will clear.

The re-arm fix: a split **never arms or advances** recovery (it adds no debt),
but it no longer disarms an outstanding one. Recovery stays armed and sizes the
residual until the debt reaches zero — matching `recovery-math.ts`
(`settleRecoveryWin` → `recoveryComplete: remainingDebtCents === 0`).

`state.recoveryReferenceMultiplier` is now set in the final-quote loop, so the
journal reports the multiplier actually traded (2.20) rather than a stale cached
one (3.00).

### 4.5 The build-time projection

The generator runs the same arithmetic on the configured base stake and prints it
into the XML and the console (`recoveryProjection`):
`{ debt, markupPercent, target, assumedWinMultiplier, stakePerLeg, pairStake,
netOnPairWin, residualAfterWin, pairsToClear, ladder[], capBinding, caveat }`.

For stake $1, markup 40 %, multiplier 2.43: debt 2.00 → target 2.80 → **1.96 a
leg** (3.92 at risk) → a split nets **0.84** → 1.16 remains → **6** split wins to
clear → `capBinding 'none'`.

For the weak case (multiplier 1.62): `netOnPairWin` is **negative** (−0.61),
`pairsToClear` is 0, `capBinding` is `'ladder ceiling / max stake'`, the sized
stake is 1.62, and the XML says the runtime
`REFUSES to size a recovery until the live legs pay above 2.00×` instead of
promising a clear-in-N ladder. **Never print a fabricated broker payout**: the
projection is labelled `assumed at a 2.43× winning leg` and the runtime re-sizes
from the poorer of the two **live** leg payouts every pair.

Rounding discipline, because it changes the numbers a user reads: `round2()`
(`Math.ceil` to the cent) is for **stakes only**; `cents()` (round to the cent)
is for **displayed money**, matching what the runtime journal prints. Using
`round2` for the displayed net produced "a split win nets 0.85" against the
journal's 0.84.

---

## 5. The cycle, as built

### 5.1 Tape

`ntPairDeepTape(symbol)` → deep history cached per symbol
(`deepTapeTtlMs = 60 000`), negative-cached on error, merged with the live ring
by `mergeTapes` (contiguous epochs only). Analysis only — every buy re-quotes
live.

### 5.2 Duration

`requestedDuration` is forced to **1** tick by policy; `chooseCommonPairDuration`
may raise it only to the true minimum common duration advertised by
`contracts_for` for that symbol/family/barrier, and the two live proposals
validate it before purchase. The analysis uses the *effective* duration, so
`estimateEventSpan` reflects what will actually be traded.

### 5.3 Entry

Confirmation streaks are family-specific (`confirmationTicks 2` normal,
`recoveryConfirmationTicks 3`; per-family floors 2–3 and 3–4) and require
**fresh epochs** — the live tick read supplies them, which is why the deep tape
cannot replace it. Both legs are quoted concurrently, then bought concurrently.

### 5.4 The patience valve

`FORCE_ENTRY_AFTER` (seconds, 0–3600, step 30, **default 0 = never**) is the only
escape hatch from a *soft* blocker. When it is set and the bot has been
soft-blocked for that long, it enters anyway and prints
`PATIENCE VALVE · … entering anyway on R_50 · <soft blockers>`. It cannot
override a hard blocker. It ships **off** so the default build never forces a
negative-EV entry; the console exposes it with that warning.

### 5.5 Stops

`takeProfit` / `stopLoss` are on session P&L (not per pair), the double-loss
breaker halts after `LOSS_BREAKER` consecutive double losses, and `ntPairSetHalt`
records the reason in state so the status block can show it.

---

## 6. Generated XML and the block contract

Two blocks (`scratch/blocks/Binary/Tick Analysis/neurotrade_hedge_pair.js`):

**`nt_hedge_pair_cycle`** — 18 fields, in this exact order (asserted by slicing
the block out of the fixture and reading the field names, because a global
`<field name="…">` regex also matches the status block's `FIELD`):

```
FAMILY, DURATION, UPPER_OFFSET, LOWER_OFFSET, WINDOW, MIN_SAMPLES, EDGE_HURDLE,
RECOVERY_MULTIPLIER, MAX_RECOVERY_STEPS, MARKUP_PERCENT, MAX_STAKE, TAKE_PROFIT,
STOP_LOSS, LOSS_BREAKER, ENTRY_CONFIRMATIONS, RECOVERY_CONFIRMATIONS,
MARKETS, FORCE_ENTRY_AFTER
```

`MARKETS` and `FORCE_ENTRY_AFTER` are appended **last** so an XML written by an
older generator still parses (Blockly reads missing fields as their defaults).
Generates `Bot.ntHedgePairCycle(…)`; `nt_hedge_pair_status` generates
`Bot.ntHedgePairStatus("<field>")` with the 35-option dropdown.

`nt_hedge_pair_cycle` is in the `purchase` alias list
(`utils/mandatory-block-aliases.js`), so the Run-button gate treats a strategy
containing it as a trading strategy. Mixin order in `trade/index.js:68`:

```
Balance(DigitForge(HedgePair(Purchase(Sell(OpenContract(Proposal(Ticks(Total(class{})))))))))
```

`HEDGE_PAIR_BLOCK_TYPES` is the vendored allowlist the generator must stay
inside; the api-server test asserts every fixture does, that ids are unique and
that the pair purchase alias is present.

Fixtures (`artifacts/dbot-builder/src/preview/__tests__/fixtures/`) — **8**, one
per family plus the one-pip regression:
`hedge-pair-overunder-r50`, `-only-ups-downs-r50`, `-higher-lower-r50`,
`-touch-upper-lower-r50`, `-no-touch-upper-lower-r50`,
`-ends-between-outside-r50`, `-stays-between-outside-r50`,
`-higher-lower-r50-one-pip`. Regenerate with

```sh
cd artifacts/api-server && npx tsx src/lib/hedge-pair-dbot.fixtures.ts --write
```

which writes into the Builder's preview fixtures — the api-server test fails on
drift, so the two definition copies (`HEDGE_PAIR_DEFINITIONS` in the generator
and in `hedge-pair-analysis.js`) cannot diverge. The test imports the Builder's
runtime module through a `data:` URL and deep-equals the family tables.

---

## 7. API and console contract

`GET /api/bots/hedge-pair/options` now also returns `pairMarkupPercent: 40`,
`pairRecoveryMultiplier: 2.43`, `analysisWindow: 4999`,
`maxAnalysisWindow: 5000`, `maxWatchMarkets: 8` and `minRepresentableOffset:
1e-8`, so the console's defaults come from the server rather than being
duplicated in React.

`POST /api/bots/hedge-pair/dbot` accepts `watchMarkets` and `forceEntryAfter`,
defaults the window to 4 999, the hurdle to 0, the multiplier to 2.43 and the
markup to the request body or 40 — **never** the shared 10 % setting, which is
read only to be reported as `sharedMarkupPercent` so the UI can say "the shared
default is 10 %, this bot uses 40 %". Watch symbols are validated against the
automated-symbols list (400 otherwise), the build is logged with
`logger.info`, and the response summary carries `watchMarkets`,
`forceEntryAfter` and `recoveryProjection`.

The console (`hedge-pair-forge@2`) adds: the watch-market checkbox grid
(seed always included, `n/8` counter, "reset to R_50"), the ranking/anti-thrash
explanation, tape depth up to 5 000 in steps of 250 with the deep-history hint,
"Required joint EV (0 = break-even)", "Force entry after (0 = never)", a
"Recovery ladder ceiling" hint, readouts for the pair-local markup versus the
shared one, and the **pair recovery plan** panel — a client-side projection using
the same formula, labelled as projected at the ladder ceiling when no server
projection exists, showing debt, target, per-leg stake, pair exposure, net on a
split win, residual, split wins to clear, the ladder rungs, any binding cap and
the caveat. Last-build readouts now include the tape depth, markets watched,
recovery markup and patience valve.

The `@1 → @2` bump follows the rule in `console-contract.ts`: the web bundle and
the API are separate Railway services, and a materially changed console must be
detectable by a bundle built before the change. Bumped in `console-contract.ts`,
`console-registry.ts` (map + published list), `console-registry.test.ts`,
`bot-catalog.ts` (`consoleIdFor`), `bot-activity.test.ts` (both the per-bot
assertion and the published set) and `bot-console-parity.test.ts` passes because
it reads the web contract from source and compares it to `botConsoleIds()`.

---

## 8. What the maths cannot do

- **No edge is promised.** The gate measures a replayed tape with *today's* live
  multipliers; it is not a validated backtest and not a forecast. The console
  says so next to the build button.
- **The expiry families stay thin.** Even at 4 999 ticks a one-minute pair yields
  ~83 non-overlapping observations. That clears the floor; it does not make the
  estimate tight, and `lowConfidence` plus the build warning say so.
- **Ranking uses a payout proxy.** Candidates are scored with the incumbent's
  cached multipliers. Only the winner is quoted live and re-gated, but a
  candidate whose real payouts differ materially can win a ranking it should not.
- **Deep history is capped by Deriv** at 4 999 ticks and can be refused outright
  (rate limit, symbol support). The bot degrades to the live ring and says so.
- **A split never clears a pair debt in one step.** The residual is carried; six
  consecutive split wins are needed at a 2.43× leg. If payouts fall to ≤ 2.00×,
  sizing refuses and the debt simply stays owed.
- **The patience valve can force a losing entry.** It is off by default for that
  reason.
- `maxRecoverySteps` still defaults to **3** for this bot. Given a pair compounds
  debt twice as fast as a single contract, 2 is arguably the safer default; that
  change was proposed and **not** made, pending a user decision.

---

## 9. Tests and how to reproduce

```sh
# Builder runtime (analysis, execution, markets) — 203 passed / 3 failed (pre-existing)
cd artifacts/dbot-builder && npx jest --silent --coverage=false \
  src/external/bot-skeleton/services/tradeEngine/

# Builder preview: real Blockly round trip of all 8 fixtures — 6/6
cd artifacts/dbot-builder && npx jest --silent --coverage=false \
  src/preview/__tests__/hedge-pair-strategy.spec.js

# api-server: hedge-pair parity (11), activity, console parity — 22/22
cd artifacts/api-server && DATABASE_URL=pglite:memory npx tsx --test --test-force-exit \
  src/lib/hedge-pair-dbot.test.ts src/lib/bot-activity.test.ts src/lib/bot-console-parity.test.ts

# api-server full suite — 1271 passed / 0 failed
cd artifacts/api-server && pnpm run test

# trading-platform full suite — 97 passed / 0 failed
cd artifacts/trading-platform && pnpm run test
```

New/extended specs: `hedge-pair-analysis.spec.js` (46),
`hedge-pair-execution.spec.js` (16), `hedge-pair-markets.spec.js` (16, new),
`preview/__tests__/hedge-pair-strategy.spec.js` (6),
`api-server/src/lib/hedge-pair-dbot.test.ts` (11, was 6).

**The 3 failing Builder tests are pre-existing at HEAD** (`nexus-hedge-recovery`,
`digit-forge-rematch`, `omni` rescan) — verified by running the same command in a
worktree of the base commit. They are untouched by this change and are reported
here rather than quietly fixed.

Whole-project `tsc --noEmit` is **not** a usable signal in this repo: it reports
TS6305 for every `@workspace/*` package whose `dist` has not been built
(`lib/db` has no build script), and those missing types cascade into implicit-any
errors in `connect.tsx`, `markets.tsx` and `account-switcher.tsx`. Grep the
output for the file you edited instead of comparing totals.

---

## 10. Files touched

**Runtime** — `tradeEngine/trade/hedge-pair-analysis.js` (deep-tape limits,
`MIN_REPRESENTABLE_OFFSET`, `normalizeWatchMarkets`, `estimateEventSpan`, gated
`analyseHedgePairTape`, `sizePairRecovery`, `applyPairSettlement` re-arm,
`rankHedgePairMarkets`, `pairEvidenceScore`), `tradeEngine/trade/HedgePair.js`
(`ntPairDeepTape`, `mergeTapes`, `ntPairMarketRow`, `ntPairEvaluateMarkets`,
`ntPairSwitchMarket`, symbol-keyed flow labels, 30 s heartbeat, patience valve,
`recoveryReferenceMultiplier`), `tradeEngine/trade/Ticks.js`
(`ntSwitchMarket(nextSymbol, botLabel = 'Digit Forge')`).

**Blocks** — `scratch/blocks/Binary/Tick Analysis/neurotrade_hedge_pair.js`
(offset precision, window range, `MARKETS`, `FORCE_ENTRY_AFTER`, 35 status
fields).

**API** — `src/lib/hedge-pair-dbot.ts`, `src/lib/hedge-pair-dbot.fixtures.ts`,
`src/lib/hedge-pair-dbot.test.ts`, `src/routes/hedge-pair.ts`,
`src/lib/bot-catalog.ts`, `src/lib/bot-activity.test.ts`.

**Web** — `src/components/hedge-pair-forge-console.tsx`,
`src/lib/console-contract.ts`, `src/lib/console-registry.ts`,
`src/lib/console-registry.test.ts`.

**Fixtures** — 8 XMLs in `artifacts/dbot-builder/src/preview/__tests__/fixtures/`.
