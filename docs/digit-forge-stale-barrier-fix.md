# Digit Forge — the "it trades Under 2" bug (stale prediction) and the recovery drift

**Report.** The generated Digit Forge DBot is supposed to trade **Over 1 / Over 2
/ Under 7 / Under 8** in normal mode and **Over 5 / Under 4** in recovery,
choosing the best market for that contract. In a live run it bought **Under 2**,
and its recovery ladder did not behave like the recovery in the app.

Both symptoms have **one root cause**.

---

## 1. Root cause — the barrier and the side came from different moments in time

The Deriv Bot interpreter's main loop is (`scratch/dbot.js → generateCode()`):

```
while (true) {
    BinaryBotPrivateRun(BinaryBotPrivateStart);       // ← Bot.start(tradeOptions)
    while (watch('before')) BinaryBotPrivateBeforePurchase();   // ← purchase()
    …
    BinaryBotPrivateRun(BinaryBotPrivateAfterPurchase);         // ← settlement
}
```

* `BinaryBotPrivateStart` is the Trade Definition's **SUBMARKET** stack. It calls
  `Bot.start({ amount, prediction, … })`, which freezes `this.tradeOptions`
  — **including `prediction`, the digit barrier** — for the whole cycle
  (`services/tradeEngine/trade/index.js`, `start()`).
* Only afterwards does `before_purchase` run, where
  `nt_analyse_digit_markets` ranks every legal barrier on every watched market
  and writes the winner into the `Contract` and `Barrier` variables.
* The stock `purchase` block names only a **contract type**. The barrier it
  actually buys is whatever `Bot.start` captured **one cycle earlier**.

So the buy combined:

| Component | Where it came from |
| --- | --- |
| side (`DIGITOVER` / `DIGITUNDER`) | the ranker, milliseconds ago |
| barrier (`prediction`) | the previous settlement / the init block |

Concrete: the workspace is initialised at `Over 2`, so `prediction = 2`. The
ranker then decides `Under 7`. The bot buys `DIGITUNDER` with `prediction = 2`
→ **Under 2**. Same mechanism gives Over 7, Over 8, Under 1 …

**In recovery it is worse than cosmetic.** The workspace enters recovery on the
configured leg (say Over 5, so `prediction = 5`). The recovery ranker picks
`Under 4`. The bot buys **Under 5** — not in the recovery vocabulary at all, and
priced **1.95×** while the ladder stake had been sized as
`debt × (1 + markup) / (2.43 − 1)`. A "winning" recovery trade then returns less
than the debt it was sized to clear, so the ladder limps on, deepens, and
diverges from `getBotRecoveryStake` in the app. That is the "recovery logic is
wrong" report.

The acceptance suite never caught it because its fake ranker always returned the
same barrier the fixture was configured with.

---

## 2. The fix

### 2.1 The buy carries its own barrier (`artifacts/api-server/src/lib/digit-forge-dbot.ts`)

Digit Forge now buys through **`nt_purchase_contract`** — the vendored block
Omni Forge already uses — which sets `tradeOptions.prediction` **just in time**,
immediately before the buy (`trade/Purchase.js → ntPurchaseContract`). Contract
and barrier travel together, atomically:

```
nt_purchase_contract  CONTRACT = Contract   BARRIER = Barrier
```

The stock `purchase` block is gone from the generated XML (and from
`DIGIT_FORGE_BLOCK_TYPES`). The builder's mandatory-block gate already accepts
`nt_purchase_contract` as the Purchase block
(`utils/workspace.js → MANDATORY_BLOCK_ALIASES`), so the Run button still arms.

### 2.2 Contract sovereignty, checked on every fire

The same guard the app's executors apply on every buy
(`dual-lock-engine.ts`: *"Contract sovereignty — checked on EVERY fire, both
legs"*) is now compiled into the workspace:

```
if  (not in recovery AND pair ∈ {Over 1, Over 2, Under 7, Under 8})
 or (in recovery     AND pair ∈ {Over 5, Under 4})        → buy
else                                                      → refuse, report
                                                            "INTEGRITY · refused …",
                                                            restore the configured
                                                            leg, stand down
```

Both sets are generated from `DIGIT_FORGE_NORMAL_CONTRACTS` /
`DIGIT_FORGE_RECOVERY_CONTRACTS`, so the XML can never drift from the server's
definition of legal.

### 2.3 The runtime ranker cannot publish an illegal pair

`ntAnalyseDigitMarkets` (`trade/Ticks.js`) now validates every analysed row, and
the final decision, against the mode's frozen candidate list; anything else is
dropped and replaced by a legal, ineligible fallback
(`contract integrity check failed; holding`).

### 2.4 Recovery ladder parity with the app

* **Entering recovery re-seeds `Recovery Payout`** with the recovery leg's
  payout, so the ladder always divides by the price of the contract it is about
  to buy — never by whatever multiplier the normal leg left behind. This matches
  `resolveRecoveryPayout` + `getBotRecoveryStake` in
  `agents/recovery-engine.ts`, and matches Omni Forge.
* **Every debt movement is rounded to whole cents** (entry, deepening and
  repayment), the block-level equivalent of `addMoney()` / `toCents()` in
  `recovery-math.ts`. Float dust such as `0.8899999999999999` can no longer
  survive the "is the debt cleared?" test and buy one extra debt-sized trade.

The stake formula itself is unchanged and still verbatim:
`ceil₂(debt × (1 + markup/100) / (payout − 1))`, floored at 0.35, capped at
`maxTradeStake` and at the balance.

---

## 3. Tests that would have caught it (and now do)

`artifacts/dbot-builder/src/preview/__tests__/digit-forge-strategy.spec.js`
loads the committed fixture into the **real** Blockly, compiles it with the real
generator and executes it. Its fake ranker can now be scripted per evaluation:

| New spec | Fails on the old generator with |
| --- | --- |
| buys the barrier the ranker just chose, never the one captured a cycle earlier | `unexpected contract DIGITUNDER barrier 2` |
| keeps recovery strictly on Over 5 / Under 4 and clears the debt there | bought `DIGITUNDER 5` instead of `DIGITUNDER 4` |
| refuses a pair outside its vocabulary instead of buying it | bought Under 2 instead of refusing |

Generator-side (`digit-forge-dbot.test.ts`): the buy site must be
`nt_purchase_contract` carrying both variables and no `PURCHASE_LIST` may exist;
the sovereignty guard must contain exactly the six legal pairs; the ladder must
re-seed the recovery payout and round debt to cents.

```bash
corepack pnpm --filter @workspace/api-server test     # 484 tests
cd artifacts/dbot-builder && npx jest src/preview/__tests__/   # 44 tests
```
