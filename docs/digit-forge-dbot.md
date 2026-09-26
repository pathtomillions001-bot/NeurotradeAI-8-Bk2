# Digit Forge — a generated Deriv DBot for Over 1/2 · Under 7/8 (normal) and Over/Under 4/5 (recovery)

**Question asked:** can we ship a bot in the AI Bot Arena whose panel has a
**Create DBot** button (no scan) that generates a Deriv-Bot XML strategy which
trades **Over 1 / Over 2 / Under 7 / Under 8** normally, **Over 4 / Over 5 /
Under 4 / Under 5** in recovery, reuses NeuroTrade's recovery logic, and
**switches markets** (e.g. Volatility 10 → Volatility 50) to wherever the
opportunity is — without the generated bot throwing errors when it runs?

**Answer: yes, with one hard architectural constraint that has to be respected
— the market switch cannot live inside the XML. It has to be supervised by
NeuroTrade around the run.** Everything else is buildable, and roughly 70 % of
it already exists in this repository.

---

## 1. The one hard constraint, proven from the vendored engine

A Deriv Bot run is bound to exactly ONE symbol for its entire lifetime:

| Evidence | File |
| --- | --- |
| The trade-definition generator bakes the symbol into `Bot.init('<loginid>', { symbol: '<SYMBOL>', … })` as a **string literal** read from the block field | `artifacts/dbot-builder/src/external/bot-skeleton/scratch/blocks/Binary/Trade Definition/trade_definition.js:178, 196` |
| `BinaryBotPrivateInit` (which contains that `Bot.init`) is executed **once**, before the trade loop | `…/scratch/dbot.js:379` |
| The engine subscribes to ticks once: `if (!this.checkTicksPromiseExists()) this.watchTicks(symbol)` | `…/services/tradeEngine/trade/index.js` `init()` |
| Every purchase is forced onto that symbol: `this.tradeOptions = { …validated, symbol: this.options.symbol }` | same file, `start()` |
| Every analysis block reads the subscribed symbol only — `lastDigitList → Bot.getLastDigitList()`, `ticks → Bot.getTicks()`, `last_digit → Bot.getLastDigit()`; **no block takes a symbol argument** | `…/scratch/blocks/Binary/Tick Analysis/*.js` |

Consequences:

* A single XML **cannot** analyse V10 and V50 at the same time, and cannot
  re-point itself to another market mid-run. Any "multi-market dbot XML" that
  claims otherwise either silently trades one market or errors out.
* Switching is therefore a **stop → retarget → run** cycle driven by the host
  app, executed strictly between contracts.

This is already acknowledged in the existing Turbo generator
(`artifacts/api-server/src/lib/overunder-turbo-dbot.ts`, header comment: *"The
one thing a DBot cannot do is Turbo's SWITCHING mode"*).

---

## 2. What already exists (do not rebuild)

| Capability | Where | Reuse |
| --- | --- | --- |
| Deriv-Bot XML generator with a tiny Blockly builder (`variables_set`, `controls_if`, `controls_forEach`, `math_*`, `purchase`, `trade_again`, `procedures_*`, `notify`, …) | `api-server/src/lib/overunder-turbo-dbot.ts` (722 lines) | Extend / fork into `digit-forge-dbot.ts` |
| **The exact barrier vocabulary asked for** — `DUAL_LOCK_NORMAL_CONTRACTS` = Over 1, Over 2, Under 7, Under 8; `DUAL_LOCK_RECOVERY_CONTRACTS` = Over 4, Over 5, Under 4, Under 5 | `api-server/src/lib/dual-lock-analysis.ts:90-119` | Import as-is (single source of truth) |
| Statistical stack: effective sample size, conservative (lower-bound) rate, one-sided p-value vs break-even, χ²/block stationarity z, loss-clustering Markov ξ, conditional transition rate, stationary block-bootstrap session simulation, Benjamini–Hochberg FDR screen | `dual-lock-analysis.ts` (`effectiveSampleSize`, `conservativeRate`, `edgePValue`, `stationarityZ`, `lossClustering`, `conditionalTransitionRate`, `simulateSession`, `screenAndRank`) | Import |
| Payout table (total-return multipliers) | `specialist-analysis.ts: payoutForBarrier` | Import |
| Recovery stake policy (debt × (1+markup)/(payout−1), floor 0.35, cap max-stake & balance, round up, partial-win carry) | `recovery-math.ts`, `recovery-payout.ts`, `.agents/memory/recovery-exact-live-payout.md` | Import + emit into XML |
| Host → builder strategy bridge with ack/retry and live `contracts_for` market-path verification | `trading-platform/src/lib/bot-builder-frame.ts` (`loadStrategyIntoBotBuilder`), `dbot-builder/src/preview/strategy-bridge.ts` | Reuse unchanged |
| Persistent, always-warm builder iframe (never re-parented, survives navigation, keeps a running bot alive) | `bot-builder-frame.ts` (this branch) | **Prerequisite for supervised switching** |
| Console/panel plumbing: registry, contract ids, arena cards | `trading-platform/src/lib/console-registry.ts`, `console-contract.ts`, `api-server/src/lib/bot-catalog.ts` | Add one entry |
| Correctness tests for generated XML (stock-block whitelist, balanced tags, unique ids, trade-definition shape, fixture snapshots) | `overunder-turbo-dbot.test.ts`, `overunder-turbo-dbot.fixtures.ts` | Clone the pattern |

The genuinely **new** work is: (a) a no-scan forge panel, (b) a rotation
supervisor, (c) the bandit/drift math for choosing and leaving a market.

---

## 3. The mathematics

### 3.1 The edge budget — the number everything else has to beat

For a fair 10-sided digit, with the repo's payout table (total return per 1
staked, `payoutForBarrier`):

| Contract | Fair win prob. | Payout | Break-even `1/payout` | Required excess |
| --- | --- | --- | --- | --- |
| Over 1 (d ≥ 2) | 0.800 | 1.23 | 0.8130 | **+1.30 pt** |
| Over 2 (d ≥ 3) | 0.700 | 1.40 | 0.7143 | **+1.43 pt** |
| Under 7 (d ≤ 6) | 0.700 | 1.40 | 0.7143 | **+1.43 pt** |
| Under 8 (d ≤ 7) | 0.800 | 1.23 | 0.8130 | **+1.30 pt** |
| Over 4 (d ≥ 5) | 0.500 | 1.95 | 0.5128 | **+1.28 pt** |
| Under 5 (d ≤ 4) | 0.500 | 1.95 | 0.5128 | **+1.28 pt** |
| Over 5 (d ≥ 6) | 0.400 | 2.43 | 0.4115 | **+1.15 pt** |
| Under 4 (d ≤ 3) | 0.400 | 2.43 | 0.4115 | **+1.15 pt** |

So the house edge is ≈ 1.2–1.6 % of stake per trade, *uniformly across the
whole barrier vocabulary*. **A fixed-barrier bot with no selection is −EV by
construction.** The only sources of positive expectation are:

1. **Transient distributional bias** — a window where the empirical digit mass
   over/under the barrier exceeds break-even by a statistically defensible
   margin.
2. **Sequence dependence** — Markov / streak structure that makes the *next*
   tick's win probability higher than the marginal one.
3. **Cross-market selection** — 12–16 digit markets are sampled in parallel;
   the best one at any moment is materially better than the average one
   (this is precisely why market switching matters, and why it must be
   FDR-corrected: picking the max of 16×8 noisy estimates is a multiple-testing
   trap).

Nothing here changes the EV of a *forced* trade; the bot's job is to only fire
when (1)+(2)+(3) jointly clear break-even, and to keep session variance under
control with the recovery ladder + TP/SL + circuit breaker.

### 3.2 How much data is needed (be honest about this)

One-sided test, α = 0.05, power 0.8:
`n ≈ (z_α + z_β)² · p(1−p) / Δ²` with `z_α = 1.645`, `z_β = 0.84`.

| Target excess Δ | p = 0.70 | p = 0.50 |
| --- | --- | --- |
| 1.3 pt (just beat break-even) | ≈ 7 700 ticks | ≈ 9 100 ticks |
| 3 pt | ≈ 1 440 | ≈ 1 720 |
| 5 pt | ≈ 520 | ≈ 620 |

And that is the **effective** sample size: digit series are mildly
autocorrelated, so `effectiveSampleSize()` (already implemented via the
autocorrelation-corrected variance inflation `n_eff = n·(1−ρ)/(1+ρ)`) typically
knocks 10–30 % off.

Design consequence: the in-XML window (`lastDigitList` caps at 1000 digits) can
only ever confirm **large, transient** biases (≥ 3–5 pt). Marginal edges must be
established server-side on the long tape (`digit-tape.ts`) and then *baked into
the XML as a parameter*, with the XML doing only a cheap confirmation read. That
split is exactly what the Turbo generator already does with its ARM-ONCE gate.

### 3.3 Estimators and tests (all already in `dual-lock-analysis.ts`)

* **Point estimate with decay** — EWMA rate `p̂ = Σ w_i x_i / Σ w_i`,
  `w_i = λ^(n−i)`, so a regime change is reflected quickly.
* **Conservative rate** — one-sided Agresti–Coull / Wilson lower bound
  `p_lo = (p̂ + z²/2n_eff − z·√(p̂(1−p̂)/n_eff + z²/4n_eff²)) / (1 + z²/n_eff)`.
  A candidate is only eligible if **`p_lo > 1/payout`** — i.e. the *lower*
  bound beats break-even, not the point estimate.
* **Significance** — `edgePValue()` (one-sided binomial/normal) against the
  break-even rate, then **Benjamini–Hochberg** across all (market × barrier)
  candidates at q = 0.2 (`screenAndRank`), which is the correct answer to "we
  scanned 128 combinations and took the best one".
* **Stationarity** — `stationarityZ()` splits the window into 4 blocks and
  rejects candidates whose block rates disagree (a bias that only existed in
  block 1 is not tradeable).
* **Markov / clustering** —
  * `lossClustering()` gives ξ = P(loss | loss) / P(loss); ξ > 1 means losses
    cluster, which is what actually kills a recovery ladder (it makes the
    "independent losses" assumption optimistic).
  * `conditionalTransitionRate()` gives the estimand that *matters* for the
    recovery leg: **P(recovery contract wins | previous digit ∈ normal-loss
    set)** — recovery never trades from a random state, it trades from the
    state that just produced a loss, so its win rate must be measured
    conditionally.
  * For the state-transition model, bucket the 10 digits into the 2–4 sets the
    contract cares about (win/loss, or {0-1, 2-4, 5-7, 8-9}) before estimating.
    A full 10×10 chain has 100 cells; 1 000 samples gives ~10 per cell, which is
    noise. Use Laplace smoothing (add-α) and test dependence with the
    likelihood-ratio statistic `G² = 2Σ O·ln(O/E)`, `df = (k−1)²`.
* **Session outcome** — `simulateSession()` runs a **stationary block
  bootstrap** (resampling geometric blocks preserves autocorrelation) of the
  full normal→recovery→breaker→TP/SL policy and returns **P(hit TP before
  SL)**, the median trade count and the drawdown quantiles. This, not win rate,
  is the number the panel should show the user.

### 3.4 Choosing (and leaving) a market — the rotation math

Treat each market as an arm of a **non-stationary (restless) bandit**:

* **Posterior per arm** — Beta(1 + w, 1 + l) over the normal contract's win
  rate, with **exponential discounting** of old observations
  (`w ← γw + x`, `l ← γl + (1−x)`, γ ≈ 0.99) so a market that was good an hour
  ago decays back toward the prior.
* **Selection** — Thompson sampling (draw `θ_i ~ Beta_i`, pick
  `argmax_i (θ_i·payout_i − 1)`) or discounted UCB1
  `p̂_i + √(2 ln Σn / n_i)`. Thompson handles non-stationarity better and needs
  no tuning constant.
* **Leave rule (drift detection)** — one-sided **CUSUM** on the log-likelihood
  ratio between "still ≥ break-even" and "now at fair":
  `S_t = max(0, S_{t−1} + ln(f_fair(x_t)/f_edge(x_t)))`, alarm at `S_t > h`
  (h ≈ 5 gives ~1 false alarm per e^5 ≈ 150 observations). Equivalent cheap
  version already in the repo: `turboMarketHealth()`.
* **Switching cost** — a stop/retarget/run cycle costs ~1–3 s plus the ticks
  needed to re-arm on the new tape. Model it as `c` forgone trades and only
  switch when `E[edge_new] − E[edge_current] > c/H` over the remaining horizon
  `H`. Without this term a bandit thrashes.
* **Never switch inside a recovery ladder.** Debt is market-specific state; the
  ladder must complete (or the breaker must fire) before rotation is allowed.
  This is a hard rule, not a preference.

### 3.5 Staking

* Normal leg: flat base stake, or **fractional Kelly**
  `f* = (p·b − (1−p)) / b` with `b = payout − 1`, scaled by ¼–½ and capped by
  `settings.maxTradeStake`. At Δ = 1.5 pt over break-even, full Kelly on Over 2
  is ≈ 3.8 % of bankroll — far too hot; ¼-Kelly ≈ 1 %.
* Recovery leg: the repo's canonical **exact live-payout** formula
  (`recovery-math.ts`): `stake = (debt + markup·debt) / (payout − 1)`, floored
  at 0.35, capped at `maxTradeStake` and at the live balance, rounded up to the
  cent, with partial-win debt carry and `maxRecoverySteps` / `breakerDepth`
  limits. Already emitted into XML by the Turbo generator as a
  `procedures_defnoreturn` named *"Size recovery stake"* — reuse verbatim so
  the DBot and NeuroTrade's own executor can never diverge.

---

## 4. The generated strategy (block-level blueprint)

```
trade_definition                              ← top-level, x=0 y=0
├── TRADE_OPTIONS  (fixed, deletable=false movable=false, in this exact order)
│   trade_definition_market        MARKET_LIST=synthetic_index
│                                  SUBMARKET_LIST=random_index
│                                  SYMBOL_LIST=R_50
│   trade_definition_tradetype     TRADETYPECAT_LIST=digits, TRADETYPE_LIST=overunder
│   trade_definition_contracttype  TYPE_LIST=both            ← both purchase options
│   trade_definition_candleinterval CANDLEINTERVAL_LIST=60
│   trade_definition_restartbuysell TIME_MACHINE_ENABLED=FALSE
│   trade_definition_restartonerror RESTARTONERROR=TRUE
├── INITIALIZATION  (runs once)
│   Base Stake / Stake / Contract / Barrier / Recovery Debt / In Recovery /
│   Recovery Step / Loss Run / Normal Payout / Recovery Payout / Armed / Arm Ticks
│   notify(info, "Digit Forge · <market> · Over 2 → Over 4 · stake … TP … SL …")
└── SUBMARKET (trade options, re-read every cycle)
    trade_definition_tradeoptions  DURATIONTYPE_LIST=t, DURATION=1,
                                   AMOUNT ← variable "Stake",
                                   PREDICTION ← variable "Barrier",
                                   CURRENCY_LIST=<account currency>

before_purchase
└── if not Armed:  count hits of the normal win-set in the last N digits
                   (lastDigitList → lists_getSublist → controls_forEach)
                   arm when hits/N ≥ 1/normalPayout, or when Arm Ticks > timeout
    if Armed:      purchase(Contract)          ← "DIGITOVER" | "DIGITUNDER"

after_purchase
├── read_details(4) → Last Return, read_details(2) → Last Stake
├── if contract_check_result(win):
│       if In Recovery: debt ← max(0, debt − netProfit); if debt = 0 → leave recovery
│       else:           Loss Run ← 0
├── else:
│       Loss Run ← Loss Run + 1;  debt ← debt + Last Stake
│       In Recovery ← true; Contract ← recovery side; Barrier ← recovery barrier
│       call "Size recovery stake"
├── if total_profit ≥ TP  or  total_profit ≤ −SL  or  Loss Run ≥ breakerDepth: stop
└── else trade_again
```

Everything above uses **stock builder blocks only** — the same whitelist the
Turbo generator already asserts in tests (`TURBO_DBOT_BLOCK_TYPES`).

---

## 5. "It must not error when we run it" — the 12 real failure modes and their guards

| # | Failure mode | Guard | Where it is enforced |
| --- | --- | --- | --- |
| 1 | XML references a block type the builder does not register → block silently dropped / workspace refuses to load | Whitelist of stock block types; test asserts **every** `type="…"` in the output is in it | generator + unit test |
| 2 | Malformed XML (unbalanced tags, duplicate block ids, unescaped `&`/`<` in a market name) | `esc()` on every field; test parses the XML, checks balance and id uniqueness | generator + unit test |
| 3 | Incomplete trade definition (missing `trade_definition_contracttype`, wrong child order) → `market_block.getFieldValue` throws during code generation | Fixed skeleton emitted as one literal, all six children `deletable="false" movable="false"`, plus a committed fixture snapshot | generator + fixture test |
| 4 | Market/submarket/symbol triple inconsistent, or Deriv re-homes a symbol → empty dropdowns, "Please select a market" | Static map (`marketPathForSymbol`) **plus** live re-verification against `contracts_for` inside the iframe before `load()` (`withVerifiedMarketPath`) | strategy-bridge |
| 5 | Symbol closed / suspended at forge time | Forge-time check against `active_symbols` (`exchange_is_open`, `is_trading_suspended`); refuse and suggest the next-best market | API route |
| 6 | Illegal barrier (`DIGITOVER 9`, `DIGITUNDER 0`, non-integer prediction) | Barrier vocabulary is a frozen constant (Over 1/2/4/5, Under 4/5/7/8 — all legal); prediction passed as `math_number_positive` shadow + integer variable | generator + `ensure()` |
| 7 | Stake below Deriv's minimum, above `maxTradeStake`, or wrong currency | `ensure(stake ≥ 0.35)`, `math_constrain` + `ROUNDUP` in the XML, `CURRENCY_LIST` taken from the **connected account**, never hardcoded | generator + panel |
| 8 | `purchase` names a contract not in the definition's type list | `TYPE_LIST=both` for `overunder`, and `PURCHASE_LIST ∈ {DIGITOVER, DIGITUNDER}` | generator |
| 9 | Variables used but not declared → orphan variable ids on load | `XmlBuilder.variable()` registers every name and emits `<variables>` | generator |
| 10 | `trade_definition` generator throws **"Please log in"** when the builder has no Deriv session | Panel requires a connected Deriv account; the host already pushes the session into the iframe (`syncBotBuilderSession`) and the bridge waits for the workspace | panel + bridge |
| 11 | Strategy posted before the builder document exists | `loadStrategyIntoBotBuilder` re-posts every second until the iframe acks, 45 s timeout, and the builder is now permanently warm | bot-builder-frame |
| 12 | A future change to the vendored builder silently breaks generation | **Strongest guard, to be added:** a jest test in `artifacts/dbot-builder` that `load()`s the generated XML into a real (jsdom) Blockly workspace and then runs `DBot.generateCode()`, asserting it produces JS without throwing. The infrastructure exists — `scratch/__tests__/blockly-load.spec.js` already boots Blockly in jest | new test |

Guards 1–3 and 9 are already implemented for the Turbo bot; 12 is the one I
would add for both bots, because it turns "the XML looks right" into "the XML
loads **and compiles** in the real builder".

---

## 6. Market switching — three options, with a recommendation

**Option A · Forge-time selection (ship first).**
The panel's *Create DBot* runs the server-side ranking over all digit markets ×
8 barriers (existing `evaluateMarket` + `screenAndRank`), picks the winner and
emits an XML locked to it. Cost: zero new risk, no engine interaction.
Limitation: to move markets the user presses *Create DBot* again (one click,
~2 s), which reloads the workspace.

**Option B · Supervised rotation (phase 2, opt-in).**
NeuroTrade watches the run and rotates automatically. Needs three additions:

1. Builder → host events: `bot.running`, `bot.stopped`, contract settled, and
   current debt/recovery state (the observers already emit these internally —
   `globalObserver.emit('bot.running')` etc.; the preview bridge just has to
   forward them).
2. Host → builder commands: `SET_MARKET(symbol)` (set the three fields on the
   `trade_definition_market` block and fire a `BlockCreate`-style refresh — the
   same mechanism `app_store.refreshMarketBlocks()` already uses) and
   `RUN` / `STOP` (call `dbot.runBot()` / `dbot.stopBot()`).
3. A supervisor in the host implementing §3.4: discounted Thompson sampling +
   CUSUM leave-rule + switching cost, with the **hard rules**: never switch
   while a contract is open, never switch mid-recovery-ladder, always re-arm on
   the new tape, and stop everything on TP/SL/breaker.

Dead time per switch ≈ 1–3 s. Because the builder iframe is now persistent
(this branch), the supervisor keeps working while the user browses the app.

**Option C · Multi-market inside one XML — not possible.** See §1.

**Recommendation: A now, B behind an explicit "Auto-rotate markets" switch,
default off, with a visible log of every rotation decision.**

---

## 7. Product surface

* New console id `digit-forge@1` → `console-contract.ts` (`WEB_CONSOLE_IDS`),
  `console-registry.ts` (`CONSOLE_REGISTRY`), catalogue entry in
  `api-server/src/lib/bot-catalog.ts`.
* New panel `trading-platform/src/components/digit-forge-console.tsx`, modelled
  on `overunder-turbo-console.tsx` but with **no scan step**: the primary button
  is **Create DBot** (the arena card gets a FORGE badge instead of SCANNER).
* Settings in the panel: base stake · take-profit · stop-loss · normal barrier
  (Over 1 / Over 2 / Under 7 / Under 8 / **Auto**) · recovery barrier (Over 4 /
  Over 5 / Under 4 / Under 5 / **Auto**) · recovery markup % · max recovery
  steps · circuit-breaker depth · market (specific / **Best available**) ·
  auto-rotate (phase 2) · arm window & timeout (advanced).
* New route `POST /api/bots/digit-forge/dbot` → `buildDigitForgeStrategy()` →
  `{ name, xml, summary }`; the panel calls `loadStrategyIntoBotBuilder()` and
  navigates to `/bot-builder`, exactly like Turbo does today.

---

## 8. Delivery plan

| Phase | Content | Rough size |
| --- | --- | --- |
| 1 | `digit-forge-dbot.ts` generator + `ensure()` validation + unit/fixture tests; `POST /api/bots/digit-forge/dbot`; catalogue + console registration; panel with settings and **Create DBot**; forge-time market ranking (Option A) | ~1 day |
| 2 | The jsdom **load + generateCode** test (guard #12) for both generators | ~2 h |
| 3 | Rotation supervisor (Option B): bridge events + `SET_MARKET`/`RUN`/`STOP`, Thompson + CUSUM + switch-cost policy, rotation log in the panel, hard safety rules | ~1–1.5 days |
| 4 | Backtest harness: replay recorded tapes through `simulateSession` and through the *generated* XML's decision rule, and assert they agree (prevents drift between NeuroTrade's executor and the DBot) | ~0.5 day |

---

## 9. Honest caveats (say these in the UI too)

* Deriv synthetics are generated to be i.i.d. uniform. A **persistent** digit
  edge is not guaranteed to exist; what the scanner finds are transient windows,
  and the FDR screen exists precisely because scanning 128 combinations will
  always produce a "best" one even on pure noise.
* Every barrier in this vocabulary carries a ≈1.2–1.6 % house edge per trade.
  The recovery ladder changes the *shape* of the session outcome distribution
  (many small wins, rare large losses), not its expectation. TP/SL, the
  circuit breaker and the max-recovery-step cap are what keep the tail finite.
* The generated bot is a **stock Deriv Bot**: once the user presses Run, Deriv's
  engine owns execution — NeuroTrade cannot cancel a contract that is already
  bought, and a supervised market switch can only happen between contracts.
