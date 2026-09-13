# Deploy NeuroTrade to Railway (pnpm shared monorepo)

This repo is a **shared pnpm workspace** (`pnpm-workspace.yaml` + `catalog:` + `workspace:*`).  
It is **not** an isolated monorepo. Getting that distinction wrong is what caused the earlier Railway failures.

## Architecture (recommended)

```
Railway Project
├── Postgres          → provides DATABASE_URL
├── api               → @workspace/api-server  (Express on $PORT)
└── web               → @workspace/trading-platform
                        static SPA + reverse-proxy /api → api
```

| Service | Public? | Role |
|---------|---------|------|
| **web** | Yes (generate domain) | Users hit this. Serves Vite build + proxies `/api` to the API. |
| **api** | Private (or public if you want direct API access) | Express API, Deriv WS, bots, DB. |
| **Postgres** | Private | Persistent store. Required for production. |

`mockup-sandbox` is **not** deployed.

---

## Why previous errors happened (quick map)

| Error | Cause | Fix in this setup |
|-------|--------|-------------------|
| “8 packages, no start command” | One service at repo root; root `package.json` has no `start` | Two services, each with `pnpm --filter …` build/start |
| Root Directory = `artifacts/…` | Treated shared workspace like isolated | **Root Directory empty** on both services |
| `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` | Lockfile out of sync with `catalog`/`overrides` | Commit matching `pnpm-lock.yaml`; pin `packageManager` |
| `npm error Unsupported URL Type "catalog:"` | npm used instead of pnpm (usually because root dir hid the lockfile) | Root = repo root; `pnpm-lock.yaml` present; `packageManager` field |

---

## One-time Railway setup

### 1. Create the project from GitHub

1. [railway.com/new](https://railway.com/new) → Deploy from GitHub repo.
2. If Railway’s monorepo importer stages many packages, **delete** anything that isn’t `api` / `web` (especially `mockup-sandbox`).
3. Or create an empty project and **add two services** that both point at the same repo.

### 2. Add Postgres

1. **+ New** → **Database** → **PostgreSQL**.
2. Note the service name (often `Postgres`).

### 3. Configure the **api** service

**Settings → Source**

| Field | Value |
|-------|--------|
| Root Directory | *(empty)* |
| Config-as-code path | `/artifacts/api-server/railway.toml` |

**Settings → Build / Deploy** (filled by the toml; verify)

| Field | Value |
|-------|--------|
| Build Command | `pnpm --filter @workspace/api-server build` |
| Start Command | `pnpm --filter @workspace/api-server start` |
| Watch Paths | see toml |

**Variables**

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (use your Postgres service name) |
| `DERIV_APP_ID` | Your Deriv app id (alphanumeric from app.deriv.com) |
| `NODE_ENV` | `production` |
| `PORT` | *(Railway sets this — do not hardcode 8080)* |

Optional:

| Variable | Notes |
|----------|--------|
| `API_PORT` | Only if you must override; prefer `PORT` |
| `RAILPACK_NODE_VERSION` | `22` if you want to pin Node |

**Networking**

- Enable a **private** domain (e.g. `api.railway.internal`) — used by the web proxy.
- Public domain optional.

### 4. Configure the **web** service

**Settings → Source**

| Field | Value |
|-------|--------|
| Root Directory | *(empty)* |
| Config-as-code path | `/artifacts/trading-platform/railway.toml` |

**Settings → Build / Deploy**

| Field | Value |
|-------|--------|
| Build Command | `pnpm --filter @workspace/trading-platform build` |
| Start Command | `pnpm --filter @workspace/trading-platform start` |

**Variables**

| Variable | Value |
|----------|--------|
| `API_UPSTREAM` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}` |
| `VITE_DERIV_APP_ID` | Same value as `DERIV_APP_ID` (baked in at **build** time) |
| `NODE_ENV` | `production` |
| `PORT` | *(Railway sets this)* |

> **Important:** `VITE_*` vars are embedded during `vite build`. After changing them, **redeploy web** (rebuild), not just restart.

If the reference syntax for private domain differs in your workspace UI, set `API_UPSTREAM` manually to something like:

```text
http://api.railway.internal:8080
```

Use the API service’s actual private DNS name and listen port from the Railway service variables panel.

**Networking**

- Generate a **public** HTTPS domain — this is the URL users open.
- No need to expose the API publicly if the proxy works.

### 5. Frontend ↔ API (same-origin)

The SPA calls **relative** `/api/...` (including `EventSource`).  
`artifacts/trading-platform/scripts/serve-production.mjs`:

1. Serves `dist/public` (Vite outDir).
2. Reverse-proxies `/api` → `API_UPSTREAM`.
3. SPA-fallbacks unknown paths to `index.html` (wouter).

That preserves cookies and SSE without CORS pain.

### 6. Schema on Postgres

On first boot with `DATABASE_URL` set, the API:

1. **Applies the full idempotent DDL in-process** (`@workspace/db` runs
   `CREATE TABLE IF NOT EXISTS … ADD COLUMN IF NOT EXISTS …` over the pool).
   This requires no build tooling and works on Railway's runtime container.
2. Still attempts `pnpm --filter @workspace/db run push` (drizzle-kit) when a
   specific column drift is detected — harmless if unavailable.
3. Applies session-isolation `ALTER`/`CREATE INDEX` statements.

Ensure `DATABASE_URL` is present **before** the first healthy deploy.  
If the schema is still missing, check API logs for
`[db] Failed to apply initial DDL to external Postgres`.

---

## Commands reference (local parity)

```bash
# Install (must be pnpm — root preinstall rejects npm/yarn)
pnpm install

# Build each deployable package
pnpm --filter @workspace/api-server build
pnpm --filter @workspace/trading-platform build

# Run API (needs DATABASE_URL for real Postgres, or omit for PGlite)
DATABASE_URL=postgresql://… pnpm --filter @workspace/api-server start

# Run web (proxies /api to API_UPSTREAM)
API_UPSTREAM=http://127.0.0.1:8080 PORT=5000 pnpm --filter @workspace/trading-platform start
```

Root helpers (same filters):

```bash
pnpm run build:api
pnpm run build:web
pnpm run start:api
pnpm run start:web
```

---

## Hard rules (do not break these)

1. **Root Directory stays empty** on both services.  
2. **Always pnpm** — never let the build fall back to `npm install`.  
3. **Commit `pnpm-lock.yaml`** whenever you change `pnpm-workspace.yaml` catalogs/overrides.  
4. **Two services**, not one — unless you later teach Express to serve the SPA (different design).  
5. **Postgres in production** — PGlite on ephemeral disk loses data on restart.  
6. **Don’t deploy `mockup-sandbox`.**

---

## Why "worked on Replit but broken on Railway" (the big one)

The most common failure: **every API call fails at once** — settings don't save,
Deriv accounts can't be linked, market data never appears. On Replit everything
ran in one process with `vite dev` proxying to the API. On Railway the web
service proxies `/api` to the api service, and the API talks to Postgres. Three
things must all be true:

1. **The Postgres schema must exist.** The Railway *runtime* container has no
   pnpm/drizzle-kit, so the old "run `drizzle-kit push` at boot" strategy
   silently failed and every query died with `relation "settings" does not
   exist`. **Fixed in code**: `@workspace/db` now applies the full idempotent
   `CREATE TABLE IF NOT EXISTS` DDL directly over the pool on boot for external
   Postgres — no build tooling required.
2. **`API_UPSTREAM` must be set on the web service** to the api service's
   private URL (e.g. `http://api.railway.internal:8080`). If it's missing the
   proxy defaults to `127.0.0.1:8080` inside the web container → 502 on every
   `/api` call.
3. **Deriv OAuth config** (see the Deriv checklist below).

### One-URL verification

Open `https://<your-web-domain>/api/healthz`. It now returns diagnostics:

```json
{
  "status": "ok",
  "db": { "ok": true, "external": true, "tablesMissing": [] },
  "deriv": { "appIdConfigured": true },
  "tickFeed": { "connected": true, "liveSymbols": 19, "totalSymbols": 19 }
}
```

- `db.ok: false` / `tablesMissing` non-empty → check api logs for
  `[db] Failed to apply initial DDL` (usually `DATABASE_URL` missing or the
  Postgres service not linked to the api service via
  `${{Postgres.DATABASE_URL}}`).
- `deriv.appIdConfigured: false` → "Sign in with Deriv" will 503.
- `tickFeed.connected: false` for minutes → Railway egress to
  `wss://api.derivws.com` blocked or Deriv outage (the app falls back to
  simulated prices).

### Deriv OAuth checklist (Railway-specific)

1. `DERIV_APP_ID` variable on the **api** service (alphanumeric id from
   app.deriv.com/apps).
2. `VITE_DERIV_APP_ID` variable on the **web** service — **rebuild** web after
   changing it (Vite bakes it at build time; a restart is not enough).
3. At app.deriv.com/apps → your app → add the Railway URL as an allowed
   **redirect URL**: `https://<your-web-domain>/connect`. The Replit URL that
   used to work will no longer match after the move.
4. Users must open the **web** public domain only (same-origin `/api`), never
   the api public URL — otherwise session cookies break.

## Troubleshooting

### Build uses `npm` and dies on `catalog:`

- Root Directory was set to a package folder, **or** `pnpm-lock.yaml` missing from the build context.
- Fix: empty Root Directory; confirm lockfile is committed; `packageManager` in root `package.json`.

### `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`

```bash
pnpm install          # regenerates lock to match workspace config
git add pnpm-lock.yaml pnpm-workspace.yaml
git commit
```

### “No start command” / monorepo with N packages

- Service has no start command and root has no `start`.
- Fix: attach the correct `railway.toml` or set start to `pnpm --filter @workspace/… start`.

### Web loads but API calls 502

- `API_UPSTREAM` wrong or API not healthy.
- Check api logs + private domain + port.
- From web service variables, confirm the reference expands to a real `http://…:port`.

### Web loads but `/api` 404 from static server

- Old deploy without `serve-production.mjs`, or start command still SPA-only Caddy without proxy.
- Start command must be `pnpm --filter @workspace/trading-platform start`.

### Cookies / OAuth / session issues across domains

- Users must use the **web** public URL only (same origin for `/api`).
- Don’t point the browser at the API public URL for the SPA.

---

## Checklist before first deploy

- [ ] `pnpm-lock.yaml` committed and matches workspace  
- [ ] Root `packageManager` field present  
- [ ] Postgres plugin added  
- [ ] **api** service: empty root dir, api `railway.toml`, `DATABASE_URL`, `DERIV_APP_ID`  
- [ ] **web** service: empty root dir, web `railway.toml`, `API_UPSTREAM`, `VITE_DERIV_APP_ID`  
- [ ] Public domain on **web** only (recommended)  
- [ ] First deploy green; `/api/healthz` via `https://<web-domain>/api/healthz` returns `{"status":"ok"}`  
