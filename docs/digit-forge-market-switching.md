# Digit Forge · Part II — in-XML market switching, the maths kit, and the forge panel

> **BUILT — phases 1–3 shipped. See `docs/digit-forge-as-built.md` (Part III)
> for what actually exists, the deviations from this design, and the test that
> proves the generated bot runs without errors.** Phase 4 (in-XML rotation) is
> still a design only; the generator already validates and echoes the watch
> list so it has a landing place.

**Read `docs/digit-forge-dbot.md` first.** That document answered the same
product question and concluded:

> *"Option C · Multi-market inside one XML — not possible."*

**That conclusion is correct for stock Deriv blocks and wrong for this
repository.** We do not ship stock Deriv Bot — we ship a *vendored fork*
(`artifacts/dbot-builder`) served from our own origin at `/bot/preview`. Inside
that fork, in-XML market switching is a ~150-line, additive change that touches
**none** of Deriv's trade loop. This document supersedes §1 and §6-Option-C of
Part I; every other section of Part I (the estimator library, the failure-mode
table, the product surface) still stands and is not repeated here.

---

## 0. Verdict

| The ask | Possible? | How |
| --- | --- | --- |
| Over 1/2 · Under 7/8 normally, Over 4/5 · Under 4/5 in recovery, in one generated XML | **Yes, today** | `TYPE_LIST=both` + barrier/contract held in variables, re-read by `trade_definition_tradeoptions` every cycle. Proven by the shipped Turbo generator. |
| Recovery ladder identical to the app's | **Yes, today** | Emit `getBotRecoveryStake` as a Blockly procedure. Proven by the shipped Turbo generator. |
| All analysis **inside** the running bot, no AI service in the loop | **Yes** | The bot owns a digit ring buffer, counts, a 2-state Markov chain and an EV gate — all expressible in stock blocks (§4). |
| The running bot **re-points itself** V10 → V50 | **Yes, in our builder** | 3 new `Bot.*` natives + 3 NeuroTrade blocks (§2–§3). **Not** possible in stock Deriv Bot, and an XML using them will refuse to load on app.deriv.com. |
| Panel in the Bot Arena with **Create DBot** instead of **Scan markets** | **Yes, today** | Clone the Turbo console minus the scan step; the bridge that loads XML into the builder already exists and is warm. |
| "…without errors when we run it" | **Yes, with a 4-layer gate** | §7. The decisive layer — load + compile + *execute* the generated XML against a scripted market — already exists for Turbo (`turbo-dbot-strategy.spec.js`) and generalises. |

So: **yes, this can be pulled.** The only genuine decision is portability
(§3), and the only genuine risk is the market-switch handshake (§2.3), which is
containable because we own the engine.

---

## 1. Why Part I said "impossible" — and precisely where the door is

The lock, re-verified line by line:

| Fact | Evidence |
| --- | --- |
| The symbol is a **string literal** baked into generated JS | `scratch/blocks/Binary/Trade Definition/trade_definition.js:196` → `Bot.init('<loginid>', { symbol: '<SYMBOL>', … })` |
| `BinaryBotPrivateInit` runs **once**, before the trade loop | `scratch/dbot.js:379` |
| Every purchase is forced onto the init symbol | `tradeEngine/trade/index.js` → `start()`: `this.tradeOptions = { …validated, symbol: this.options.symbol }` |
| No stock tick block takes a symbol argument | `scratch/blocks/Binary/Tick Analysis/*.js` |

All true. But three further facts — the ones Part I did not check — open the
door:

| Fact | Evidence | Consequence |
| --- | --- | --- |
| **`TicksService` is already multi-symbol.** Ticks, listeners and subscriptions are `Map`s **keyed by symbol**; `request({symbol})` returns that symbol's history and starts its stream. | `services/api/ticks_service.js:44-49, 71-118` | The builder can hold live digit tapes for 8 markets at once with **zero new networking code**. |
| **The engine reads the symbol per trade cycle, not per run.** `start()` is called by `BinaryBotPrivateStart` on *every* loop iteration and dereferences `this.options.symbol` at that moment. | `trade/index.js` `start()`; `dbot.js:380-397` | Mutating `options.symbol` between contracts retargets the very next purchase. No loop surgery. |
| **Anything added to `getTicksInterface` is auto-bound as an async `Bot.*` native.** | `tradeEngine/utils/interpreter.js:113-115` — `Object.entries(ticks_interface).forEach(([name, f]) => setProperty(pseudo_bot_interface, name, createAsync(...)))` | New natives need **no** change to `interpreter.js`. Add a method to the interface object and it exists as `Bot.x()` in the sandbox, correctly async. |

And the gate that decides whether an XML loads at all:

```js
// scratch/utils/index.js:200 — load()
const has_invalid_blocks = Array.from(blockly_xml).some(
    block => !Object.keys(window.Blockly.Blocks).includes(block.getAttribute('type')));
if (has_invalid_blocks) return showInvalidStrategyError();
```

A block type is legal **iff it is registered in `window.Blockly.Blocks`**. Our
fork registers whatever we import in `scratch/blocks/index.js`. That is the
whole portability story: registered here → loads here; unknown on Deriv's site
→ *"XML file contains unsupported elements."*

---

## 2. The engine extension (Mode B)

### 2.1 Three natives, one file each

| Native | Lives in | Body |
| --- | --- | --- |
| `Bot.ntWatchMarkets(list)` | `tradeEngine/trade/NtMarkets.js` (new mixin, modelled on `Ticks.js`) | `await Promise.all(list.map(s => ticksService.request({ symbol: s })))` — subscribes and warms 1 000 ticks of history per symbol. Idempotent; refuses symbols outside the forge-time allowlist. |
| `Bot.ntDigitList(symbol, n)` | same | `ticksService.request({symbol})` → `getLastDigitsFromList(...)` → last `n`. **Pure data, no decisions.** |
| `Bot.ntSwitchMarket(symbol)` | same | The handshake in §2.3. |

Registration is one line each in `Interface/TicksInterface.js`. **`interpreter.js`
is not modified.**

### 2.2 Three blocks

`nt_watch_markets` (statement, comma-list field), `nt_digit_list(symbol, n)`
(value → Array), `nt_switch_market(symbol)` (statement). Each is a ~40-line
`jsonInit` + a one-line `javascriptGenerator.forBlock` emitting the native call,
exactly like `lastDigitList.js`. Put them in a `NeuroTrade` toolbox category so
a human can also drag them.

### 2.3 The switch handshake — where the errors would come from

```
Bot.ntSwitchMarket(next):
  1. if (next === engine.options.symbol) return                  // no-op guard
  2. assert scope === after_purchase && no open contract         // hard gate
  3. await ticksService.stopMonitor({ symbol: OLD, key })        // ← see landmine
  4. engine.symbol = undefined; await engine.watchTicks(next)    // new tape + listener
  5. engine.options.symbol = next                                // next start() retargets
  6. engine.data.proposals = []; engine.forgetProposals()        // drop stale quotes
  7. await engine.checkProposalReady()                           // re-quote before purchase
  8. observer.emit('ui.log.info', 'switched → ' + next)          // visible in the run panel
```

**Landmine 1 — the upstream `stopMonitor` bug.** `Ticks.js:20-23` calls
`stopMonitor({ symbol, key })` with the **new** symbol while the listener was
registered under the **old** one, so `tickListeners` keeps a dead entry and the
old stream is never unsubscribed. Over a long rotating session that is a slow
leak into Deriv's 5-socket / 60-req-per-minute budget (see PR #30 in this repo).
Our native must stop the **old** symbol explicitly — do not call bare
`watchTicks()` and hope.

**Landmine 2 — proposal desync.** Purchases resolve against subscribed
proposals. Switching without steps 6–7 buys the new symbol against the old
symbol's quote → `ContractCreationFailure` / *"proposal not found"*, or a
silent wrong-market trade. Steps 2, 6 and 7 are not optional.

**Landmine 3 — scope.** A switch from `before_purchase` races the purchase
already in flight. The generator must emit `nt_switch_market` **only** inside
`after_purchase`, and the block should self-check (`Bot.isScope('after')`) and
no-op loudly otherwise.

**Landmine 4 — restart-on-error snapshots.** `interpreter.js:118-126` snapshots
interpreter state at `Bot.start()` and rewinds to it on a recoverable error.
Because the snapshot is taken *after* `after_purchase` ran, a switch performed
there is inside the snapshot and survives the rewind — but this must be proven
under fault injection (§7, layer 3), not assumed.

**Landmine 5 — subscription budget.** 8 markets × ticks = 8 streams on the
builder's single socket: fine. Proposals: subscribe for the **active market
only** — never pre-quote the candidate set.

---

## 3. Two build modes from one generator

| | **Mode A · Portable** | **Mode B · Rotator** |
| --- | --- | --- |
| Blocks | stock only | stock + 3 `nt_*` |
| Runs on app.deriv.com | ✅ | ❌ *"unsupported elements"* |
| Runs in NeuroTrade `/bot/preview` | ✅ | ✅ |
| Market switching | host-supervised stop → retarget → run (Part I §6-B), ~1–3 s dead time | **in-XML, between contracts, ~0 dead time** |
| Cross-market analysis | forge-time only | live, inside the bot |
| New engine code | none | ~150 lines, additive |

**Recommendation: build one generator with a `mode` flag.** The scopes, the
recovery procedure, the gates and the tests are ~90 % shared; Mode B only adds
`nt_watch_markets` in INITIALIZATION and a switch branch in `after_purchase`.
Default the panel to **B** (it is what was asked for), and offer *"Export
portable XML"* which re-renders in Mode A and warns that rotation is dropped.
That way the user can still take their bot to Deriv's own site.

---

## 4. The mathematics

Part I §3 already specifies the *server-side* estimator stack
(`dual-lock-analysis.ts`: `effectiveSampleSize`, `conservativeRate`,
`edgePValue`, `stationarityZ`, `lossClustering`, `conditionalTransitionRate`,
`simulateSession`, `screenAndRank` with Benjamini–Hochberg). Import it as-is at
forge time. **This section is only about what the bot can compute about itself,
in Blockly, while running.**

### 4.1 The edge budget, verified against this repo's payout table

`payoutForBarrier` (`specialist-analysis.ts:973`), total return per 1 staked:

| Contract | p₀ | Payout | Break-even 1/payout | Excess needed | **EV per stake** | Wins to repay 1 loss |
| --- | --- | --- | --- | --- | --- | --- |
| Over 1 | 0.800 | 1.23 | 0.8130 | +1.30 pt | **−1.60 %** | 4.3 |
| Over 2 | 0.700 | 1.40 | 0.7143 | +1.43 pt | **−2.00 %** | 2.5 |
| Under 7 | 0.700 | 1.40 | 0.7143 | +1.43 pt | **−2.00 %** | 2.5 |
| Under 8 | 0.800 | 1.23 | 0.8130 | +1.30 pt | **−1.60 %** | 4.3 |
| Over 4 | 0.500 | 1.95 | 0.5128 | +1.28 pt | **−2.50 %** | 1.1 |
| Under 5 | 0.500 | 1.95 | 0.5128 | +1.28 pt | **−2.50 %** | 1.1 |
| Over 5 | 0.400 | 2.43 | 0.4115 | +1.15 pt | **−2.80 %** | 0.7 |
| Under 4 | 0.400 | 2.43 | 0.4115 | +1.15 pt | **−2.80 %** | 0.7 |

Three design consequences, in order of importance:

1. **Turnover is the enemy, and recovery is where turnover lives.** A depth-3
   Over-4 ladder stakes 1.16 + 2.50 + 5.39 = **9.0 ×** the original loss; at
   −2.5 % that ladder burns 0.22 × L in pure edge on top of the loss it is
   trying to repay. Selectivity in *normal* mode is worth far less than a cap
   on ladder depth.
2. **Recovery barriers are chosen for repayment speed, not for edge.** Over 4
   repays a loss with 1.1 wins; Over 1 needs 4.3. That is the whole reason the
   vocabulary splits 1/2/7/8 ↔ 4/5. It costs ~0.9 pt of extra EV per trade.
3. The required excess is ~1.2–1.4 pt **everywhere**, so "pick the barrier with
   the smallest house edge" is not a strategy here — the schedule is flat by
   design. The only real lever is *when* and *where* to fire.

### 4.2 How much evidence is needed (the honest constraint)

One-sided, α = 0.05, power 0.8, `n ≈ (z_α+z_β)²·p(1−p)/Δ²`:

| Excess Δ to prove | p = 0.80 | p = 0.70 | p = 0.50 |
| --- | --- | --- | --- |
| 1.3 pt (just clear break-even) | 5 854 | 7 684 | 9 147 |
| 2.0 pt | 2 474 | 3 247 | 3 865 |
| 3.0 pt | 1 100 | 1 443 | 1 718 |
| 5.0 pt | 396 | 520 | 619 |
| 8.0 pt | 155 | 203 | 242 |

`lastDigitList` / `ntDigitList` cap at **1 000** ticks. Therefore:

> **The in-XML gate can only ever confirm a large, transient bias (≳ 3–5 pt).
> Marginal edges must be established server-side on the long tape
> (`digit-tape.ts`) and baked into the XML as a threshold parameter.**

This is not a limitation to engineer around — it is the reason the arming gate
exists. The bot's live maths is a *confirmation* filter, not a discovery engine.
Discovery happens at forge time with FDR correction across (market × barrier),
because picking the best of 8 markets × 8 barriers = 64 noisy estimates will
always produce a winner on pure noise.

### 4.3 The in-XML kit — what is actually computable, and with which blocks

Available primitives (verified in the vendored fork): `math_single`
(ROOT, ABS, NEG, **LN**, LOG10, **EXP**, POW10), `math_on_list`
(SUM, MIN, MAX, AVERAGE, MEDIAN, MODE, ANTIMODE, **STD_DEV**, RANDOM),
`math_arithmetic`, `math_modulo`, `math_constrain`, `math_round`,
**`math_random_float`**, `lists_create_with / repeat / getIndex / setIndex /
getSublist / length / indexOf / sort`, `controls_for / forEach / whileUntil`,
`procedures_defreturn` (value-returning!), `notify`, `console`, plus
`ask_price` and `payout` (the **live** quote for the active contract).

That is enough for every estimator below. No erf/Φ is needed because every test
compares a z or G² statistic to a **constant** baked in at forge time.

**(a) Hit count → shrunk rate.** For contract *c* with win set S꜀ over the last
W digits, `k = Σ 1{d ∈ S꜀}` (one `controls_forEach` + `controls_if`).
Beta prior centred on the fair value with strength *m*:

```
p̂ = (m·p₀ + k) / (m + W)          m default 200  → "trust uniform unless shouted at"
```

**(b) Lower confidence bound (the gate).** Agresti–Coull, sqrt-only:

```
ñ = W + z²      p̃ = (k + z²/2)/ñ      p_lo = p̃ − z·√(p̃(1−p̃)/ñ)      z = 1.645
```

Fire only when **`p_lo > 1/payout`**. Comparing the *lower bound* to break-even
— never the point estimate — is what stops the bot trading its own noise.

**(c) Live break-even instead of a table.** In `before_purchase` the `payout`
and `ask_price` blocks give the real quote: `payout_live = payout / ask_price`,
so the gate uses the price Deriv is *actually* offering, not the canonical
schedule. This matters because the schedule drifts per symbol.

**(d) Two-state Markov (the right granularity).** A 10 × 10 chain has 90 free
parameters; 1 000 ticks gives ~10 observations per cell — noise. Collapse to the
contract's own partition `X_t = 1{d_t ∈ S꜀}` and keep 4 counters n₀₀ n₀₁ n₁₀
n₁₁ (add-α smoothing, α = 1):

```
p̂₁₁ = (n₁₁+α)/(n₁₀+n₁₁+2α)        p̂₀₁ = (n₀₁+α)/(n₀₀+n₀₁+2α)
```

Use the row matching the **current** state as the forecast for the next tick.
Only let it override the marginal estimate when dependence is statistically real:

```
G² = 2·Σ n_ij·ln( n_ij / E_ij )      E_ij = n_i· · n·j / n      df = 1
fire the conditional branch only if G² > 3.84   (p < 0.05)
```

`LN` exists, so this is four `math_single` blocks inside a `procedures_defreturn`.
This is the single highest-value piece of maths in the bot: it is the only test
that can distinguish "this tape has structure" from "this window looks lucky".

**(e) Clustering / streak hazard.** Longest adverse run *R* in W with loss prob
*q*: `E[R] ≈ ln(W(1−q))/ln(1/q)`, `sd ≈ 1.29/ln(1/q)`. Cool down when
`R_obs > E[R] + 2·sd`. Cheap and it directly protects the ladder, because
clustered losses are exactly what turns a depth-4 cap into a depth-7 event.
(Server-side `lossClustering()` computes the same ξ = P(loss|loss)/P(loss).)

**(f) Cross-market score and the switch rule.** For every watched market *m*
and allowed contract *c*, from `ntDigitList(m, W)`:

```
EV(m,c) = p_lo(m,c)·(payout(m,c) − 1) − (1 − p_lo(m,c))
```

Switch only when **all** hold — this conjunction is the anti-thrash policy:

```
EV(best) > EV(current) + δ         δ = 0.010     hysteresis
ticks_on_current            ≥ D    D = 60        dwell / min residence
ticks_since_last_switch     ≥ C    C = 120       global cooldown
not in recovery (default)                        see §5
G²(best) > 3.84  OR  p_lo(best) clears break-even on the marginal estimate
```

**(g) Exploration (optional).** `math_random_float` exists, so Thompson
sampling is available: draw `θ_m ~ Beta(1+w_m, 1+l_m)` via a normal
approximation and pick `argmax θ_m·payout_m − 1`, with geometric discounting
`w ← γw + x` (γ ≈ 0.99) so a market that was good an hour ago decays back to the
prior. Default **off** — deterministic UCB
(`p̂_m + √(2 ln Σn / n_m)`) is easier to explain to a user watching the log, and
an unexplainable bot is an unusable bot.

### 4.4 Cost model per tick

`BinaryBotPrivateTickAnalysis` runs on **every** tick and the interpreter is
step-limited. With 8 markets × W = 400 and a naive recount, that is 3 200
list steps per tick and the bot will visibly stall. Two rules:

- Maintain counts **incrementally** (`k ← k + in(new) − in(evicted)`) — O(1).
- Rescore *candidate* markets on a **schedule** (every 20th tick) rather than
  every tick; score the active market every tick.

---

## 5. Recovery, ported verbatim (and the cross-market rule)

Stake formula — identical to `getBotRecoveryStake`
(`lib/agents/recovery-engine.ts:375`), emitted as a `procedures_defnoreturn`
named *"Size recovery stake"*:

```
raw   = debt · (1 + markup/100) / (payout − 1)
stake = ceil₂( min( max(raw, 0.35), maxTradeStake, balance ) )
```

Ladder arithmetic, computed from this repo's payouts at markup 10 %:

| Recovery leg | stake / debt | debt × per failed step | depth 4 | depth 6 | P(4 straight) | P(6 straight) |
| --- | --- | --- | --- | --- | --- | --- |
| Over 4 / Under 5 (1.95) | 1.158 | **2.158 ×** | 21.7 × L | 101 × L | 6.25 % | 1.56 % |
| Over 5 / Under 4 (2.43) | 0.769 | **1.769 ×** | 9.8 × L | 30.7 × L | 12.96 % | 4.67 % |

Read that as the bankroll rule: **capital at risk ≈ cumulative stake**, which is
20.7 × L to survive depth 4 on Over 4, and 100 × L at depth 6. With a $1 base
stake and `maxRecoverySteps = 4`, the session must tolerate a ~$21 drawdown at
a 6.25 % per-ladder rate. The panel should print exactly this sentence for the
user's chosen settings — it is the single most useful number in the whole UI.

**One debt ledger for the whole session, not one per market.** Debt is money,
not a property of V10. But the *stake* that clears it is payout-specific, so:

- Default: **finish the ladder before rotating** (the Part I hard rule).
- Opt-in "recover anywhere": rotation during recovery is allowed only to a
  market whose recovery payout is **≥** the current one, and the stake must be
  recomputed with the new payout before the next purchase. Otherwise a switch
  silently lengthens the ladder.

---

## 6. Generated strategy — block blueprint (Mode B deltas in bold)

```
trade_definition
├── TRADE_OPTIONS  (fixed order, deletable=false movable=false)
│   trade_definition_market         synthetic_index > random_index > R_50   ← seed market
│   trade_definition_tradetype      digits > overunder
│   trade_definition_contracttype   TYPE_LIST = both          ← lets one bot buy OVER and UNDER
│   trade_definition_candleinterval 60
│   trade_definition_restartbuysell FALSE
│   trade_definition_restartonerror TRUE
├── INITIALIZATION (once)
│   Base Stake · Stake · Contract · Barrier · Debt · In Recovery · Step · Loss Run
│   Normal Payout · Recovery Payout · Armed · Arm Ticks · Ticks On Market · Since Switch
│   n00 n01 n10 n11 (Markov counters) · Active Market
│   **nt_watch_markets "R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V"**
│   notify(info, "Digit Forge · <mode> · Over 2 → Over 4 · stake … TP … SL …")
└── SUBMARKET (re-read every cycle)
    trade_definition_tradeoptions   t/1 · AMOUNT←Stake · PREDICTION←Barrier · CURRENCY←account
                                    ▲ MUST be unconditional — see failure mode N5

before_purchase
├── update ring buffer + counts + Markov counters from lastDigitList   (O(1))
├── if not Armed: p_lo ← AgrestiCoull(k, W); Armed ← p_lo > 1/payout_live  or  ArmTicks > timeout
└── if Armed: purchase(Contract)

after_purchase
├── read_details(4) → Last Return · read_details(2) → Last Stake
├── if win:  In Recovery ? (Debt ← max(0, Debt − net); Debt = 0 → leave recovery)
│                        : Loss Run ← 0
├── else:    Loss Run++ ; Debt += Last Stake ; In Recovery ← true
│            Contract/Barrier ← recovery leg ; call "Size recovery stake"
├── if total_profit ≥ TP  or  ≤ −SL  or  Loss Run ≥ breakerDepth → stop (no trade_again)
├── **if (not In Recovery or allowRecoveryRotation) and dwell/cooldown/δ gates pass:**
│   **    best ← argmax EV over nt_digit_list(m, W) for each watched m**
│   **    if best ≠ Active Market → nt_switch_market(best); reset window counters; Armed ← false**
└── trade_again
```

Two details that are easy to get wrong and expensive to debug:

- `TYPE_LIST=both` is mandatory. `purchase` may only name a contract the trade
  definition declared; a bot that buys `DIGITUNDER` under `TYPE_LIST=DIGITOVER`
  throws at runtime, not at load.
- After a switch, **counters must be reset and `Armed` set false**, otherwise
  the bot arms on V10's statistics and fires on V50.

---

## 7. "It must not error when we run it"

Part I §5 lists 12 failure modes (unknown block type, malformed XML, incomplete
trade definition, market-path drift, closed symbol, illegal barrier, stake
bounds, purchase/type mismatch, undeclared variables, *"Please log in"*, posting
before the iframe exists, vendored-builder drift). All still apply. Switching
adds eight more:

| # | New failure mode | Guard |
| --- | --- | --- |
| N1 | `nt_*` block unknown → *"XML file contains unsupported elements"* (always true on app.deriv.com) | Register in `scratch/blocks/index.js`; generator stamps `mode="rotator"`; panel labels the download *"runs in NeuroTrade's builder"*; Mode A export for portability |
| N2 | Purchase against a stale proposal after a switch | Handshake steps 6–7 (`forgetProposals` + `checkProposalReady`) before returning from the native |
| N3 | Switch while a contract is open | Native asserts `after_purchase` scope + no open contract; block no-ops loudly |
| N4 | Tick-listener leak via the upstream `stopMonitor` symbol bug | Native stops the **old** symbol explicitly; assert `tickListeners.size === 1` after each switch in tests |
| N5 | `trade_definition_tradeoptions` wrapped in a condition → `BinaryBotPrivateHasCalledTradeOptions` stays false → bot spins on `sleep(1)` forever, **no error, no trades** | Generator emits trade options unconditionally in the SUBMARKET scope; execution test asserts ≥ 1 purchase within N loop iterations |
| N6 | Analysis window carries across the switch → arms on the wrong tape | Reset counters + `Armed ← false` in the same statement chain as the switch; assert in the execution test |
| N7 | Socket/rate budget (5 WS per user, 60 REST/min — PR #30) blown by watching too many markets | Cap the watch list at 8; proposals for the active market only; forge-time validation rejects longer lists |
| N8 | Restart-on-error rewinds interpreter state across a switch | Fault-injection case in layer 3: throw inside `purchase` right after a switch and assert debt + symbol survive |

### The four-layer gate

1. **Generator unit tests** (`api-server`) — every emitted `type=` is in the
   allowlist; XML parses; ids unique; variables declared; committed fixture
   snapshots. *Clone `overunder-turbo-dbot.test.ts`.*
2. **Real-Blockly load test** (`dbot-builder`, jsdom) — `load()` the XML through
   the builder's own path, then `generateCode()`. Catches every shape error the
   string tests cannot. *This is Part I's guard #12 and should ship for Turbo
   too.*
3. **Execution test** (`dbot-builder`) — run the generated JS against a scripted
   multi-symbol market with a fake `Bot`, asserting: barriers used per mode,
   ladder stakes match `getBotRecoveryStake` to the cent, debt clears on a win,
   breaker/TP/SL halt, **switch happens only between contracts**, counters reset,
   no listener leak, and the N5 spin-forever guard. *`turbo-dbot-strategy.spec.js`
   already does all of this for one market — extend its `fakeMarket` with a
   symbol dimension.*
4. **Demo-account smoke run** — the console's first Create DBot of a session
   runs against the Deriv **demo** account and requires an explicit opt-in
   before a real-money run.

Layer 3 is the one that actually earns the promise. Everything cheaper proves
the XML is well-formed; only layer 3 proves the *bot* is right.

---

## 8. Product surface

- Catalogue entry in `bot-catalog.ts`, console id **`digit-forge@1`** added to
  `console-contract.ts` (`WEB_CONSOLE_IDS`) **and** `console-registry.ts` in the
  same release — the release-skew panel exists precisely to catch a half-shipped
  console (`docs/console-release-skew.md`).
- `components/digit-forge-console.tsx`, modelled on the Turbo console **minus
  the scan step**. Primary button: **Create DBot**. Arena card badge: **FORGE**
  (new set alongside `SCANNER_CONSOLE_IDS`).
- Settings: markets to watch (multi-select, ≤ 8) · normal barrier (Over 1 /
  Over 2 / Under 7 / Under 8 / Auto) · recovery barrier (Over 4 / Over 5 /
  Under 4 / Under 5 / Auto) · base stake · TP · SL · recovery markup % ·
  max recovery steps · breaker depth · max stake · window W · arm timeout ·
  switch δ / dwell / cooldown (advanced) · allow rotation during recovery (off)
  · **mode: Rotator (default) / Portable**.
- Flow: **Create DBot** → `POST /api/bots/digit-forge/dbot` → `{name, xml,
  summary}` → `loadStrategyIntoBotBuilder()` → navigate `/bot-builder` → user
  verifies blocks → Deriv's own **Run**. Identical to Turbo's proven path; the
  iframe is already warm and survives navigation.
- The panel prints the §5 bankroll sentence and the §4.1 EV line for the chosen
  settings **before** the button, not in a tooltip.

---

## 9. Delivery plan

| Phase | Content | Size |
| --- | --- | --- |
| 1 | `digit-forge-dbot.ts` generator (Mode A) + validation + unit/fixture tests; `POST /api/bots/digit-forge/dbot`; catalogue + console registration; panel with settings and **Create DBot** | ~1 day |
| 2 | Layer-2 (load + generateCode) and layer-3 (execution) specs for the new bot **and** for Turbo | ~0.5 day |
| 3 | In-XML analysis: ring buffer, Agresti–Coull gate, 2-state Markov + G², streak cooldown, live-payout break-even | ~0.5 day |
| 4 | Mode B: `NtMarkets` mixin + 3 natives + 3 blocks + toolbox category; switch handshake with all five landmines; multi-symbol fake market in layer 3 | ~1 day |
| 5 | Panel mode toggle, rotation log in the run panel, demo-first smoke gate, bankroll/EV disclosure copy | ~0.5 day |

Phases 1–3 ship a genuinely useful single-market forge bot with in-bot analysis.
Phase 4 is the part that needs the engine change — it is isolated behind the
mode flag and cannot regress Mode A or the Turbo bot.

---

## 10. What the maths cannot do (say this in the UI)

- Deriv synthetics are generated i.i.d. uniform. Every contract in this
  vocabulary carries a **−1.6 % to −2.8 % expectation per trade** at the repo's
  payout schedule (§4.1, computed, not assumed). Filters change *which* trades
  are taken, never the expectation of a trade that is taken.
- A 1 000-tick window cannot prove a 1.3 pt edge — it needs ~6 000–9 000 ticks
  (§4.2). The in-XML gate is a confirmation filter for large transient biases,
  and the FDR screen exists because best-of-64 always "finds" something.
- The recovery ladder reshapes the outcome distribution (many small wins, rare
  large loss); it does not change the mean. Depth 4 on Over 4 is a 6.25 %
  chance of a 21 × drawdown. TP, SL, `maxRecoverySteps` and the breaker are what
  keep the tail finite.
- Once the user presses Deriv's **Run**, Deriv's engine owns execution.
  NeuroTrade cannot cancel a bought contract, and even in Mode B a market
  switch can only ever happen *between* contracts.
