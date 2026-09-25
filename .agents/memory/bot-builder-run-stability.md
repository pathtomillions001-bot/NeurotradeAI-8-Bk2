# Bot builder run stability + boot speed

Five user-facing defects around the embedded Deriv bot builder, all traced to
concrete root causes and fixed in place (no behaviour regressions in standalone
builder deploys).

## 1. "Sorry for the interruption" — bot died right after the first trade

Two independent causes, both fixed:

**Public-path corruption (the main one).** `DBot.initWorkspace()` assigned a
bare `__webpack_public_path__ = public_path` (callers passed `'/'`). rsbuild
compiles that assignment to `__webpack_require__.p = '/'` — rewriting the chunk
loader's base path at runtime. Every lazy chunk requested AFTER workspace init
(the first one is the `pako` chunk, fetched by `trackTransaction` the moment a
purchase succeeds) resolved against the site root (`/static/js/async/…`)
instead of `/bot/preview/static/js/async/…` → `ChunkLoadError` → React Router
error boundary → "Sorry for the interruption" → bot dead after one trade.
Fix: never touch the module public path — set `window.__webpack_public_path__`
(which Blockly media/flyout URLs read) and pass the real
`/bot/preview/` base from `app-store.ts` (`isPreviewMode()`).

**Remote `@import` in built CSS.** Vendored Deriv stylesheets start with
`@import "https://fonts.googleapis.com/…"`. When that request fails (slow or
blocked network), the dynamically injected `<link>` fires `error` even though
the local styles parsed, the chunk loader rejects, and the same error boundary
takes the app down. Fix: `build-dbot-builder.mjs` strips all remote `@import`
rules from the built CSS (fonts still load via the resilient `<link>` path +
brand-font fallback). Additionally `lazyWithRetry` wraps the lazy route chunks
so a single flaky fetch retries instead of killing the app.

## 2. `Cannot read properties of undefined (reading 'javascriptGenerator')`

The Run button enabled before `loadBlockly()` resolved
(`window.Blockly.JavaScript` unset). Fixes:
- `loadBlockly` is single-flight (`ensureBlocklyLoaded`) — concurrent callers
  can no longer race `./blocks` imports against each other.
- `runBot()` awaits `ensureBlocklyLoaded()` before generating code;
  `generateCode()` fails with an actionable message instead of a TypeError.
- `saveRecentWorkspace()` and the `valueInputLimitationsListener` skip when
  `Blockly`/`Xml`/generator aren't ready yet.

## 3. Builder took ~6s to open

- Boot path: `api_base.init()` (socket + OTP handshake) now starts at module
  evaluation, overlapping React mount and chunk download; the UI gate falls
  back to paint after 2.5s max (was a hard 5s timer even on success).
- Host page: the builder iframe is a persistent singleton
  (`lib/bot-builder-frame.ts`), preloaded by the app shell and MOVED into the
  Bot Builder page on visit (same-document iframe moves don't reload). Open
  time after first visit ≈ 0 (measured 0.03–0.05s adoption; background boot ≈
  1s on a warm cache vs ~6s before).

## 4. Trades land on the account enabled in the app

`/api/auth/bot-builder/session` already returns the active account + OTP
socket; the page now re-syncs the builder on mount, on account change, and
periodically, and the session bridge dedupes syncs (no reconnect storms while
an authorize handshake is in flight) and clears seeded state on disconnect.
Demo in the app → demo trades in the builder; real in the app → real trades.

## 5. Icon + chrome

- Sidebar icon: Bot → `Workflow` (lucide) so AI Bots and Bot Builder differ.
- Removed the "Deriv Bot Builder — Build and run Deriv bots…" page header.
- Builder content renders at `zoom: 0.8` (the "80" sizing ask).
- NeuroAI SpeedAI FAB is hidden on /bot-builder (it covered the builder's own
  Run cluster).

## Verification

- Headless-Chrome harness with a mock Deriv WS API: strategy loads, Run
  executes contract after contract (7+ in 30s, settle → re-buy loop), no error
  modal, no ChunkLoadError.
- Early-Run regression (Run clicked 6× during boot): no generator error.
- `test:first-paint` (marker updated to the new page shell), platform unit
  tests (22 pass), builder `tsc`, platform `typecheck` — all green.
