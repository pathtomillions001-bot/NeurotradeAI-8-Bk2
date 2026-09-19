# Web/API deployment parity

## Incident: 2026-09-19

The production domain was not serving the same revision as the API:

| Surface                    | Railway service            | Deployed commit    | Result                            |
| -------------------------- | -------------------------- | ------------------ | --------------------------------- |
| `https://neuro-trade.site` | `NeurotradeAI-8-Bk2` (web) | `39300a9` / PR #27 | Old bot consoles                  |
| `/api/*`                   | `api`                      | `1d7b39f` / PR #33 | Current bot catalogue and engines |

This was proven from GitHub deployment statuses, not inferred from appearance:

- the custom-domain web service reported success against `39300a9`;
- the API service reported success against `1d7b39f`;
- the live API exposed the current Match Pulse, Twin-Hedge and accumulator
  catalogue flags and their dedicated status endpoints;
- the web source at `39300a9` had no Match Pulse or accumulator console branch
  and contained the superseded Twin-Hedge console.

The browser therefore used the generic specialist console for new bot kinds and
an obsolete console for Twin-Hedge. This is **release skew**, not evidence that
the bot algorithms or database were altered.

## One-time Railway correction (required)

Repository code cannot turn a Railway service's source trigger back on. In the
Railway project, open the service attached to `neuro-trade.site` and set:

1. **Settings → Source**
   - repository: `pathtomillions001-bot/NeurotradeAI-8-Bk2`
   - branch: `main`
   - automatic deployments: **Enabled**
2. **Root Directory**: empty
3. **Railway config path**: `/artifacts/trading-platform/railway.toml`
4. Build command: `pnpm --filter @workspace/trading-platform build`
5. Start command: `pnpm --filter @workspace/trading-platform start`
6. Keep `API_UPSTREAM` pointed at the API service's Railway private domain.

The API service must remain separately configured with:

- branch `main`, automatic deployments enabled;
- empty Root Directory;
- config path `/artifacts/api-server/railway.toml`.

If automatic deployment is enabled only after a merge, Railway does not replay
that push. Use **Ctrl/Cmd + K → Deploy Latest Commit** once on the web service.
Do not use **Redeploy** on the old deployment: that intentionally rebuilds the
old commit again.

## Safeguards now in the repository

1. `@workspace/deployment-contract` is imported by both services. Both Railway
   watch lists include it, so an incompatible bot-console change rebuilds both.
2. `/api/healthz` reports the API commit and bot-console contract.
3. `/__healthz` reports the exact browser build commit and contract. The web
   Railway healthcheck now uses this endpoint instead of accepting any old
   `index.html` as healthy.
4. `/api/bots` includes the release and contract. The Bot Arena disables all
   specialist console buttons if the browser and API contracts differ; it no
   longer silently falls back to the wrong controls.
5. The root `railway.toml` is a safe web fallback for the existing root-named
   service. The explicit per-service config paths above are still preferred.

## Verification after every production deployment

```bash
pnpm verify:production
```

To prove that a specific merge was deployed to both services:

```bash
EXPECTED_WEB_COMMIT=<full-merge-sha> \
EXPECTED_API_COMMIT=<full-merge-sha> \
pnpm verify:production
```

Expected output shows both commits and one matching contract. A non-JSON
`/__healthz` means the old SPA is still serving and the web source trigger has
not been corrected.

## Changing a bot console or endpoint

When a change is incompatible, update
`BOT_CONSOLE_CONTRACT_VERSION` in
`lib/deployment-contract/src/index.ts` in the same PR. Because this path is
watched by both services, web and API are rebuilt together. Compatible internal
engine changes do not require a contract bump.
