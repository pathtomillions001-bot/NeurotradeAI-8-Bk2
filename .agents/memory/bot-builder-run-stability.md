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

---

# Round 2 — transactions lost on Stop, Stop bricking Run, and first paint

Three further defects, each traced to a concrete root cause. Each has a jest
regression test that was confirmed to FAIL against the pre-fix code.

## 6. Transactions vanished on Stop while the journal survived

`TransactionsStore` never persisted anything. Two independent bugs:

- **Constructor ordering.** It called `registerReactions()` BEFORE
  `makeObservable()`, so the session-storage writer's data function read
  `this.elements` while it was still a plain (non-observable) array. MobX
  tracked nothing and the reaction never fired. `JournalStore` registers its
  reactions after `makeObservable` — which is precisely why the journal
  survived a reload and the transactions panel did not.
- **In-place mutation.** `pushTransaction` did `unshift`/`splice` on the inner
  array then `this.elements = { ...this.elements }`. The inner array kept the
  same reference, so `reaction(() => this.elements[loginid])` saw no change
  after the very first contract. Now builds a new array.

Also: there was no restore-on-`loginid` reaction (JournalStore has one with
`fireImmediately`), so a loginid resolving after construction showed an empty
panel. Added `restoreStoredTransactions()`, which never clobbers live in-memory
rows with a staler cache snapshot. `elements` default changed `[]` → `{}` (it
is keyed by loginid). Reset (`clearStat`) remains the only path that wipes
history, and `clear()` now reassigns `elements` so the cache is emptied too.

Test: `src/stores/__tests__/transactions-store.spec.ts` (5 tests, 4 failed
pre-fix).

## 7. Stop bricked Run permanently ("click Stop, then nothing works")

`api_base.is_stopping` gates BOTH `dbot.runBot()` and `dbot.stopBot()`. The
chain that pinned it at `true` forever:

`ticksService.forget()` rejects (routine while stopping — Deriv says "already
forgotten") → `unsubscribeFromTicksService()` rejects → `terminateSession()`
had `.then()` but no `.catch()`, so it neither resolved nor rejected →
`stop()`'s `terminateSession().then(() => { is_stopping = false; resolve(); })`
never ran → `is_stopping` stuck `true` and `stop()` never settled →
`dbot.stopBot()` hung at `await this.interpreter.stop()` and never recreated
the interpreter → every later Run and Stop early-returned at
`if (api_base.is_stopping) return`.

Fixes: `unsubscribeFromTicksService` always resolves; `terminateSession`
swallows forget failures; `stop()` routes every branch through an exactly-once
`settle()` that clears `is_stopping`, plus a 10 s watchdog because the
multiplier branch waits for a `contract.sold` that may never arrive;
`dbot.stopBot()` wraps stop in try/finally so the interpreter is always
recreated.

Knock-on bug found by the test: `observer.unregister(event, f)` threw
`Cannot read properties of undefined (reading 'filter')` for an event nobody
registered on — so a defensive cleanup call crashed the stop path. Now guarded.

Test: `.../tradeEngine/utils/__tests__/interpreter-stop.spec.js` (4 tests, all
4 TIMED OUT pre-fix — direct proof stop() never settled).

## 8. "Sorry for the interruption" replaced the builder

`ErrorBoundary` implemented only `componentDidCatch` and never cleared
`hasError`, so ANY render error permanently swapped the whole app for the
Refresh screen, killing a running bot with it. Now uses
`getDerivedStateFromError`, self-heals on the next tick, and only stays on the
error screen after 3 failures within 10 s (a real crash loop — recovering
there would re-throw forever). Giving up also cancels the pending recovery
timer, or it would un-latch immediately afterwards.

Test: `src/components/error-component/__tests__/error-boundary.spec.tsx`
(driven at lifecycle level: React 19 auto-retries a failed *initial* render
before the boundary sees it, so a render-level probe cannot distinguish a
self-healing boundary from a latching one).

## 9. First paint downloaded ~5 MB

Two causes:

- **Blockly was in the initial chunk.** `scratch/blockly.js` had a static
  `import * as BlocklyJavaScript from 'blockly/javascript'` at module top
  level. `dbot.js` imports that file synchronously, so the one static line
  dragged the whole Blockly core into the initial chunk group — a 1.7 MB
  `<script defer>` plus a 2.3 MB render-blocking stylesheet — even though
  `import('blockly')` below it was meant to keep Blockly lazy. Moved into
  `loadBlockly` as a parallel dynamic import. Initial JS: 855 KB → 699 KB gz;
  Blockly now lands in async chunks.
- **Nothing was compressed.** `serve-production.mjs` piped raw bytes;
  `serve-handler` has no compression option. Added gzip for text-like
  extensions on both the bot-builder and SPA paths, with `Vary:
  Accept-Encoding`, falling through to serve-handler for SPA rewrites/404s.

Measured on the built output through `serve-production.mjs`: bot builder
initial payload 4.38 MB → 701 KB; SPA bundle 1.48 MB → 399 KB.

Test: `.../scratch/__tests__/blockly-load.spec.js` asserts the lazy import
still yields `window.Blockly.JavaScript.javascriptGenerator` and that
`workspaceToCode` works through the exact path `dbot.generateCode()` uses.

## Jest infra

`moduleNameMapper` had no `@/preview` alias, so `config.ts`'s import of
`@/preview/session-bridge` failed to resolve and **9 suites never ran**. Added
the alias (plus `@remix-run/route-pattern` to `transformIgnorePatterns` for
react-router@8's ESM). 45/46 suites now run and pass; the remaining
`LogoMark.spec.tsx` failures are pre-existing brand drift (tests expect
"Deriv Trading Bot"/"D" badge, `brand.config.json` says `platform.name:
"NeuroTrade"`, `logo_path: null`) that the resolution error had been masking.
