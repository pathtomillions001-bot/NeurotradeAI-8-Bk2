# Fix: Paired Edge DBot refused to run, desktop results drawer, phantom "back online" dialog

Three defects in the embedded Deriv bot builder (`artifacts/dbot-builder`), each
traced to a concrete root cause and covered by a regression test.

---

## 1. "The Purchase block is mandatory and cannot be deleted/disabled."

### Symptom

Paired Edge Architect scans a market, **Create DBot** loads the generated
strategy into the builder, and **Run** immediately logs that error in the
Journal. No contract is ever bought.

### Root cause

The Paired Edge strategy does not use Deriv's stock `purchase` block. It buys
two digit rails (Over + Under) as **one atomic basket** through our custom
`purchase_pair` block — that is the whole point of the strategy: the pair must
be sent together and settled together, which two independent `purchase` blocks
cannot guarantee.

The builder's pre-run gate (`DBot.checkForRequiredBlocks()` →
`isAllRequiredBlocksEnabled()`) checks the workspace against
`config().mandatoryMainBlocks = ['trade_definition', 'purchase',
'before_purchase']` with a literal block-type comparison. `purchase` is absent
by design, so the gate reported it missing and refused to start the bot.

A second, latent bug would have bitten right after: the interpreter registers
`Bot.purchase` and `Bot.sellAtMarket` as **async** pseudo-functions
(`createAsync`) but `Bot.purchasePair` only came through the plain
`nativeToPseudo(bot_interface)` conversion. The interpreter would not have
waited for the two buys to be acknowledged and the purchase-conditions stack
would have spun while the basket was still in flight.

### Fix

- New `mandatoryBlockAlternatives` map in `bot-skeleton/constants/config.ts`:
  `{ purchase: ['purchase_pair'] }`.
- New `bot-skeleton/utils/mandatory-blocks.ts` — the single place that knows
  about stand-ins (`getMandatoryBlockFamily`, `expandMandatoryBlockTypes`,
  `isMandatoryBlockPresent`).
- `scratch/utils/index.js`: `getMissingBlocks`, `getDisabledBlocks`,
  `getAllRequiredBlocks` and `validateErrorOnBlockDelete` are now family-aware.
  A mandatory block counts as *disabled* only when every member of its family is
  present and disabled, so a genuinely disabled block is still caught.
- `utils/workspace.js#hasAllRequiredBlocks` uses the same rule.
- `utils/error-config.js` gained a `purchase_pair` message ("Paired purchase"),
  so if the block ever *is* missing/disabled the log names the right block.
- `tradeEngine/utils/interpreter.js` binds `purchasePair` with `createAsync`,
  exactly like `purchase`.

### Tests

- `src/preview/__tests__/turbo-dbot-strategy.spec.js` — loads the real Paired
  Edge fixture into the real Blockly workspace and asserts
  `isAllRequiredBlocksEnabled()` is `true` with **no** `ui.log.error` emitted
  (fails against pre-fix code), plus a negative control: delete the
  `purchase_pair` blocks and the gate must still fail.
- `src/external/bot-skeleton/utils/__tests__/mandatory-blocks.spec.ts`.

---

## 2. Results drawer: bottom sheet on desktop

### Symptom

The mobile work ("Run/Stop always visible, handle raised above it") landed
correctly on phones, but desktop got the same bottom sheet instead of the
right-hand drawer.

### Root cause

Every layout decision — `useDevice().isDesktop`, the `mobile-or-tablet-screen`
SCSS mixin, `desktop-screen` — is `min-width: 1280px`. The builder renders
inside the NeuroTrade shell's iframe, which on a normal laptop is the window
width minus the app sidebar, i.e. routinely **under 1280px**. Desktop users
therefore matched the phone branch of both the markup and the stylesheet.

### Fix

Layout now keys off what actually matters — room for a docked drawer **and** a
precise pointer — through one shared hook, with the stylesheet driven by the
classes that hook sets (never by a second, independent media query):

- `src/hooks/useRunPanelLayout.ts` — `RUN_PANEL_SIDE_LAYOUT_QUERY =
  '(min-width: 768px) and (pointer: fine)'`, returning `is_side_layout` /
  `is_sheet_layout` and re-evaluating on viewport changes.
- `shared_ui/drawer` sets `dc-drawer--side` / `dc-drawer--sheet`; `drawer.scss`
  replaced its `mobile-or-tablet-screen` blocks with those classes. The mobile
  sheet geometry (handle at `100% - 11.4rem`, above the Run/Stop bar) is byte
  for byte the same — phones are unchanged.
- `run-panel`, `summary`, `transactions` and `journal` consume the same hook
  instead of `isDesktop`.
- Desktop drawer width trimmed **366 → 293px** (the "100 → 80" ask):
  `RUN_PANEL_DESKTOP_WIDTH`, `.run-panel__container` (29.3rem),
  `--bot-content-width`, and the dashboard's translate vars (294px).
- `dashboard.scss`'s `@include desktop-screen` open-state rule became
  `.dc-drawer--open.dc-drawer--side`.

### Test

`src/components/shared_ui/drawer/__tests__/drawer-layout.spec.tsx` — side layout
on a roomy mouse viewport (right anchor + inline translate), sheet layout
otherwise.

---

## 3. "You're back online / The bot has stopped… check it on the Reports page"

### Symptom

The dialog appeared while online, sometimes right after pressing Run, and its
"Go to Reports" button navigated to a page NeuroTrade does not have.

### Root cause

`pages/main/main.tsx` treated **any** status other than `OPENED` as a
disconnect:

```js
if (connectionStatus !== CONNECTION_STATUS.OPENED) { … setWebSocketState(false); }
```

`connectionStatus$` is seeded with `UNKNOWN` before the first connection is even
attempted, and every routine socket refresh emits a momentary `CLOSED`. Nothing
ever set `is_web_socket_intialised` back to `true`, and `<BotStopped />`
rendered purely off `!is_web_socket_intialised` — so one blip pinned the dialog
open for the rest of the session.

### Fix

- `src/utils/connection-state.ts` — `getConnectionAction(status)` returns
  `online` (clear the flag), `pending` (boot; do nothing) or `maybe-offline`
  (closed).
- `main.tsx` clears the offline flag on `OPENED`, ignores `UNKNOWN`, and only
  stops a running bot if the socket is still closed after a 2.5 s grace period
  — a reconnect inside that window never touches the run.
- The dialog is gone: `components/bot-stopped.tsx` deleted, removed from
  `app-content.jsx`, dead styles removed from `main.scss`. A real, sustained
  disconnect now writes a Journal line instead: *"Connection lost. The bot was
  stopped — check your open contracts before running it again."* — no dead link.

### Test

`src/utils/__tests__/connection-state.spec.ts`.

---

## Verification

- `npx jest` in `artifacts/dbot-builder`: 49/50 suites pass; the only failures
  are the pre-existing `LogoMark` brand-drift assertions documented in
  `.agents/memory/bot-builder-run-stability.md`.
- `npx tsc --noEmit` clean; `npm run build` (rsbuild) succeeds, so every SCSS
  change compiles.
