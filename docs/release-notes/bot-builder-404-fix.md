# Fix: Deriv Bot Builder 404 ("Did you forget to add the page to the router?")

## Problem

Clicking **Bot Builder** in the sidebar rendered the NeuroTrade 404 page:

> 404 Page Not Found — Did you forget to add the page to the router?

That text comes from `artifacts/trading-platform/src/pages/not-found.tsx`, which the
router renders via its catch-all fallback when no route matches.

## Root cause

1. **Missing route (the direct bug).** `src/App.tsx` imported the `BotBuilder`
   page (`import BotBuilder from "./pages/bot-builder";`) and the sidebar nav
   (`src/components/layout.tsx`) linked to `/bot-builder` — but `/bot-builder`
   was never registered in the `<Switch>` route table. Every other nav item
   (`/bots`, `/trades`, `/connect`, …) had a route; the bot builder did not, so
   it fell through to the global 404 route.

2. **Dev-mode gap (why a fresh dev/preview instance still didn't work).** Even
   with the route fixed, the builder page renders an iframe pointing at
   `/bot/preview/`. In production, `scripts/build-dbot-builder.mjs` builds the
   vendored `artifacts/dbot-builder` and `copy-dbot-builder.mjs` copies it into
   `dist/public/bot/preview`, which `serve-production.mjs` serves. But in
   `vite dev`, `/bot/preview` was only proxied to a `:4003` rsbuild dev server
   that nothing ever starts — so a fresh dev instance had an empty iframe.

## Fix

- **`src/App.tsx`** — registered the missing route:
  `<Route path="/bot-builder" component={BotBuilder} />`.
- **`vite.config.ts`** — added a `botPreviewDevServe()` plugin that serves the
  builder's static output (`artifacts/dbot-builder/out/preview`) at
  `/bot/preview` during `vite dev`, matching production behaviour. When the
  output hasn't been built yet it falls back to the legacy `/bot/preview` proxy
  (rsbuild dev on `:4003`) for incremental builder work, and logs a hint telling
  the developer how to get a zero-process preview.
- **`scripts/serve-production.mjs`** — when the bundled builder isn't present on
  disk, `/bot/preview` now falls through to the SPA/proxy pipeline instead of
  serving a 404 (previously it required the full build or returned 404).
- **`scripts/first-paint-check.mjs`** — added a `/bot-builder` first-paint
  regression case so the 404 can never silently return.

## Why the vendored builder is otherwise correct

- The builder is a **separate Node 22 + rsbuild app** by design
  (`pnpm-workspace.yaml` excludes `artifacts/dbot-builder`; it has its own
  `package.json`, `package-lock.json`, and toolchain).
- It was verified to build cleanly and its output rewrites all asset references
  to `/bot/preview/*`, exactly what the production copier and server expect.
- The vendored copy matches `neurotrade-dbot-builder@main` with only intentional
  NeuroTrade branding (teal `#30aeb0`, Inter font, `src/preview/preview-branding.tsx`).

## Verification

- `pnpm --filter @workspace/trading-platform run check:first-paint` → all cases
  pass, including the new `/bot-builder` case.
- `node artifacts/trading-platform/scripts/build-dbot-builder.mjs` → builder
  compiles; output copied to `dist/public/bot/preview`.
- The `/bot/preview` contract is unchanged for production deploys.
