# Instant Bot Builder + always-visible mobile Run/Stop bar

Two connected changes: (1) opening Bot Builder must show a usable builder
immediately, (2) on phones the Run/Stop buttons must be reachable with no
scrolling and without opening the drawer first. **Desktop must not change.**

## 1. The killer bug: re-parenting an iframe reloads it

`lib/bot-builder-frame.ts` used to park the singleton iframe in a hidden holder
and MOVE it into the page on every visit (`adoptBotBuilderFrame` /
`releaseBotBuilderFrame`). Per the HTML spec a browser discards an iframe's
document whenever the element is removed from / re-inserted into the DOM, so
**every visit silently re-ran the whole builder boot** (socket handshake, chunk
downloads, Blockly injection) and killed any bot that was mid-run. Proven with
`performance.timeOrigin` + a marker on `contentWindow` before/after the move.

**Rule: never move the builder iframe in the DOM.** It now lives in a
body-level `position: fixed` host (`#bot-builder-frame-host`, id/class kept
stable) created once:

- `preloadBotBuilder()` — boots it in the background (shell mounts it).
- `showBotBuilderFrame(slot)` — positions the host over the page's empty slot
  div, tracks it with a `ResizeObserver` + capture-phase `scroll`/`resize`
  listeners, flips `visibility`/`pointer-events`/`z-index: 10`.
- `hideBotBuilderFrame()` — parks it at `translate3d(-200vw,0,0)`,
  `visibility: hidden`. **Size is never changed while hiding** (a resize makes
  Blockly re-layout for nothing).
- The 0.8 `zoom` now lives on an inner layer inside the host, not on the page.
- `predictedRect()` mirrors the shell layout (mobile 3.5rem top bar, 14/16rem
  desktop sidebar) so the background boot already happens at the final size.

`pages/bot-builder.tsx` renders only the slot; `components/layout.tsx` preloads
immediately on `/bot-builder`, otherwise on `requestIdleCallback(...,
{timeout:2000})` (1200 ms `setTimeout` fallback) so the ~2 MB of builder assets
don't compete with the page the user is actually on.

## 2. Builder-side boot gates that were removed

- `app-root.tsx`: dropped the `API_INIT_UI_GATE_MS = 2500` / `is_api_initialized`
  "Loading…" gate — `AppContent` renders as soon as the store exists.
- `app-content.jsx`: dropped the full-screen "Initializing Deriv Bot account…"
  gate that waited for `active_symbols.retrieveActiveSymbols(true)`. Init now
  runs in `useLayoutEffect`; symbols load in the background (500 ms poll) and
  when they land `app_store.refreshMarketBlocks()` re-fires `BlockCreate` for
  `trade_definition_market` blocks (and clears the contracts-for cache) so the
  dropdowns fill in place instead of remounting `Main`/`BotBuilder` — remounting
  destroyed the Blockly workspace on every account switch.
- `app-store.ts`: `refreshMarketBlocks()` action; `onMount` self-heals by calling
  `setDBotEngineStores()` when `dbot_store` is null; `registerOnAccountSwitch`
  reuses `refreshMarketBlocks` instead of toggling `is_loading`.
- `main.tsx`: `warmUpBootChunks()` prefetches `components/layout`,
  `app/app-root`, `app/app-content` and calls `ensureBlocklyLoaded()` right
  after the first render, so the lazy chunks download in parallel.

### Two races the warm-up exposed (both fixed)

- `scratch/blockly.js` — `ensureBlocklyLoaded()` returned early on
  `window.Blockly?.JavaScript?.javascriptGenerator`, which `loadBlockly()` sets
  **before** `./blocks` has registered the Deriv blocks. A second caller then
  ran ahead and `DBot.initWorkspace` died with *"Cannot set properties of
  undefined (setting 'onchange')"*. An in-flight promise now always wins, and
  the "already loaded" shortcut also requires
  `window.Blockly.Blocks.trade_definition_tradetype`.
- `pages/main/main.tsx` — the trashcan effect read the **bare** global
  `Blockly?.derivWorkspace`; optional chaining does not guard an *undeclared*
  identifier, so before Blockly lands it throws `ReferenceError: Blockly is not
  defined`. Use `window.Blockly?.…` everywhere Blockly may not be loaded yet.

## 3. Mobile bottom chrome (phones/tablets only, `@include mobile-or-tablet-screen`)

Layout, bottom-up, at any viewport:

```
closed →  [ workspace ][ handle 3.6rem ][ Run/Stop bar 6.2rem+inset ]
open   →  [ handle ][ tabs 4.8rem ][ tab content ][ stats 15.7rem ][ Run/Stop bar ]
```

Variables in `app/app.scss` (`.bot`): `--mobile-run-bar-height: 6.2rem`,
`--mobile-run-bar-total` (= height + `env(safe-area-inset-bottom)`),
`--mobile-drawer-handle-height: 3.6rem`, `--mobile-drawer-tabs-height: 4.8rem`,
`--mobile-drawer-stats-height: 15.7rem`,
`--drawer-content-height-mobile: calc(100% - handle - tabs - stats)`,
`--zindex-mobile-run-bar: 7`.

Gotchas that cost real debugging time:

- **`.dc-drawer` has `will-change: transform`**, so it is the containing block
  for its `position: fixed` children (`.run-panel__stat--mobile`,
  `.run-panel-tab__content--mobile`). Their `bottom`/`%` values resolve against
  the DRAWER, not the viewport — that is why the stats strip is `bottom: 0` and
  the tab content is `bottom: var(--mobile-drawer-stats-height)`.
- The run bar must be **above** the drawer (`popover_zindex.RUN_PANEL = 6`),
  otherwise the closed panel paints over it and swallows its taps. 7 keeps it
  below snackbars (8).
- The bar needs `bottom: 0` + `box-sizing: border-box` +
  `height: var(--mobile-run-bar-total)`: the base `.controls__section`
  `@supports (-webkit-touch-callout: none)` rule otherwise lifts it by the
  safe-area inset and the geometry no longer adds up.
- `.dc-drawer__toggle` on mobile must be `position: relative; z-index: 2`
  (it used to be `position: unset`) or the fixed tab content paints over the
  handle when the drawer is open and the arrow can no longer close it.
- Open state is `transform: translateY(calc(-100% + handle))` — a percentage of
  the drawer's own height, so the drawer's height/top formulas and this must be
  edited together.
- Don't re-add `env(safe-area-inset-bottom)` padding to the stats strip; the bar
  absorbs the inset, and the extra padding made the strip taller than
  `--mobile-drawer-stats-height`.

## 4. Verified numbers (production build, iPhone-ish 390×844, mock WS)

| scenario | before | after |
| --- | --- | --- |
| warm: shell preloaded, tap Bot Builder (slow 4G + 4× CPU) | 3.4 s, full reload | **0.6 s, no reload** (workspace + 9 blocks already live) |
| cold `/bot-builder` (slow 4G + 4× CPU) | 16.6 s | 15.4 s (bandwidth-bound; no "Initializing…" gate) |
| cold, no throttling | ~2.2 s | ~1.5 s |

Measured geometry (iframe viewport 487×985 at `zoom: 0.8`): bar `[923,985]`,
handle `[887,923]` closed / `[101,137]` open, tabs `[137,185]`, content
`[185,766]`, stats `[765,923]`. Real touch events land on
`#db-animation__run-button` with the drawer both closed and open, and on the
chevron in both states.

## 5. Test harness (not in the repo — `/home/user/.cache/harness`)

`probe.mjs` (boot timings + geometry + screenshots) and `interact.mjs` (real
`touchscreen.tap` hit-testing) driving puppeteer-core + @sparticuz/chromium with
an in-page Deriv WebSocket mock (`mock-ws.js`; outbound WS is blocked here).
Notes: puppeteer's `boundingBox()` ignores the host's CSS `zoom`, so map
in-frame rects manually (`hostRect.width / frame.innerWidth`); never benchmark
against the Vite dev host or the rsbuild dev proxy (both are wildly slower /
404 on lazy compilation) — always `pnpm build:web` + `pnpm start:web`.
