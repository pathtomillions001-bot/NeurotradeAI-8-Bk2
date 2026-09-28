# Digit Forge — current runtime and recovery contract

Parts I and II describe the original design. This document records what the
adaptive generator and vendored builder actually execute. It supersedes the
older fixed-barrier, four-recovery-barrier and ungated-recovery descriptions.

## Allowed trades

The DBot scans its validated watchlist (up to eight markets, including the
starting market). A contract is a **market + side + barrier** tuple, never an
independently chosen side and prediction.

| Mode | The complete allowed set |
| --- | --- |
| Normal, no outstanding loss debt | **Over 1, Over 2, Under 7, Under 8** |
| Recovery, outstanding loss debt | **Over 5, Under 4** |

The console's initial normal/recovery pair seeds Trade Definition; it does not
lock the scanner to that pair. The runtime re-ranks the legal set before each
entry, preferring qualified candidates across all watched markets. Its Beta
posterior, confidence bounds, expected value, loss-conditioned transitions,
window stability and clustering tests run in the browser's bot runtime, not
on the NeuroTrade API. Recovery also requires the same candidate to qualify on
two **distinct ticks**. A successful buy resets that confirmation.

The optional patience limit applies **only to normal mode**. It never overrides
the recovery gate, the contract allowlist, quote validation or balance limits.
No usable tape/quote means hold, not a fallback purchase.

## Reported incident: why Under 2 could be bought

The scanner's allowlist was already correct. The handoff to the stock purchase
block was not:

1. Trade Definition called `Bot.start()` with the initial prediction **2**.
2. In `before_purchase`, the scanner selected **Under 7** and updated Blockly's
   `Contract` and `Barrier` variables.
3. The stock block called only `Bot.purchase('DIGITUNDER')`. It did **not** pass
   the new barrier or refresh `tradeOptions.prediction`.
4. The engine therefore bought **Under 2**. Similarly, a seeded recovery
   **Over 5** could become **Under 5** when the ranker selected **Under 4**.

The wrong recovery pair also changed the realised payout, causing unexpected
partial recovery and another recovery trade instead of returning to normal.
Earlier acceptance tests always picked the seeded side/barrier; they never
exercised this mismatch.

There were additional recovery discrepancies:

- Stake sizing ran at settlement, before the next selected contract's payout
  was known. Updating the payout during the next scan did not re-size the stake.
- The builder's numeric-field validator rejected a literal `1e-9`, silently
  replacing the rounding epsilon with zero. For example, binary floating-point
  arithmetic could turn an exact **0.55** stake into **0.56** after `ceil`.
- Rounding up after clamping could exceed a fractional maximum stake; applying
  the 0.35 floor after a balance cap could exceed an insufficient balance.
- The patience escape hatch also bypassed recovery confirmation.

## Corrected execution handoff

Generated XML now uses two additional NeuroTrade builder blocks:

1. **`nt_prepare_digit_trade`** validates the decision's mode, market, side,
   barrier and engine scope. It requests a fresh **$1 proposal for that exact
   tuple**, rechecks the gate at the live payout, and returns the total-return
   multiplier. Failed/malformed/timed-out quotes return zero to hold. Fresh
   payouts feed back into ranking for that candidate for up to 60 seconds.
2. The workspace calculates its recovery stake **after** receiving that payout.
3. **`nt_purchase_digit_trade`** consumes the preparation once, verifies the
   same tuple and current limits again, requests a proposal at the calculated
   stake, and buys **that proposal id**. It never selects a cached startup
   proposal, even if stock payout/proposal blocks are present.

Preparation expires after ten seconds. A new analysis, market/mode change,
trade cycle or stop invalidates it. Quote/preparation and purchase locks prevent
concurrent buys or retargeting. Quote failures hold and re-scan; buy errors are
not swallowed or automatically replayed. Generated workspaces disable
restart-on-error, so an ambiguous buy error stops for account reconciliation
rather than risking a duplicate trade or resetting the ledger. No real account
trades are needed to run the regression tests.

A failed market switch cannot buy the selected side on the old market. The XML
logs a switch **request**; the engine logs whether it succeeded. Entry messages
report the executed market, side, digit and stake, rather than the seed pair.

## Recovery parity with the app's AI bots

The policy is the existing **bot-specific debt markup** policy, not the main
engine's separate Auto/Manual or Split/Instant target-profit settings:

```text
raw stake = outstanding debt × (1 + botRecoveryMarkup / 100)
            / (selected live total-return payout − 1)

stake = ceil-to-cents(max(0.35, raw stake))
stake = min(stake, floor-to-cents(maxTradeStake), floor-to-cents(balance))
if stake < 0.35, or a hard limit is unavailable: do not buy
```

Markup and max stake are copied from the user's saved settings at forge time.
This reproduces `calculateBotRecoveryStake` + `applyRecoveryStakeLimits` /
`getBotRecoveryStake` for executable stakes. The final execution guard additionally
refuses insufficient/invalid balances instead of forcing the minimum through a
hard limit. The rounding epsilon is emitted as **1 / 1,000,000,000**, so it survives
loading into real Deriv Blockly.

Settlement alone updates the workspace ledger, at integer-cent precision:

- A normal loss enters recovery at step 1 and records the actual lost stake.
- Further losses add the actual lost stakes to debt.
- Recovery wins subtract **actual net profit**, not total payout or the stake.
- Partial wins keep recovery active for the remaining debt.
- Recovery ends as soon as all loss debt is repaid. The next scan is normal,
  at the base stake, behind the normal gate.
- `maxRecoverySteps` caps the step **counter**, just as in the app. It does not
  discard unpaid debt. TP, SL and the consecutive-loss circuit breaker stop
  the run independently.

At the canonical 2.43× recovery payout, base stake 0.50 and 10% markup:

```text
0.50 normal loss → debt 0.50
recovery stake ceil(0.50 × 1.10 / 1.43) = 0.39
0.39 loss → debt 0.89
recovery stake ceil(0.89 × 1.10 / 1.43) = 0.69
0.69 win → actual net profit 0.99 → debt cleared
next normal trade = 0.50
```

## Regression coverage

- `api-server/src/lib/digit-forge-dbot.test.ts`: generator/runtime allowlist
  parity for all side/digit pairs; live quote → sizing → purchase order;
  unconditional Trade Definition; XML structure, variables and saved fixtures.
- `dbot-builder/src/preview/__tests__/digit-forge-strategy.spec.js`: real Blockly
  load/compile/execute, including the originally failing Under 2/Under 5 cases,
  all six legal pairs across changing markets, changing live payouts, exact-cent
  rounding, partial wins, fractional caps, depleted balance, step-cap debt
  retention, failed switches and recovery patience. Every scripted buy checks
  mode and stake against the **actual app recovery-math functions**.
- `dbot-builder/src/external/bot-skeleton/services/tradeEngine/trade/__tests__/digit-forge-execution.spec.js`:
  real scanner/purchase mixins against a mocked Deriv transport; exact proposal
  requests and purchased ids, exhaustive rejection of forbidden pairs, stale
  proposal protection, quote errors/timeouts, mode/market changes, concurrent
  calls, stops and live-payout gates.

```bash
corepack pnpm --filter @workspace/api-server test
cd artifacts/dbot-builder
npm ci --no-audit --no-fund
npx jest src/preview/__tests__/ src/external/bot-skeleton/services/tradeEngine/trade/__tests__/ --runInBand --coverage=false
```

## Deployment and existing XML

Deploy the **API and rebuilt web/builder bundle together**. Saved/exported XML
contains the old execution blocks and is not rewritten automatically: stop the
old DBot and use **Create DBot** again after deployment, then verify it on a
Deriv demo account before using real funds. The new adaptive XML requires the
updated NeuroTrade builder, not the unmodified app.deriv.com builder.

These changes enforce execution and recovery correctness, not profitability.
Digit contracts remain risky and a recovery ladder can exhaust the configured
limits; statistical gates cannot guarantee an edge or recovery of losses.
