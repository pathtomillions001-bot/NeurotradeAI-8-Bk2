# Over/Under Turbo

`BOT-OU-TURBO` / bot id `overunder-turbo` / console contract `overunder-turbo@2`.

The continuous-fire Over/Under specialist: a dedicated engine, not a preset of
the specialist engine or of the Over/Under Navigator. All analysis happens ONCE,
before the first trade; after arming the session fires back-to-back with **no
mid-session re-analysis, no gating and no re-scanning**, until take-profit or
stop-loss.

## Why a third over/under bot

- The **Over/Under Navigator** re-fits a policy and gates EVERY trade behind a
  pacing valve — it waits for fair setups. That is the opposite cadence.
- The **Dual-Lock Range Sentinel** already trades non-stop, but it has no
  switching mode at all and no arm-once entry phase.
- **Turbo** sits between them: Dual-Lock's continuous cadence + a market-only
  switching rescue + an arm-once best-entry start, under its own identity,
  console and routes.

## User flow

1. **Scan once** — `POST /api/bots/overunder-turbo/scan` crawls every digit
   market × the fixed barrier sets (below) and returns the single best
   (market, normal, recovery) triple ranked by simulated survival, with a
   named blocker when nothing is deployable (the console then waits and
   re-scans — the bot never deploys into a bad tape).
2. **Deploy with one of two buttons:**
   - **Locked** — the scanned market is frozen for the whole session.
   - **Switching** — same market and barriers, but the engine leaves the market
     ONLY when it turns measurably unfavorable (see below). The barriers never
     change; switching re-chooses WHERE to fire, never WHAT.
3. **Arm once** — the engine waits for the locked normal contract to be at/above
   its break-even rate over the live 40-tick window (30 s arm timeout as a
   safety valve), then starts the uninterrupted run.
4. **Non-stop to TP/SL** — normal contract while the shared recovery ledger says
   "no debt", recovery contract while it says "debt". One 1-tick contract
   settles straight into the next (short settle pauses: 120 ms after a win,
   200 ms after a loss). Wins and losses are traded alike.

## Fixed barrier sets (sovereignty-enforced)

- Normal: **Over 1, Over 2, Under 7, Under 8**
- Recovery: **Over 4, Over 5, Under 4, Under 5**

Checked immediately before every buy (`isNormalContract` / `isRecoveryContract`
in `overunder-turbo-analysis.ts`); a violation halts the session instead of
firing. Orders are always 1 tick (`1t`).

## Pre-deploy mathematics (reused, not re-implemented)

`overunder-turbo-analysis.ts` re-exports the proven survival stack from
`dual-lock-analysis.ts` so the two continuous over/under bots can never silently
diverge:

- conservative (5 %) Beta lower-confidence bounds on an
  autocorrelation-corrected effective sample size;
- loss-clustering Markov chain, ξ = P(loss|loss)/P(loss);
- the CONDITIONAL recovery estimand
  P(recovery wins | last digit ∈ normal-loss set) — recovery is a conditional
  bet, not a marginal one;
- χ² block-homogeneity stationarity test;
- stationary block-bootstrap session replay of the REAL engine rules
  (normal stake → debt-driven recovery stake → TP/SL) → P(TP before SL);
- Benjamini–Hochberg FDR screen across every scanned triple.

## Switching rescue (market-only)

Every 12 s the engine runs a cheap favorability health check on the active
market for the locked normal contract (worst-case rate vs break-even, ξ ≤ 1.08,
|stationarity z| ≤ 3). Two consecutive unfavorable reads trigger a cross-market
re-score for the SAME (normal, recovery) pair; the bot moves only when a
deployable challenger beats the active market by ≥ 4 score points, with a 45 s
anti-flap cooldown. A healthy market is NEVER interrupted for scanning.

## Inherited section non-negotiables

- ONE shared recovery ledger (`lib/agents/recovery-engine.ts`) — recovery works
  exactly like every other bot, including the debt-driven stake formula
  (`getBotRecoveryStake`) and the user's recovery markup.
- ONE executing engine per account: `runningOtherEngines` +
  `acquireTradingOwnership("bots", ownerSessionId)` (explicitly session-keyed).
- ONE engine state per account session (`createSessionScoped`) — two connected
  Deriv accounts can run Turbo concurrently; start/stop/status never cross
  accounts (pinned by `overunder-turbo-engine.test.ts`).
- Live-registry registration so the running bot is visible/stoppable from any
  page; SSE `bot_update` + `bot_scan_progress` broadcasts are owner-scoped.
- Circuit breaker: a realised loss run deeper than the pre-deploy bootstrap p95
  (+2) halts the session — the live market left the regime the lock was
  justified on, and with no mid-session analysis allowed, halting is honest.
- Paper mode settles against the market's REAL next digit (no synthetic
  coin-flip), matching Dual-Lock.

## Create DBot (Deriv Bot executes the lock)

Next to **Locked** / **Switching** the scan result offers **Create DBot**. It
does NOT start the Turbo engine. Instead:

1. `POST /api/bots/overunder-turbo/dbot` (same body and validation as `/start`)
   renders a stock Deriv-Bot Blockly strategy for the scanned triple —
   `overunder-turbo-dbot.ts` — quoting the payout multipliers the engine itself
   would use (`resolveRecoveryPayout`) and reading the account's recovery markup
   / max stake from settings.
2. The web app posts the XML into the embedded Deriv bot builder
   (`NEUROTRADE_BOT_BUILDER_LOAD_STRATEGY`, `lib/bot-builder-frame.ts`), opens the
   Bot Builder page and waits for the builder's acknowledgement
   (`NEUROTRADE_BOT_BUILDER_STRATEGY_LOADED`). The builder side is
   `artifacts/dbot-builder/src/preview/strategy-bridge.ts`, which loads the XML
   through Deriv's own `load()` — no patches to Deriv's builder.
3. The user verifies the blocks and presses Deriv's **Run**. From then on Deriv
   Bot executes the trades, not NeuroTrade.

The generated bot is the Turbo engine's **LOCKED** mode, block for block:

- market fixed to the scanned symbol, 1-tick Over/Under, contract type "both";
- **arm once** — purchase conditions wait until the normal contract hits ≥ its
  break-even (1 / payout) over the last 40 digits, or 30 evaluations elapse;
- normal contract while there is no debt, recovery contract while there is;
- recovery stake = debt × (1 + markup %) / (payout − 1), floored at 0.35,
  capped at max trade stake and live balance, rounded UP to cents — identical to
  `getBotRecoveryStake`; a recovery win pays its net profit into the debt and
  recovery ends the moment debt is zero (partial wins keep it open);
- circuit breaker at `round(p95 recovery depth) + 2` consecutive losses;
- take-profit / stop-loss on Deriv's total-profit counter.

Switching mode cannot be expressed in a DBot (Deriv fixes the market in the trade
definition), so **Create DBot always produces a locked bot**.

Only stock builder blocks are used (`TURBO_DBOT_BLOCK_TYPES`). The builder's jest
suite (`src/preview/__tests__/turbo-dbot-strategy.spec.js`) loads the committed
fixtures into the REAL Deriv Blockly with every block definition, generates code
the way `dbot.generateCode()` does and executes it against a scripted market to
pin the ladder (1.00 → 1.16 → 2.51 → back to base), TP, SL, breaker and partial
recovery. `overunder-turbo-dbot.test.ts` keeps those fixtures in sync with the
generator (`npx tsx src/lib/overunder-turbo-dbot.fixtures.ts --write`).

## Files

- `artifacts/api-server/src/lib/overunder-turbo-analysis.ts` — fixed vocabulary, scan ranking, arm-entry read, market health.
- `artifacts/api-server/src/lib/overunder-turbo-engine.ts` — continuous execution engine.
- `artifacts/api-server/src/routes/overunder-turbo.ts` — scan/start/stop/status/contracts/dbot routes (mounted at `/api/bots/overunder-turbo`).
- `artifacts/api-server/src/lib/overunder-turbo-dbot.ts` — Deriv-Bot (Blockly XML) strategy generator for "Create DBot".
- `artifacts/dbot-builder/src/preview/strategy-bridge.ts` — builder-side listener that loads a host strategy through Deriv's `load()`.
- `artifacts/trading-platform/src/components/overunder-turbo-console.tsx` — the tailored console (scan → lock proposal → Locked/Switching/Create DBot buttons → live turbo monitor with switch board).
- `artifacts/trading-platform/src/lib/bot-builder-frame.ts` — singleton builder iframe + `loadStrategyIntoBotBuilder` handshake.
- Tests: `overunder-turbo-analysis.test.ts`, `overunder-turbo-engine.test.ts`, `overunder-turbo-dbot.test.ts`, builder `turbo-dbot-strategy.spec.js`.
