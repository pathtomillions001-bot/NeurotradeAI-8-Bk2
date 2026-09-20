# Bot Frontend Sync Fix — Match Pulse, Compounding Range Sentinel

## Issue Reported (2026-09-19)

> "our app bots look different in sandbox than how they actually look in the live url https://neuro-trade.site/bots
> have a look at the Match Pulse and Compounding Range Sentinel they look different
> from what we have here in the sandbox, why is that the case yet i did merge given pr link and i
> expected the same changes in our live url when i merge the next pr link."

Screenshots showed the **correct** dedicated consoles in sandbox, but live showed generic specialist console.

## Root Cause — Release Skew (web ≠ api)

| Service | Commit at time of report | Consoles it could render |
|---------|--------------------------|--------------------------|
| **web** (`neuro-trade.site`) | `39300a9` (PR #27, 2026-09-14) | `specialist@1`, `dual-lock@1`, `killshot@1`, `killshot-family@1` (old) |
| **api** | `dc5f4dd` (main, 2026-09-19) | `specialist@1`, `match-pulse@1`, `accumulator@1`, `dual-lock@1`, `killshot@1`, `killshot-family@1` |

- Match Pulse (`match-pulse@1`) and Compounding Range Sentinel (`accumulator@1`) **did not exist** at `39300a9`
- Old Bot Arena dispatch chain had no case for new flags, so it **silently fell through to generic specialist console** — no error, only visual difference
- `/__release` endpoint did not exist in old bundle, so `https://neuro-trade.site/__release` fell through to `index.html` (200) — Railway healthcheck passed while serving stale build
- API was current (`/api/healthz` returned `dc5f4dd` and correct console list), only web was stale

**Conclusion:** Backend was NOT compromised, only frontend deployment was stale. Backend analysis, timing, execution were already correct.

## What This PR Fixes

### 1. Frontend — Exact Spec Match (2 bots)

#### Match Pulse (`match-pulse@1`)
```
Contract Sovereignty — Strict Contract Lock
Matches only
AI selects the digit. Normal and recovery trades stay in Matches.
Trading account [Connect an account]
Risk Parameters — Session Boundaries
Base stake USD, Take profit USD, Stop loss USD, Stop after losses
Recovery Engine — Match Sniper policy
Debt + markup recovery
Max recovery steps, Markup on debt %
Same debt-based recovery as Match Sniper. Markup saves automatically and is shared by the bots.
The step cap tracks recovery depth; the loss limit stops new entries.
Neural Scan All Markets
```
- Backend: `lib/match-pulse-engine.ts` — tick-guarded lifecycle, one order in flight, quote-time AND socket-send checks, post-loss cooling, debt+markup recovery via `recovery-engine.ts` + `recovery-math.ts`
- Analysis: `match-pulse-analysis.ts` — all 10 digits, order-0/1/2 conditional models, chronological validation + untouched audit, evidence correction
- Execution: `match-pulse-execution.ts` — broker-feed checks, payout verification, session-isolated

#### Compounding Range Sentinel (`accumulator@1`)
```
The compounding ladder
Barriers re-centre on previous spot every tick. Survive a tick and value compounds by 2%; touch a barrier once and whole stake is gone — no partial payout to invert. Deriv cuts band from index's own volatility so survival is worth exactly 98.039% — break-even — only edge is realised volatility coming in below band.
Break-even p 0.98039, Hold cap 164t, Payout @ cap 25.7×
Growth rate (compounding per tick): 1% 2% 3% 4% 5% — Higher growth pays faster but needs higher survival rate AND shorter hold (cap shrinks from 230 ticks at 1% to 60 ticks at 5%).
Certainty profile: Elite Strict Balanced — λ lower ≥1.0015 with conservative EV ≥2%, 800 ticks, FDR 10%. σ ratio is checked, not demanded.
Stake per position USD, Take profit USD, Stop loss USD, Max recovery steps
Recovery buys a LONGER horizon at same stake — never a bigger one.
Measure every market
```
- Backend: `accumulator-engine.ts` — λ = p·(1+g), EV multiplies by λ per tick, Deriv sizes range so fresh band is exactly fair (R_10 bands σ_tick × 99%/95% quantiles), only edge is realised vol < barrier vol, Kaplan–Meier survival, holds to horizon where LOWER confidence bound peaks, FDR-controlled via Benjamini–Hochberg, refusal is feature when λ≤1, sell-at-par risk mgmt (Page–Hinkley, Wald SPRT, Bernoulli CUSUM), recovery by horizon n* = ⌈ln(1+D/stake)/ln(1+g)⌉ logarithmic, Markov entry 4-state chain with Krichevsky–Trofimov smoothing

### 2. Deployment — Guarantee Next PR Updates Live

**serve-production.mjs**
- Now explicitly handles `/__release` and `/release.json` BEFORE static handler
- Always returns JSON with `no-store` cache, even if `release.json` missing
- Old incident: `/__release` fell through to `index.html` (200) → healthcheck passed while stale

**railway.toml (web)**
- watchPatterns expanded: now includes `/lib/api-zod/**`, `/lib/db/**`, `/scripts/**`
- Any change to shared libs triggers web rebuild
- healthcheckPath = `/__release` (already) — now guaranteed JSON, so skew is detectable

**Verification**
```bash
curl -s https://neuro-trade.site/__release | jq
# parity: "ok", missingConsolesHere: []

pnpm --filter @workspace/trading-platform run check:release https://neuro-trade.site
# exits 1 if deployed bundle ≠ local build or web/API console contracts differ
```

### 3. Console Contract — No Silent Fallback

- `console-contract.ts`: lists all console IDs this bundle implements
- `console-registry.ts`: `resolveConsole()` returns `{ok:false}` when API asks for unknown console, instead of falling back to generic specialist console
- `bots.tsx`: shows explicit "This page is an older release than the server" panel with Update Required button when skew detected
- `bot-activity.ts`: activeBotId priority order includes accumulator, so running Compounding Range Sentinel reports correctly

## How to Fix Skewed Live Deployment (Railway Dashboard)

1. Railway → service serving custom domain `neuro-trade.site` → Settings → Source:
   repo = `pathtomillions001-bot/NeurotradeAI-8-Bk2`, branch = `main`, auto-deploy enabled
2. Build → Config-as-code path `/artifacts/trading-platform/railway.toml`, Root Directory **empty**
3. Ctrl/Cmd+K → Deploy Latest Commit (NOT Redeploy old deployment — that rebuilds old commit)
4. Verify:
   ```bash
   curl -s https://neuro-trade.site/__release | jq
   curl -s https://neuro-trade.site/api/healthz | jq
   pnpm --filter @workspace/trading-platform run check:release https://neuro-trade.site
   ```
5. If domain is attached to old Railway project (`zealous-cat` / `satisfied-surprise` stopped at `39300a9`), move custom domain to service that follows `main`

## Backend ↔ Frontend Sync Verified

- Bot catalogue (`bot-catalog.ts`) `botConsoleId()` returns `match-pulse@1`, `accumulator@1`
- Web `WEB_CONSOLE_IDS` matches exactly
- `console-registry.test.ts` fails if API can ask for ID bundle does not ship
- Both remaining engines use `createSessionScoped()` + `engine-arbiter.ts` single lock per browser session — no cross-account leakage
- Recovery uses shared ledger (`recovery-engine.ts`) with markup from Settings (`bot_recovery_markup`), same for all bots

## Result

After this PR merges and Railway web service redeploys from `main`:

- Sandbox and live `https://neuro-trade.site/bots` show **identical** dedicated consoles for Match Pulse and Compounding Range Sentinel
- Backend analysis, timing, execution unchanged and correctly wired to frontend
- Future console changes will be detected immediately via `/__release` parity check and explicit skew panel, never silent fallback
