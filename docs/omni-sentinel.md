# Omni Sentinel

`BOT-OMNI` / bot id `omni` / console contract `omni@2`.

A dedicated multi-contract bot, not a preset of the specialist engine. Existing specialist scoring, barriers, timing policies and recovery formulas are unchanged.

## User controls

- Independently enable **Rise, Fall, Even, Odd, Matches, Differs, Over, Under**. Any non-empty combination is valid.
- The **same allowlist** applies to normal **and** recovery trades. There is no hidden Matches → Differs fallback or recovery-side override.
- The bot chooses digits and barriers itself: Matches/Differs 0–9, Over 0–8, Under 1–9. With all contracts enabled there are **42 candidates per market**. Orders are one tick long.
- Choose **Trade Locked** or **Smart Switching** only **after the market scan**. Setup contains only contract and risk controls.
- **Switching:** continuously compare all markets in `AUTOMATED_DERIV_MARKETS`, even when the current market already has a positive opportunity. Both normal and recovery can change market and contract.
- **Locked:** choose one measured market after the scan. Both phases stay there, but can change between enabled contracts/digits/barriers.
- Base stake, session stop loss and take profit. Execution uses the connected Deriv account (demo or real); there is no user-facing paper mode.
- Existing Settings supply maximum trade stake and bot recovery markup. No multiplier ladder or loss-count-dependent entry control is added.

“All markets” means the app's existing **19 automated synthetic markets**, not every market offered by Deriv. The app's manual-only exclusion (`JD100`) is preserved. This change does not add Forex, commodities, accumulators, or other unsupported markets/contracts. Broker proposals remain authoritative for current contract availability.

## Probability model and timing

`omni-analysis.ts` contains a pure causal model; it does not import network or database code.

Two categorical ensembles predict next digit (10 outcomes) and next price direction (down / unchanged / up). Each mixes:

1. A fair/reference prior.
2. A slow exponentially weighted marginal (600-tick half-life).
3. A fast marginal (80-tick half-life), shrunk toward the slow marginal.
4. Order-1 Markov counts, with hierarchical backoff.
5. Order-2 Markov counts, with stronger backoff to order 1.

Expert weights are updated by **prequential log loss**: predict first, observe the next outcome second. Counts decay, so current evidence can replace stale structure. Flat price ticks lose for both CALL and PUT.

Each contract gets a shrunk past forecast-residual correction, a smooth search-breadth shrinkage toward its combinatorial prior, a model uncertainty estimate, and a smoothed empirical `q_LL = P(candidate loses next | candidate just lost)` from the tape. The search penalty is continuous, not a multiple-testing pass/fail gate. It is **not** a formal guarantee against selection bias. Uncertainty is a scoring input, **not** a certified probability confidence interval.

### One fixed opportunity rule

For estimated win probability `p`, total-return payout multiple `r`, stake `s`, available balance `B`, and `f = s/B`:

```text
EV per unit stake = p*r - 1
pairRisk          = (1-p) * q_LL
logReturn         = [p*ln(1 + f*(r-1)) + (1-p)*ln(1-f)] / f
baseUtility       = logReturn - 0.25*r*uncertainty - rho*pairRisk

normalUtility     = baseUtility                         (rho = 0.03)
recoveryUtility   = baseUtility * p * debtCoverage       (rho = 0.15)
debtCoverage      = min(1, s*(r-1)/outstandingDebt)
```

The candidate with the highest **positive** utility wins. Otherwise wait.

The entry utility floor is **always zero**. The selector has no recovery-step, loss-run, loss-count, progressively longer cooldown, or post-loss threshold argument. Recovery's objective values the chance and extent of paying debt and prices repeated-loss exposure. Its coefficients are fixed; they do not tighten after a loss.

A larger debt may require a larger stake and therefore change expected log-return, affordability and ranking. That is exposure math, not a ratcheting entry threshold. Minimum history, valid quotes, fresh live ticks, account ownership and funding limits remain non-negotiable operational safeguards.

`pairRisk` is a **same-contract tape estimate**, not the probability that the next two executed bot trades lose: the bot can change contract and market between trades. There is no claim that this is the mathematically optimal strategy or that the estimates predict an exploitable edge in otherwise random markets.

## Recovery and money

Live mode uses the existing account-scoped recovery state and its pure `reduceRecoveryOutcome` transition. There is no second live debt ledger.

Candidate stakes use the existing `calculateBotRecoveryStake` policy:

```text
requested = debt * (1 + botRecoveryMarkup/100) / (livePayout - 1)
```

Requests round upward to cents, but **never above** the downward-rounded minimum of:

- maximum trade stake;
- actual available balance;
- remaining session loss budget (`stopLoss + sessionPnL`).

Zero or sub-minimum balance is **not** interpreted as unlimited. An unaffordable normal base stake is not silently increased. The broker minimum remains 0.35. A capped recovery win may pay only part of the debt; the rest carries forward. Recovery ends as soon as mandatory loss debt is cleared, not when an optional target-profit remainder reaches zero.

Public scan/start endpoints reject paper execution and require the connected account. They never silently fall back to virtual funds. The internal isolated-paper runner is retained solely for deterministic engine regression tests; it is not exposed by the console or deployment API. Existing global account paper-trade safeguards are respected rather than overridden.

## Execution integrity

- Browser/account session-scoped state through the existing AsyncLocalStorage infrastructure. The existing arbiter, engine registry, live indicator and owner-scoped SSE are used.
- One outstanding order per bot. A second start is rejected even while the first start awaits database/broker operations.
- Scan results and fitted models stay on the server. Start requires the owner's unexpired scan id, the same contract/risk/execution settings, and a market actually measured by that scan. Market lock/switch is intentionally chosen after the scan and is the only configuration field excluded from its fingerprint; every scan fits the same all-market models. No client-provided probability, payout or fitted parameter is trusted.
- Monotonic `DigitTape` sequence + generation + source identify observations. Identical prices/digits and full ring buffers still advance the model and paper settlement. Source changes/gaps rebuild the model rather than splice simulated and real data.
- Broker history merges by **epoch and price**, preserving repeated values and rejecting conflicts.
- Indicative payout tables can rank unpriced candidates, but **never authorize a live buy**. The leading estimated candidate is quoted on its pinned account socket; quotes are cached for ranking for 30 seconds. A changed quote reranks the field. The stake is re-quoted if payout changes alter recovery sizing. This is a quote-aware estimated tournament, not a claim that every possible order is simultaneously priced at the broker.
- Fresh balance and settings checks precede a durable journal insert. The actual buy's `beforeSend` hook rechecks authorization, Stop, allowlist, market lock, debt snapshot, exact tick identity and fixed tick-window headroom **after** socket queue/throttle waits.
- No loss is fabricated on timeout. A missing buy acknowledgement becomes **reconciling**, never an automatic repeat buy. Reconciliation accepts only a uniquely identified broker record; absent identity/barrier/price fields are not wildcards.
- Once purchased, only the broker's final settlement updates live money. Trade settlement and shared recovery JSON commit in one transaction. An `accounted` marker makes retries idempotent; the in-memory shared state is seeded only after commit.
- Stop cancels unsent orders and holds the execution lease until a sent purchase settles. It does not abandon an outstanding purchase or allow another engine to trade over an uncertain balance.
- Omni journal rows are excluded from the older display-only fuzzy reconciler. On the next **explicit live deployment**, unaccounted durable Omni intents for the pinned account are reconciled before any new order. Sessions are not automatically resumed on server restart.

If a lost acknowledgement cannot be matched safely (for example, the broker omits required identifying fields), the bot deliberately remains in reconciliation and sends no more trades. Inspect the connected account's broker journal; do not clear the intent or manufacture an outcome to force trading to resume. Resolving incomplete broker metadata can require operator investigation. This is a transport-safety hold, not a recovery loss gate.

## Console and diagnostics

The dedicated console uses the standard 336px, bottom-right bot panel with compact cards, responsive viewport limits and no wide tables. The heading and close control remain fixed above a separately scrollable, keyboard-focusable body with a visible scrollbar. Reopening the console or changing screens resets the body to the top. Navigator uses the same scrolling layout. A `vh` fallback keeps the height bounded on browsers without dynamic viewport-unit support. Setup contains eight contract toggles and risk inputs. After scanning, the user selects a market, acknowledges account-trading risk and explicitly chooses the full-width **Trade Locked** or **Smart Switching** action. Normal/recovery preview tabs and expandable diagnostics avoid a tall stack of panels. Running sessions show a compact opportunity radar and safe Stop state. No execution-mode or market-freedom controls are duplicated in setup.

A scan warms the causal model on the first 60% of up to 2,400 ticks, then evaluates the same **single-market** selection rule chronologically on the last 40%, updating only from earlier outcomes. It reports normal/recovery wins and shots, consecutive recovery loss pairs, replay P&L, remaining debt, and risk-budget exhaustion. It is **not** a backtest of cross-market switching. It uses indicative payouts and ideal next-observed-tick fills, not historical executable quotes or broker latency. Comparing many replay cards introduces selection bias. Simulated feeds are prominently labelled and cannot authorize live deployment.

Recovery can increase exposure and produce additional losses. Neither a high estimated win rate, positive utility nor a good replay guarantees recovery or profit. Validate with a connected Deriv demo account before considering real-money use.

## API

Mounted before the generic specialist routes:

- `POST /api/bots/omni/scan` — strict connected-account `OmniConfig` body.
- `POST /api/bots/omni/start` — `{ config, scanId, symbol, acknowledgeLiveRisk? }`; connected-account deployment requires explicit acknowledgement.
- `GET /api/bots/omni/status` — the current browser/account session only.
- `POST /api/bots/omni/stop` — request drain/stop; `running` remains true during unresolved settlement.

`OmniConfig`:

```json
{
  "enabledContracts": ["DIGITOVER", "DIGITUNDER", "DIGITMATCH"],
  "stake": 1,
  "stopLoss": 10,
  "takeProfit": 10,
  "marketMode": "switching",
  "executionMode": "live"
}
```

Unknown keys, empty/duplicate/unsupported selections, non-finite amounts, fractional-cent stakes, paper execution, invalid modes and risk-inconsistent configurations are rejected. A fresh scan remains valid when choosing only lock/switch afterward; changing contracts, stake, stop loss or take profit still requires a new scan. Both generic catalogue/status and the global live registry include Omni; the web/API release handshake publishes `omni@2`.

## Validation

- `omni-analysis.test.ts`: 42-contract enumeration, subset sovereignty, payoff semantics, causal prefix forecasts, complementary probabilities, ties, fair-rate negative EV, replay, fixed recovery rules, market switching/locking and funding caps.
- `omni-execution.test.ts`: live repricing, actual-stake re-quoting, stop/queue races, journaling failure, lost buy acknowledgements, strict reconciliation matching, tick identity and provenance.
- `omni-engine.test.ts`: trusted scan binding, account isolation, concurrent starts, shared execution lease, real paper loss → recovery transitions, shared-live-debt isolation, same-price next ticks, stop draining, stop-loss preservation and ambiguous database-commit retries.
- Web tests cover all contract controls, validation, dedicated-console handshake and global open/stop paths.
- Browser smoke checks cover compact desktop/mobile sizing, subset selection, post-scan lock/switch actions, risk acknowledgement, account-only request payloads and all three shortened specialist button labels. Broker start responses are mocked; no live-money orders are placed during UI validation.

The repository also has existing session/authentication failures in `session-isolation.test.ts` and existing API TypeScript errors in `routes/auth.ts` (`isTabSession` / `clientId`). Those files are unchanged by this feature. Review those separately before a production live-trading rollout; a passing feature suite is not a clean bill of health for the entire app.
