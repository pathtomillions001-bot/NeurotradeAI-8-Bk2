# Accumulator Edge Navigator — research and implementation notes

> This is a risk-control and measurement design, not a claim of profitability. A Deriv Accumulator can lose its entire initial stake when its dynamic range is breached. The implementation refuses to trade when the measured lower-bound economics do not clear the compounded break-even line, and it is intended to be exercised in paper mode before any live account is enabled.

## Product facts verified against Deriv material

The implementation was designed from the following official references:

- [Deriv Developer Platform — Accumulator options](https://developers.deriv.com/docs/accumulator-options)
- [Deriv Traders Academy — Beginner's guide to Accumulator options](https://traders-academy.deriv.com/trading-guides/beginners-guide-to-accumulator-options)
- [Deriv Accumulators ebook](https://docs.deriv.com/marketing/2025/ebook-accumulators-en-hq.pdf)
- [Deriv trading terms](https://deriv.com/terms-and-conditions/trading-terms)
- [Deriv product explanation](https://deriv.com/blog/posts/introducing-accumulators-options-on-deriv-bot/)

The API flow is: discover the active underlying; query `contracts_for`; request an `ACCU` proposal with a supported `growth_rate` and optional `limit_order.take_profit`; buy; monitor the open contract; and sell early or allow settlement. The documented growth choices are 1%, 2%, 3%, 4%, and 5%. Growth is fixed after entry. The value compounds tick by tick while the price remains in the dynamic range. A range breach makes the contract worthless and loses the original stake. A manual sell locks the current value; an exchange-side take-profit is available.

The sources describe short-duration contracts in the rough 45–230 tick range, but examples and product surfaces have not always agreed on the exact ceiling. The service therefore treats `contracts_for`/proposal responses as authoritative and clamps the user input at runtime. The UI default is 60 contract ticks with an 8-tick early-close target; those are risk defaults, not broker promises.

Aggregate stake limits can disable the same underlying/growth-rate combination even when the product is otherwise available. A live quote rejection is therefore a normal broker condition, not evidence that the model is wrong. The engine stops or switches rather than retrying an unavailable combination indefinitely.

## The distinct economics

Let `g` be the decimal growth rate and `T` be the early-close target in ticks. Ignoring fees and quote slippage, the contract's gross value after surviving `T` ticks is:

```
G(T) = (1 + g)^T
net win per initial stake = G(T) - 1
net loss after knockout = -1
E[net return] = p_survive * G(T) - 1
break-even survival = 1 / G(T)
```

This is why a digit-bot payout multiplier cannot be reused. A 1% contract held for 8 ticks has `G = 1.0829` and needs survival above about 92.34% before costs. A longer hold can make the nominal reward larger, but it also exposes more ticks to a range breach. The scan displays both the compounded factor and the survival threshold instead of hiding the trade-off behind a win-rate label.

Early close is treated as a partial recovery outcome. If the exchange returns a current value `V`, the ledger receives `V - stake`, not a binary “won” amount. A knockout records `-stake`, even if the accumulated unrealised value was previously positive. Take-profit and stop-loss are session-level boundaries and do not override the full-stake knockout accounting.

## Barrier and tick-duration treatment

The barrier is dynamic and recalculated from the prior tick; it is not safe to hard-code a static price line. The scanner uses a clearly labelled screening estimate only until a broker response supplies a barrier or a proposal reveals the effective contract terms. `src/lib/deriv.ts` contains `discoverAccumulatorContractSpec`, which uses the pooled account request when credentials are available and otherwise the public market socket. Broker values win over the fallback estimate.

The engine has two separate clocks:

1. **Contract duration** — the maximum broker contract horizon sent to the `ACCU` proposal.
2. **Target ticks** — the shorter local/exchange take-profit horizon used to lock compounded value before the maximum horizon.

A feed that is stale, missing, or has a recent move close to the measured barrier is not traded. The local early-close monitor is deliberately redundant with Deriv's `limit_order.take_profit`: a broker-side close may race the local `sell`, so sell requests are pooled and idempotent and the final result is reconciled through the open-contract/result path.

## Statistical model

For every market and permitted growth rate, the scan computes log returns and:

- robust sample and recent return volatility;
- an estimated barrier in return standard deviations;
- one-tick knockout hazard with a Wilson upper bound;
- a two-state Markov read: safe-to-safe persistence and knockout probability after a recent shock;
- calm/mixed/hot volatility regime classification;
- block bootstrap survival over the selected target horizon, with block length related to return autocorrelation;
- effective sample size adjusted for first-lag dependence;
- the maximum and 95th-percentile safe run observed in bootstrap paths.

The block bootstrap is not a proof that future ticks are exchangeable. It is a transparent stress test that preserves a small amount of serial dependence and makes uncertainty visible. The deploy gate requires enough samples, a positive conservative lower-bound expected return, a survival margin above break-even, no hot regime, and no elevated recent-shock Markov hazard. A high point estimate with a weak lower bound is held, not traded.

The market score ranks edge margin, survival margin, hazard, regime, and Markov stability. It is a ranking tool, not a guarantee. In switching mode, the engine re-evaluates scanned alternatives from fresh ticks and rotates only when a different measured candidate has a meaningful lower-bound advantage. In locked mode it holds the analysed market and pauses entries when conditions deteriorate.

## Recovery mathematics

Recovery is account-global, but ACCU sizing is contract-specific. If the shared ledger has debt `D`, broker/account caps allow `C`, the configured markup is `a`, and the selected contract's compounded net return is `R = G(T) - 1`, the ideal stake to attack the debt is:

```
S_ideal = D * (1 + a) / R
S_used = min(S_ideal, account_balance * 10%, max_trade_stake)
```

The implementation also respects the broker minimum stake. If the economics require a stake beyond the cap, the engine does not pretend the recovery is covered; it stops at the recovery breaker. Each outcome calls the shared `recordOutcome` ledger with the actual net profit. A partial early close reduces debt by only the amount actually realised. A knockout adds the complete stake loss. Consecutive recovery failures trip the configured step breaker, and session stop-loss remains active throughout.

This is not a martingale claim. The cap, full-stake knockout, aggregate stake restrictions, and possible regime shift are exactly why the bot can stop with debt rather than escalate without limit.

## Execution and safety rules

- One trading owner per account is enforced through the existing arbiter and one shared recovery ledger.
- ACCU proposals carry `contract_type: "ACCU"`, `growth_rate`, contract duration, and `limit_order.take_profit`.
- Open-contract status and sell requests reuse the pooled authenticated Deriv socket; no per-tick OTP socket is created.
- The paper path uses observed price ticks and can record an early close or full-stake knockout; it does not toss a synthetic win coin.
- Switching rotates markets, never growth mechanics inside an open contract.
- A scan must be completed and its deployable candidate is sent back to the server; the server revalidates the candidate and never accepts an unmeasured ACCU start.
- No UI label says “guaranteed”, “risk-free”, or “certain”.

The full calculation code is in `artifacts/api-server/src/lib/accumulator-analysis.ts`; execution is in `artifacts/api-server/src/lib/accumulator-engine.ts`.
