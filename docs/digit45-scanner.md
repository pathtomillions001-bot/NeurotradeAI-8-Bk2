# Digit 4/5 scanner → paired DBot

`/scanners/digit-45` is **a scanner, not an execution engine**. Scanning and clicking **Create DBot** make no orders. The latter loads editable Blockly XML in the embedded Bot Builder; trading requires a connected account and a separate **Run** click there.

## Qualification

- Only a current Deriv **live** tick tape is eligible. Simulated prices, missing/stale broker timestamps, source/generation changes and inconsistent broker history cannot qualify a market. Short live tapes may be supplemented with verified `ticks_history` from the same symbol.
- Examine up to 600 digits; require at least 300. Require one-sided 95% Wilson upper bounds **below 10% for digit 4 and digit 5 individually**, a combined upper bound below 20%, and fewer than 20% 4/5 hits in the latest 100. Discount clustered observations. These are *historical measurements*, not predictions or guaranteed edge.
- A result is session-bound, expires after 90 seconds, and is **re-evaluated with any new broker ticks** when Create DBot is pressed. If the market is no longer suitable, scan again. No trade endpoint is exposed by this scanner.

## Generated strategy

The XML uses the builder's paired-purchase and paired-result Blockly blocks (ordinary `purchase` only places one order per cycle). The pair engine submits **two concurrent buy requests** on the same authorized account socket. Each contract has its own 1-tick proposal, buy ID, settlement, and accounting:

| Mode | First contract | Second contract | Transition |
| --- | --- | --- | --- |
| Normal | Digit Over **4** | Digit Under **5** | If *combined net pair P/L* is negative, begin recovery. |
| Recovery | Digit Over **5** | Digit Under **4** | Continue until combined debt is cleared, or a safety limit stops the strategy. |

The strategy binds the scanned market and expected **account currency**; changing accounts/currencies requires a new DBot. Supported account currencies are USD, EUR, GBP and AUD (two decimal places). In recovery, if one of two equal-stake legs wins with total return multiplier `p`, the *pair* net is `stake × (p − 2)`, **not** `stake × (p − 1)`. With $2 of debt after *both* $1 legs lose, 10% markup and 2.43× payouts, the calculated recovery stake is **$5.12 per leg** ($10.24 total exposure). Actual rounded final proposals, balance, per-leg stake cap, and worst-case **two-leg** session stop loss are checked before either buy; an inadequate quote stops instead of guessing.

Recovery attempts are bounded. A partial or uncertain buy is **never retried automatically**: the engine tracks any confirmed contract, waits for settlement, then stops; after an ambiguous response/timeout it locks further Run attempts until the user reconciles the broker account and reloads the builder. Stop waits for both accepted contracts to settle (with a 45-second UI watchdog; unresolved exposure remains locked). TP and SL apply to combined pair P/L in this strategy session.

**Important:** Two broker orders are *not atomic*. They can fill and settle on different ticks, so both can lose or both can win; there is no same-tick guarantee or guaranteed profit. Use a demo account to check live availability and execution before considering real funds. Automated tests exercise broker-protocol stubs, XML loading, and generated code, **not a live Deriv trade**.

## Verification

```sh
corepack pnpm --filter @workspace/api-server test
npm --prefix artifacts/dbot-builder run test -- --runInBand --coverage=false
corepack pnpm --filter @workspace/trading-platform test
corepack pnpm --filter @workspace/trading-platform run build
```

The API generator for the builder test fixtures is `artifacts/api-server/src/lib/digit45-dbot.fixtures.ts`; to refresh the fixtures deliberately, run `corepack pnpm --filter @workspace/api-server exec tsx src/lib/digit45-dbot.fixtures.ts --write`.
