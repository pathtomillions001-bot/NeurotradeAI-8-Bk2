# NeuroTrade — AI-Powered Trading Platform

AI-driven trading platform connected to Deriv's WebSocket API with 8-agent autonomous trading engine, real-time market scanning, and intelligent risk management.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080 → proxied at /api)
- `pnpm --filter @workspace/trading-platform run dev` — run the frontend (port 5000 → proxied at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Replit setup: the checked-in `.replit` configuration provisions the `postgresql-16` module, which supplies the development database environment used by the API server.
- Required env: `DERIV_APP_ID` — alphanumeric Deriv app ID from app.deriv.com/apps (e.g. `33TQEuMW21nTbCZ7Hfb0q`). Also used as the OAuth2 `client_id`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + TailwindCSS + Framer Motion + Recharts
- API: Express 5 (at `/api`)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Deriv public WS: `wss://api.derivws.com/trading/v1/options/ws/public` (no auth — ticks, symbols, proposals)
- Deriv trading WS: OTP URL from `POST https://api.derivws.com/trading/v1/options/accounts/{id}/otp`
- Deriv auth: OAuth2 + PKCE via `https://auth.deriv.com/oauth2/auth`

## Where things live

- `lib/api-spec/openapi.yaml` — Single source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle ORM schema (accounts, trades, settings, ai_insights)
- `artifacts/api-server/src/routes/` — Express route handlers (auth, markets, trades, analytics, ai, settings)
- `artifacts/api-server/src/lib/ai-engine.ts` — 8-agent AI scoring system
- `artifacts/api-server/src/lib/speed-ai-engine.ts` — NeuroAI Quantum FAB engine (six-family generalist)
- `artifacts/api-server/src/lib/bot-catalog.ts` — the five specialist bot definitions
- `artifacts/api-server/src/lib/bot-scorer.ts` — bot scorer: FAB formulas copied verbatim + specialist layer wired in
- `artifacts/api-server/src/lib/specialist-analysis.ts` — the specialist statistical layer (single-contract advantage + break-even entry gates)
- `artifacts/api-server/src/lib/bot-calibration.ts` — per-family Platt-calibration self-learning (fits from the bot's own journaled trades)
- `artifacts/api-server/src/lib/bot-edge-upgrade.test.ts` — backtest harness: gates must filter on fair streams and release winning trades on planted-edge streams
- `artifacts/api-server/src/lib/bot-engine.ts` — specialist bot session/scan/execution loop
- `artifacts/api-server/src/lib/dual-lock-analysis.ts` — 6th bot: the pre-deploy lock search (loss-clustering Markov, conditional recovery transition, χ² stationarity, block-bootstrap survival, BH-FDR)
- `artifacts/api-server/src/lib/dual-lock-engine.ts` — 6th bot: frozen-pair continuous execution loop + circuit breaker
- `artifacts/trading-platform/src/components/dual-lock-console.tsx` — 6th bot console (scan once → lock → monitor)
- `artifacts/api-server/src/lib/killshot-analysis.ts` — 7th bot: the Kill-Shot stack (five-expert hedge ensemble, Platt calibration, train/test walk-forward of the entry rule itself, anytime-valid e-value on the SHOTS, exact Markov-chain-imbedded ladder ruin, closed-form ladder depth + mean time to break, post-loss shield simulation, Page–Hinkley, stationarity, concordance, BH-FDR)
- `artifacts/api-server/src/lib/killshot-timing.ts` — 7th bot: the entry-timing layer (momentum, Markov state preference, renewal clock, feed freshness, shot spacing, patience valve)
- `artifacts/api-server/src/lib/killshot-engine.ts` — 7th bot: measure once → lock the market → wait → fire, with a health guard that raises RESCAN REQUIRED and never rotates
- `artifacts/api-server/src/lib/killshot-analysis.test.ts` — 7th bot: causality proved by prefix replay (the live decision must reproduce the recorded shot exactly), the ladder formulas, the e-value under the null, and a guarantee that the rule always produces measurable shots
- `artifacts/trading-platform/src/components/killshot-console.tsx` — 7th bot console (contract + proof bar, the measurement card, then the four gates shown separately)
- `artifacts/api-server/src/routes/bots.ts` — `/api/bots` routes (catalogue, status, scan, start, stop)
- `artifacts/trading-platform/src/pages/bots.tsx` — AI Bot Arena page
- `artifacts/trading-platform/src/components/bot-console.tsx` — per-bot deploy console
- `artifacts/api-server/src/lib/deriv.ts` — Deriv WebSocket API client + market definitions
- `artifacts/trading-platform/src/` — React frontend (pages, components, hooks)

## Architecture decisions

- **Single recovery ledger, single executor**: Recovery is ONE account-global state (`artifacts/api-server/src/lib/agents/recovery-engine.ts`, DB-persisted). The main autonomous engine, the NeuroAI FAB session (`lib/speed-ai-engine.ts`), the specialist AI bots (`lib/bot-engine.ts`) and manual trades all record outcomes into it, so instant/split mode transitions are consistent for every engine. Exactly ONE engine may execute trades at a time — enforced by `lib/engine-arbiter.ts` (owners: `autonomous`, `neuroai`, `bots`; each loop halts if it loses ownership). Never add another private recovery ledger.
- **Specialist bots borrow, never modify, the FAB**: `lib/bot-scorer.ts` COPIES the FAB's formulas (Bayesian Markov, Shannon entropy, geometric hazard fatigue, price kinematics, green light, sniper gate) so a bot scores a market exactly as the FAB does, and `speed-ai-engine.ts` is deliberately not imported for them and not modified. Each bot then adds `lib/specialist-analysis.ts` — bounded additive estimators only a single-contract engine can afford: a 2-state parity/tail/direction Markov chain (~5× the effective samples per state of the 10-state digit matrix), a Wald–Wolfowitz runs test that says whether the stream clusters or alternates, Benjamini–Hochberg FDR across all ten digit candidates (argmax-of-ten is biased), a censored dormancy hazard from a digit's own gap history, upper-confidence-bound tail risk for Differs, and a Hurst exponent (R/S) with a lag-1..3 vector for Rise/Fall. Two places a specialist read actually decides, both named: `specialistEntryGate` (timing, layered on the FAB green light) and `specialistSideChoice` (side arbitration with hysteresis). The sniper gate uses five windows (15/30/60/100/200) where the FAB uses four.
- **One recovery formula, debt-driven**: the recovery stake is sized by `lib/recovery-math.ts` for every engine (main autonomous, NeuroAI FAB, specialist bots, manual trades). The aspirational target profit recorded on a normal loss is capped at ONE base stake (`recoveryTargetProfitFor`), so the next stake follows the DEBT, not how generous the losing contract's payout was. Without that cap a $1 loss recovered in Matches cost $0.35 in the main app (DIFF-origin target $0.09) but $1.13 in a Matches bot (match-origin target $7.93) — same formula, different inputs. Never re-derive the target from the origin payout.
- **Contract sovereignty**: a bot's `contractTypes` is used for BOTH normal and recovery trades and is enforced before every buy — a bot can never fire outside its family, and recovery can never leave it.
- **Break-even-first entries (bot v2)**: every specialist significance z is measured against the break-even `1/payout`, never against 50% — beating "fair" is not +EV at the payout. The specialist entry gate requires `z_be ≥ 0.75` for parity/momentum, a **tail-size-aware** margin for barrier (0.75σ for a ≥5-digit tail growing to 1.25σ for a 1-digit tail — rare-event estimates are noisier and more biased, see `barrierEntryMargin`), and `z_be ≥ 1.5` for match (its p̂ is the argmax of ten candidate estimates, which is selection-biased upward; the larger margin absorbs that inflation). The barrier gate additionally refuses a tail streak ≥ 4 ticks that is breaking less often than the market's own baseline (`hazardRelative < 0.7`) — no catching falling knives. The final win probability is an inverse-variance fusion of the FAB blend and the quantum window estimate, then a per-family Platt calibration fitted on the bot's OWN journaled trades (`bot-calibration.ts`, identity below 12 records, shrinkage n/(n+40)). A hard EV ≥ 0 floor with the freshest payout quote precedes every fire, the specialist gate re-runs on the execution tick, and match/differ digit targeting has hysteresis (a new digit must beat the held digit by `DIGIT_SWITCH_MARGIN` in its own significance units). `bot-edge-upgrade.test.ts` proves the gates filter on fair streams and release winning trades on planted-edge streams.
- **Survival ranks, it does not veto (Dual-Lock)**: the block-bootstrap P(TP before SL) used to be a hard 90% deployment bar and in practice admitted nothing — a synthetic index whose digits are near-uniform has a normal leg that is mildly −EV per trade by construction, so survival clusters in the 40–80% band and every scan returned "no lock". The bar is lifted: survival is still 45% of the composite lock score (so it decides WHICH market is locked) and is printed on the scan card, but `isDeployable` now gates only on the structural properties a frozen session cannot survive — the hard gates (clustering, drift, a leg significantly below break-even), `score >= DUAL_LOCK_MIN_SCORE` (left at its original 58 — the bot is meant to behave exactly as it did before the survival gate, so nothing else was loosened; at the 70–80% survival synthetic indices actually produce, a 58 composite asks for a structural read of ~40–47, which is reachable) and ξ ≤ 1.08. A refusal now names the actual blocker instead of saying "re-scan shortly".
- **Pre-locked bots analyse ONCE (Dual-Lock Range Sentinel)**: the 6th bot in the AI Bot Arena inverts the section's model. It trades ONLY Over 1 / Under 8 / Over 2 / Under 7 in normal mode and ONLY Over 4 / Over 5 / Under 5 / Under 4 in recovery, and it selects the market plus BOTH contracts before the session starts, then freezes them — no mid-session analysis of any kind, because the session is required to run non-stop to TP or SL. The selection therefore optimises SURVIVAL, not per-trade edge: (a) loss-clustering ratio ξ = P(loss|loss)/P(loss) from a 2-state chain on the loss indicator — a clustering market is refused outright, since consecutive losses (not a low win rate) is what ruins an unattended ladder; (b) the recovery leg is scored on its TRUE estimand, P(win | last digit ∈ the normal contract's losing set), from Dirichlet-smoothed transition rows — recovery only ever fires from the post-loss state, so its unconditional rate is the wrong number; (c) all rates are 5th-percentile Beta posterior bounds computed on an autocorrelation-corrected n_eff = n(1−ρ₁)/(1+ρ₁); (d) Pearson χ² block homogeneity (Wilson–Hilferty z) rejects drifting markets, the specific failure mode of a lock that cannot adapt; (e) a stationary block bootstrap (block length 10, preserving serial dependence) replays the real digit stream through the real engine rules — debt-driven recovery stake, max steps, TP, SL — and returns P(TP before SL), which is the headline number and the RANKING signal; (f) Benjamini–Hochberg FDR across all ~320 market × pair candidates, reported as a quality badge. Live, the only surviving safety valve is a circuit breaker that halts the session if the realised loss run exceeds the bootstrap's p95 recovery depth + 2. It uses the SAME shared recovery ledger, the SAME `getBotRecoveryStake` debt formula and the SAME single-executor arbiter as the other five bots; it has its own `/api/bots/duallock/*` endpoints because its lifecycle (scan-once → freeze → run) does not fit the generic specialist route.
- **The Kill-Shot bot is measured out of sample, not backtested (7th bot)**: a "high accuracy" bot built from stacked thresholds is untestable — nobody knows what the thresholds do until real money is on them. `lib/killshot-analysis.ts` therefore fits the ensemble, the Platt calibration and the entry threshold on the FIRST half of each market's 4,999-digit history and reports only what the frozen rule then did on the SECOND half, which the fit never touched. In-sample and out-of-sample accuracy are printed side by side, so over-fitting is visible instead of hidden. The rule that runs live is the same function: `evaluateLiveEntry` replays the ensemble tick-for-tick — including feeding each reading back into the hedge weights, which a naive warm-up silently skips and thereby produces a different model — and the test suite proves it by re-deriving recorded shots from truncated prefixes.
- **Selectivity is the knob; the threshold is self-referential (7th bot)**: the predecessor died of two structural faults, both fixed rather than re-tuned. (a) DATA STARVATION — `deriv.ts` capped the digit ring at 300, so a 1,200-tick window with a 120-tick burn-in examined ~180 ticks and could never reach its own 24-shot requirement; deep `ticks_history` (Deriv's hard maximum is 4,999) is now fetched per market and cached. (b) A NON-TRANSFERABLE BAR — raw edge z drifts as the posterior variance shrinks, so a threshold fitted early can never be cleared later. The live edge is now standardised against the model's own trailing 600 readings and compared to its own trailing top-q quantile, so the rule fires at its design rate in ANY regime and always yields shots to measure. τ is additionally floored at the level that delivers `minShots` out of sample: a specification that cannot be satisfied by the data that exists is not rigour, it is the bug.
- **The SPRT was asking the wrong question (7th bot)**: the old bot ran a sequential test on the MARGINAL tick stream — for Over 0 that means H₀ = 91.7% break-even against a 90% fair rate, so the log-likelihood ratio drifts the wrong way and the console reported "≈1931 more ticks" forever. Evidence is now an anytime-valid e-value (betting supermartingale, Ville's inequality) computed on the SHOT SEQUENCE, which is the sequence the bot's claim is actually about, and it is valid at every stopping time including the data-dependent one.
- **"No consecutive losses" is computed, not asserted (7th bot)**: the shared recovery ladder is debt-driven, so debt(k) = baseStake·(1+a)^(k−1) with a = (1+markup)/(payout−1) and it fails at the first k whose stake exceeds the cap — or whose debt reaches the stop loss. `ladderDepthLimit` solves both in closed form for k*, the number of consecutive losses the user's own stake/payout/markup/cap/stop-loss can absorb. The loss sequence is a 2-state Markov chain and P(a run deeper than k* occurs within N shots) is then EXACT by finite Markov chain imbedding (Fu & Koutras 1994) — an absorbing state at k*+1, iterated N times, no Monte Carlo. `expectedShotsToLadderBreak` gives the closed-form mean waiting time E[T_k] = [1 + r(1−q^(k−1))/(1−q)]/(r·q^(k−1)), which reduces to the classical (1−p^k)/((1−p)p^k) when r = q = p. Both are checked in `killshot-analysis.test.ts`.
- **Clustering is gated on a z, never on an absolute ceiling (7th bot)**: an absolute cap on ξ = P(L|L)/P(L) (or on its upper bound) silently vetoes every high-win-rate contract, because rare losses mean few transitions behind q and a wide bound from sampling noise alone — Over 1 on a perfectly fair stream scores ξ_upper ≈ 1.21. The gate is therefore the one-sided z for q > pLoss in units of q's OWN standard error, plus a minimum absolute gap, so only clustering that is both significant and big enough to matter is refused.
- **The market is locked and stays locked (7th bot)**: `LOCKED_SYMBOL`, `LOCKED_CONTRACT` and the frozen model `CARD` are consts captured once at session start and re-asserted before every buy; there is no hunt mode, no rotation and no re-selection anywhere in `killshot-engine.ts`. Because a lock cannot be corrected mid-session, a Page–Hinkley detector (mirrored for a FALL, past-only running mean, δ = 0.03, λ = 10) plus a live re-read of the verdict watches the locked market: after 2 consecutive flags the bot raises ⚠️ RESCAN REQUIRED and HOLDS FIRE, and after 5 it ends the session and asks for a fresh analysis. The user is told to rescan; the market is never quietly changed.
- **The post-loss shield is simulated before it is trusted (7th bot)**: after a loss the live bar rises by `postLossTightening` σ per step of the run (capped at 2.5σ) and a tick cool-down is enforced, and a recovery shot carries one EXTRA step on top because the debt is already geometric. `simulateShield` replays that exact rule over the out-of-sample shots and reports loss pairs before → after plus the shots it cost. The bar is anchored on τ, not on the z of the shot that just lost: anchoring on the loss lets one unlucky high-edge shot suppress every subsequent WINNING setup, which keeps the loss state alive and makes the pair count go up.
- **The edge is conditional, because the marginal can never carry it (7th bot)**: every Deriv digit contract pays below its fair rate (Over 1 pays 1.23× against an 80% fair rate), so an unbiased stream is always −EV and no honest analysis can call it +EV. The only available edge is P(win | the digits that just came), estimated by a variable-order Markov model with Krichevsky–Trofimov mixing — a hot market is carried by the order-0 term and a hot context by the deeper ones, under one rule. The same chain is reused as a TIMING filter: if P(win | last tick lost) beats P(win | last tick won) by more than its own standard error the bot waits for the post-loss state.
- **The proof bar is a user decision, and a refusal is never a dead end (7th bot)**: Elite / Strict (default) / Balanced in `KILLSHOT_CERTAINTY`, sized against the data that actually exists — each level's target shot rate is chosen so its own `minShots` requirement is reachable inside one 4,999-digit scan window. The scan returns four verdicts (CERTIFIED / QUALIFIED / WATCH / REFUSED), always ranks every market, and always surfaces the single best market available with the exact reason it fell short, which the user may lock deliberately behind a confirmation. Only REFUSED is absolute, and it means the measured out-of-sample expectancy is negative.
- **Contract-first API**: OpenAPI spec → Orval codegen → typed React Query hooks + Zod server validators
- **AI engine in TypeScript**: 8-agent ML ensemble (Random Forest, Gradient Boosting, Logistic Regression for direction; Markov + Multinomial for digits). No EMA/RSI — avoids crowd indicators. Adaptive tick windows (30–200) for digit contracts.
- **Simulated trade outcomes**: When Deriv token is connected, prices come from real WebSocket ticks; without token, realistic price simulation is used; trade outcomes are probability-weighted by AI confidence score
- **Market rotation cache**: Market analyses cached for 30s per symbol, background refresh on demand
- **Self-learning**: Per-market win rates persisted in Postgres (`market_win_rates`); trade features logged for calibration
- **EV gating**: Deriv `proposal` API fetches live payout; trades require positive expected value when enabled
- **Paper trade mode**: Log decisions without live Deriv orders for validation

## Product

- **AI Bots** (`/bots`): five single-contract specialist bots — Parity Sentinel (Even/Odd), Differ Guardian (Differs), Match Sniper (Matches), Barrier Architect (Over/Under), Vector Momentum (Rise/Fall). Each is hard-wired to one contract family for BOTH normal and recovery trades, so a parity bot only ever recovers in Even/Odd. Users set side (over-only / under-only / both), digit lock (match/differ), stake, SL, TP, recovery policy and locked-vs-switching market mode, exactly as in the Quantum FAB.
- **Kill-Shot Oracle** (`/bots` → BOT-KILLSHOT): one user-named contract (Over N / Under N / Matches / Even / Odd — never both sides of a pair), the AI pulls 4,999 digits from every market, measures its own entry rule out of sample and LOCKS the best market, then waits — as long as it takes — for health, edge, the post-loss shield and the tick to all agree. No rotation, no trade on deploy, a RESCAN REQUIRED alert when the locked market changes, and a proof bar the user chooses. For Matches it scores all ten digits in every market and applies BH-FDR across the whole 190-candidate family.
- **Dashboard**: Engine status (8 AI agents), top opportunity card, daily P&L, trades today
- **Markets**: All 33+ markets ranked by AI quality score — Synthetic, Forex, Commodities, Derived
- **Market Detail**: Individual market with price chart, full 8-agent score breakdown, AI recommendation
- **Trade Journal**: Complete trade history with win/loss, confidence, AI reasoning per trade
- **Analytics**: Performance curves, drawdown analysis, market breakdown, agent accuracy
- **Settings**: Risk profile (Conservative/Moderate/Aggressive), daily target, loss limits, drawdown protection, confidence thresholds, market rotation parameters
- **Connect**: Deriv API token connection screen

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **New Deriv API architecture**: The legacy `wss://ws.derivws.com/websockets/v3?app_id=<ID>` endpoint does NOT accept the new alphanumeric App IDs (returns 401). The app has been migrated to the new API:
  - **Public market data** (ticks, proposals): `wss://api.derivws.com/trading/v1/options/ws/public` — no auth required
  - **Authenticated trading**: OTP URL from `POST /trading/v1/options/accounts/{id}/otp` — no `authorize` WS message
  - **Auth**: OAuth2 + PKCE via `auth.deriv.com` (not `oauth.deriv.com`)
- **No `authorize` WS message**: The new API authenticates via OTP URL. Any code that sends `{ authorize: token }` over WebSocket will fail silently with the new endpoints.
- **`underlying_symbol` not `symbol`**: Proposal and buy WS messages must use `underlying_symbol` field. The `ticks` subscription still uses `ticks: "R_100"`.
- **OTP URLs are one-time-use** for establishing a connection; the connection stays alive for multiple messages. On reconnect, always fetch a fresh OTP URL.
- **Redirect URI must match**: The redirect URI used in OAuth must exactly match what is registered in the Deriv app dashboard (including trailing slashes, http vs https, port).
- **DERIV_APP_ID**: Alphanumeric string from app.deriv.com/apps. Used as OAuth `client_id` and `Deriv-App-ID` header on REST calls. Not appended to the WebSocket URL.
- The `ws` package must be a `dependency` (not devDependency) since it's used at runtime in the bundled server
- Market analysis cache lives in-memory — restarts clear it; first requests will be slower as cache warms up

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Deriv API docs: https://api.deriv.com/
- To add real trade execution: implement the `buy` WebSocket command in `artifacts/api-server/src/lib/deriv.ts`
