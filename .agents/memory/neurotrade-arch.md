---
name: NeuroTrade monorepo architecture
description: Key facts about the NeuroTrade AI trading platform architecture
---

Monorepo structure:
- `artifacts/trading-platform` — React+Vite frontend, port 21210 (BASE_PATH=/)
- `artifacts/api-server` — Express backend, port 8080
- `lib/db` — Drizzle ORM schema + DB migrations (push with `pnpm --filter db push`)
- `lib/api-client-react` — React query hooks for API (needs build for TS but Vite handles it)

Workflow: "Start application" — `pnpm install && (PORT=8080 pnpm --filter api-server run dev & PORT=21210 BASE_PATH=/ pnpm --filter trading-platform run dev)`

DB schema changes require: `pnpm --filter db push` (uses drizzle-kit push).

Pre-existing TS errors in frontend: `api-client-react/dist/index.d.ts` not built — these are harmless, Vite resolves them at runtime. Do NOT treat as new errors.

Deriv OAuth: app_id=1089, redirects to `https://oauth.deriv.com/oauth2/authorize?app_id=1089`

Landing gate: App.tsx checks `GET /api/auth/account` — if no loginId, shows LandingPage component. Dismissed via localStorage `nt_visited=1`.
