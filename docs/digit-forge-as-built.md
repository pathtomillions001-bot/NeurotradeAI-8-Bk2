# Digit Forge · Part III — as built (phases 1–3)

Parts I and II are the design. This is the **record of what actually shipped**,
what it does at runtime, and how each promise is held down by a test. Where the
build deviates from the design, the deviation is stated here and this document
wins.

Status: **phases 1–3 complete.** Phase 4 (in-XML market rotation via the
vendored-builder engine extension) is not built; the generator already accepts
and echoes the watch list so the switch has a landing place.

---

## 1. What a user does

1. Bot Arena → **Digit Forge** card (fuchsia, `BOT-DF-FORGE`, tagged **FORGE**).
2. The panel asks for: market, normal barrier (Over 1/2 · Under 7/8), recovery
   barrier (Over 4/5 · Under 4/5), stake, TP, SL, max recovery steps, circuit
   breaker, and — under *In-bot analysis* — tick window, minimum samples,
   confidence z, patience limit, Markov test on/off, streak cooldown on/off.
3. **Create DBot** (the panel's only primary action — there is no scan).
4. The app POSTs the settings, receives Blockly XML, pushes it into the warm
   bot-builder iframe and routes to **/bot-builder**.
5. The user sees the blocks, presses Deriv's own **Run**. NeuroTrade is out of
   the loop from that moment.

The panel never starts a session, never polls status and has no stop button,
because there is nothing running on this side.

---

## 2. Where the analysis lives

Inside the generated workspace. The bot re-derives its own opinion from
`Bot.getLastDigitList()` before **every** normal entry:

| Step | Block-level implementation |
| --- | --- |
| Window | `lists_getSublist` of the last `Window Size` digits (default 120, clamped 20–300) |
| Classify | `controls_forEach` sets `Is Win` per digit against the normal barrier (`math_modulo` + `logic_compare`) |
| Point estimate | wins / n |
| Uncertainty | Agresti–Coull: `ñ = n + z²`, `p̃ = (wins + z²/2)/ñ`, `Worst Case Rate = p̃ − z·√(p̃(1−p̃)/ñ)` (`math_single ROOT`) |
| Break-even | `1 / payout`, refreshed from the realised payout after every win (`read_details`) |
| Sequence structure | 2-state Markov counters (`Loss to Loss`, `Loss to Win`, `Win to Loss`, `Win to Win`) → `Dependence G2 = 2Σ O·ln(O/E)` (`math_single LN`) |
| Dependence gate | conditional rate only votes when `G2 > 3.84` (χ²₁, 5 %) |
| Streak cooldown | stand down while `Adverse Run > ⌈ln(W(1−q))/ln(1/q) + 2σ⌉` (`Run Limit`, a forge-time literal) |
| Decision | `Gate Pass` → `Fire` → exactly one `purchase` of the declared contract type |

`Evaluations` counts refusals; every 25th emits a *Holding fire* notification so
the user can see the bot is alive and why it is not trading. With
`forceEntryAfter > 0` the bot takes one entry anyway once that many refusals
accumulate (*Patience limit of N evaluations*); the default `0` means infinite
patience.

**Recovery is deliberately ungated.** `before_purchase` checks `In Recovery`
first and fires immediately — debt is cleared at the 50 %/40 % barrier where one
win repays ≈1.1 losses, instead of waiting out a gate that was designed for the
80 %/70 % barrier.

---

## 3. Recovery — the app's own ladder, compiled into blocks

`Size recovery stake` reproduces `getBotRecoveryStake`
(`artifacts/api-server/src/lib/agents/recovery-engine.ts`) exactly:

```
stake = ceil₂( debt × (1 + markup/100) / (payout − 1) )
stake = max(0.35, min(stake, maxTradeStake, balance))
```

`markup` and `maxTradeStake` are read from the user's saved settings at forge
time, so the generated bot agrees with every other NeuroTrade bot. The ladder
ends on `maxRecoverySteps` (debt abandoned, back to base stake behind the gate),
on the circuit breaker (`breakerDepth` consecutive losses), or on TP/SL.

Verified numerically in the builder suite: stake 0.50 → L → `ceil₂(0.55/0.95)` =
**0.58** → L → `ceil₂(1.188/0.95)` = **1.26** → W clears the debt → back to the
normal leg at 0.50.

---

## 4. Files

| Path | Role |
| --- | --- |
| `artifacts/api-server/src/lib/dbot-xml.ts` | Shared Blockly-XML emitter (extracted from the Turbo generator, byte-identical — its fixtures prove it). Adds `single`, `onList`, `mod`, `not`, `all`, `callReturn`, `defReturn`, `change`. |
| `artifacts/api-server/src/lib/digit-forge-dbot.ts` | The generator: `DIGIT_FORGE_BLOCK_TYPES`, `fairWinRate`, `expectedMaxRun`, `ladderRisk`, `buildDigitForgeStrategy`. |
| `artifacts/api-server/src/lib/digit-forge-dbot.test.ts` | 22 tests: allowlist, root scopes, XML well-formedness, variable declaration completeness, trade-definition order, unconditional trade options, gate maths constants, input rejection, clamping. |
| `artifacts/api-server/src/lib/digit-forge-dbot.fixtures.ts` | The three committed fixtures; `--write` regenerates them. |
| `artifacts/api-server/src/routes/digit-forge.ts` | `GET /options`, `POST /dbot`, `POST /risk`. No engine, no session state. |
| `artifacts/api-server/src/lib/bot-catalog.ts` | `digit-forge` entry, `forge` flag, console id `digit-forge@1`. |
| `artifacts/trading-platform/src/components/digit-forge-console.tsx` | The settings panel whose primary button is **Create DBot**. |
| `artifacts/trading-platform/src/lib/console-registry.ts` | Registers the console; `FORGE_CONSOLE_IDS` / `consoleIsForge` drive the new FORGE badge (kept distinct from SCANNER, which promises scan-and-trade). |
| `artifacts/dbot-builder/src/preview/__tests__/digit-forge-strategy.spec.js` | **The acceptance test** — real Blockly, real code generation, real execution. |

---

## 5. "It must not error when it runs" — how that is held down

The builder suite loads each committed fixture into the **real** Deriv Blockly
with every vendored block definition, applies the same pre-load validation
`load()` applies, compiles it exactly the way `dbot.generateCode()` does, and
executes the result against a scripted market with a fake `Bot` interface.

Nine specs, all passing alongside the six Turbo ones:

| Spec | What it would catch |
| --- | --- |
| loads with every root block and both procedures intact | an unknown block type (rejects the whole workspace), or a `procedures_callnoreturn` whose mutation name does not match a definition — Blockly silently roots an empty duplicate and the call becomes a no-op |
| compiles and reads the tape before every normal entry | a gate that never calls `Bot.getLastDigitList()` (i.e. analysis that is not actually running in-bot) |
| refuses a dead tape without throwing | division by zero in the Agresti–Coull/G² arithmetic on degenerate windows; an infinite loop that throws rather than waits |
| runs the shared recovery ladder | any drift from `getBotRecoveryStake` — the stakes are asserted to the cent |
| fires recovery without consulting the gate | a gate that also blocks recovery (debt would never be cleared) |
| trips the circuit breaker | an off-by-one in the consecutive-loss counter |
| stops at TP and at SL | boundaries that never halt the run |
| honours the patience limit | the forced-entry escape hatch failing to compile or to fire |
| never buys an undeclared contract type/barrier | `purchase` naming a type absent from `trade_definition_contracttype` — the classic runtime error for generated DBots |

Structural guards that sit in the API-side suite instead: the block allowlist,
`trade_definition` child order, trade options never being emitted inside a
conditional (`BinaryBotPrivateHasCalledTradeOptions` would stay false and the
interpreter would spin), every `VAR` reference being declared in `<variables>`,
and XML escaping of user-supplied market names.

Run them:

```bash
# generator + fixtures (429 tests incl. the rest of the API suite)
corepack pnpm --filter @workspace/api-server test
# real-Blockly load + compile + execute
cd artifacts/dbot-builder && npm install && npx jest src/preview/__tests__/
```

---

## 6. Deviations from Parts I and II

- **No `State` variable.** `Prev State` already carries the last digit's
  membership after the classification loop.
- **`Run Limit` is a forge-time literal**, not a runtime variable — the window
  size is fixed at forge time, so the expected-max-run bound is too.
- **Waiting report every 25 evaluations**, not 30.
- **`forceEntryAfter` defaults to 0** (infinite patience) rather than a
  non-zero default; an impatient default would undo the gate.
- **`exitRecovery` also resets `Gate Pass` and `Evaluations`**, so the first
  normal entry after a recovery must re-qualify from scratch.
- **`watchMarkets` is accepted, validated and echoed in the summary only.** It
  is the phase-4 landing place; a comment in `after_purchase` marks where the
  in-XML switch belongs. No non-stock blocks are emitted today.

---

## 7. Still honest about the edge

Nothing here makes a digit contract positive-expectation. Deriv prices every
barrier in this vocabulary below its fair odds, the synthetics are i.i.d., and a
120-tick window cannot prove a small edge. What the generated bot does is refuse
to trade a tape that has not cleared its own break-even with statistical room to
spare, cap the damage when it is wrong, and clear debt at the barrier where
clearing is cheapest. The panel says exactly this, in the panel.
