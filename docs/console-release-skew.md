# Bot console release skew (web ↔ API)

**Incident: 2026-09-19.** On `https://neuro-trade.site/bots` the two newest
specialist bots rendered *different* controls than the same code in the sandbox:

| Bot | Sandbox (main) | Production |
| --- | --- | --- |
| **Match Pulse** (`match-pulse`) | dedicated pulse console | generic specialist console |
| **Compounding Range Sentinel** (`accumulator`) | compounding-range console | generic specialist console |

## Root cause — a split release, not a code bug

The web bundle and the API are **two independent Railway services** built from
two different watch paths. Production was running two different commits:

| Service | Commit | Date |
| --- | --- | --- |
| web (`neuro-trade.site`) | `39300a9` (PR #27) | 2026-09-14 18:12 |
| api | `1d7b39f` (PR #33) | 2026-09-19 13:38 |

The stale bundle predates every console it was asked to draw (Match Pulse and
the accumulator did not exist yet), and the Bot Arena's
dispatch chain had no case for the new flags, so it **silently fell through to
the generic specialist console**. Nothing errored — which is why the difference
was only visible by eye.

### How it was proven

1. **Asset fingerprint.** Vite names built assets by content hash. The live
   `index.html` referenced `/assets/index-B4Php8sd.css`; building the repo at
   `39300a9` produced exactly `index-B4Php8sd.css`, while current `main`
   produced `index-BveOoiSf.css`. Same name ⇒ same source tree.
2. **Behaviour.** At `39300a9` the landing gate ran on *every* route
   (`if (showLanding && !isConnectPage)`), so a visitor hitting `/bots`,
   `/markets` or `/dashboard` got the funnel. The fix for that landed later
   (`c0c17e14`, 2026-09-19 10:50) and only gates `/`. Production still served
   the funnel on deep links.
3. **API side.** `/api/bots` on production already returned `matchPulse: true`
   and the accumulator entry — so the API was current.

## What this PR changes

Silence was the real defect, so every layer now states its release:

* **Build stamp** — the web build embeds `__WEB_RELEASE__` and writes
  `dist/public/release.json` (commit, build time, environment, console ids).
* **API stamp** — `lib/release.ts` exposes the API commit; `/api/healthz` and
  `/api/bots` publish it together with the console ids the catalogue expects.
* **`/__release`** (web, in `scripts/serve-production.mjs`) — reports both sides
  and `parity: "ok" | "skew"`, and is now the Railway healthcheck path instead
  of `/` (which answered 200 for a stale bundle too).
* **Bot Arena guard** — a bot whose console this bundle does not implement gets
  an explicit *"This page is an older release than the server"* panel and an
  **Update Required** button. The generic console is never used as a silent
  fallback again.
* **Accumulator activity fix** — `/api/bots`'s active-bot chain forgot the
  accumulator (so a running Compounding Range Sentinel reported
  `activeBotId: null`). The order now lives in `lib/bot-activity.ts` with tests.
* **`pnpm --filter @workspace/trading-platform run check:release <url>`** —
  compares the deployed `/__release` *and* the deployed asset hashes with the
  local build; exits 1 on skew.

## Verifying a deployment

```bash
curl -s https://<web-service>/__release | jq
# parity: "ok", missingConsolesHere: []

pnpm --filter @workspace/trading-platform run check:release https://neuro-trade.site
```

`check:release` prints both asset fingerprints and exits non-zero when the
deployed bundle is not the one you just built.

## Fixing a skewed deployment (Railway)

The code cannot rebuild a service from here; the Railway service attached to
the domain must be pointed at `main` and redeployed:

1. Railway → the service serving the custom domain → **Settings → Source**:
   repo = this repository, branch = `main`, **automatic deployments enabled**.
2. **Build** → Config-as-code path `/artifacts/trading-platform/railway.toml`,
   Root Directory **empty** (the shared pnpm workspace needs the repo root).
3. `Ctrl/Cmd + K` → **Deploy Latest Commit**.
   Do **not** press **Redeploy** on the old deployment — that rebuilds the old
   commit and is how `39300a9` kept being served.
4. Confirm with `/__release` and `check:release` above; the Bot Arena banner
   disappears on the next load.

If `neuro-trade.site` is attached to a service in an *older* Railway project
(the deployment history shows `zealous-cat` / `satisfied-surprise` stopped at
`39300a9` on 2026-09-14 while the current project kept deploying), move the
custom domain to the service that follows `main` rather than reviving the old
one.

## Rules for future console changes

* Adding a console: add its id to `WEB_CONSOLE_IDS`
  (`artifacts/trading-platform/src/lib/console-contract.ts`), register the
  component in `console-registry.ts`, and return the same id from
  `botConsoleId()` (`artifacts/api-server/src/lib/bot-catalog.ts`). The web test
  `console-registry.test.ts` fails if the API can ask for an id the bundle does
  not ship.
* Changing an existing console materially: bump its `@N` revision on both sides
  its `@N` revision on both sides. That is what makes a stale bundle detectable
  when the bot id itself did not change.
* Backend isolation: every engine keeps its state in `createSessionScoped(...)`
  and takes its execution lock through `lib/engine-arbiter.ts` (one lock per
  browser session). A new engine must do both, or one account's run can leak
  into another account's console.
