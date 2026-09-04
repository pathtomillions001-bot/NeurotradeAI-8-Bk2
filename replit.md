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
- **Pre-locked bots analyse ONCE (Dual-Lock Range Sentinel)**: the 6th bot in the AI Bot Arena inverts the section's model. It trades ONLY Over 1 / Under 8 / Over 2 / Under 7 in normal mode and ONLY Over 4 / Over 5 / Under 5 / Under 4 in recovery, and it selects the market plus BOTH contracts before the session starts, then freezes them — no mid-session analysis of any kind, because the session is required to run non-stop to TP or SL. The selection therefore optimises SURVIVAL, not per-trade edge: (a) loss-clustering ratio ξ = P(loss|loss)/P(loss) from a 2-state chain on the loss indicator — a clustering market is refused outright, since consecutive losses (not a low win rate) is what ruins an unattended ladder; (b) the recovery leg is scored on its TRUE estimand, P(win | last digit ∈ the normal contract's losing set), from Dirichlet-smoothed transition rows — recovery only ever fires from the post-loss state, so its unconditional rate is the wrong number; (c) all rates are 5th-percentile Beta posterior bounds computed on an autocorrelation-corrected n_eff = n(1−ρ₁)/(1+ρ₁); (d) Pearson χ² block homogeneity (Wilson–Hilferty z) rejects drifting markets, the specific failure mode of a lock that cannot adapt; (e) a stationary block bootstrap (block length 10, preserving serial dependence) replays the real digit stream through the real engine rules — debt-driven recovery stake, max steps, TP, SL — and returns P(TP before SL), which is the headline number and the deployment bar; (f) Benjamini–Hochberg FDR across all ~320 market × pair candidates, reported as a quality badge. Live, the only surviving safety valve is a circuit breaker that halts the session if the realised loss run exceeds the bootstrap's p95 recovery depth + 2. It uses the SAME shared recovery ledger, the SAME `getBotRecoveryStake` debt formula and the SAME single-executor arbiter as the other five bots; it has its own `/api/bots/duallock/*` endpoints because its lifecycle (scan-once → freeze → run) does not fit the generic specialist route.
- **Contract-first API**: OpenAPI spec → Orval codegen → typed React Query hooks + Zod server validators
- **AI engine in TypeScript**: 8-agent ML ensemble (Random Forest, Gradient Boosting, Logistic Regression for direction; Markov + Multinomial for digits). No EMA/RSI — avoids crowd indicators. Adaptive tick windows (30–200) for digit contracts.
- **Simulated trade outcomes**: When Deriv token is connected, prices come from real WebSocket ticks; without token, realistic price simulation is used; trade outcomes are probability-weighted by AI confidence score
- **Market rotation cache**: Market analyses cached for 30s per symbol, background refresh on demand
- **Self-learning**: Per-market win rates persisted in Postgres (`market_win_rates`); trade features logged for calibration
- **EV gating**: Deriv `proposal` API fetches live payout; trades require positive expected value when enabled
- **Paper trade mode**: Log decisions without live Deriv orders for validation

## Product

- **AI Bots** (`/bots`): five single-contract specialist bots — Parity Sentinel (Even/Odd), Differ Guardian (Differs), Match Sniper (Matches), Barrier Architect (Over/Under), Vector Momentum (Rise/Fall). Each is hard-wired to one contract family for BOTH normal and recovery trades, so a parity bot only ever recovers in Even/Odd. Users set side (over-only / under-only / both), digit lock (match/differ), stake, SL, TP, recovery policy and locked-vs-switching market mode, exactly as in the Quantum FAB.
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
