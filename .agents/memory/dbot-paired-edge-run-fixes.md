---
name: DBot paired-edge run gate, run-panel layout, offline dialog
description: Why the Paired Edge DBot refused to run, how the run-panel layout is decided, and the false "back online" dialog.
---

# Paired Edge run gate + run-panel layout + offline dialog

## Mandatory-block stand-ins (the "Purchase block is mandatory" error)
`config().mandatoryMainBlocks` requires a literal `purchase` block. Paired Edge
uses the custom atomic `purchase_pair` block instead, so the pre-run gate
(`DBot.checkForRequiredBlocks` → `isAllRequiredBlocksEnabled`) reported it
missing and refused to run. Stand-ins now live in
`config().mandatoryBlockAlternatives` (`{ purchase: ['purchase_pair'] }`) and
are resolved through `bot-skeleton/utils/mandatory-blocks.ts`. **Any new custom
block that replaces a mandatory Deriv block must be registered there**, plus an
`error-config.js` entry so its log names the right block.

Related: every `Bot.*` call that returns a promise MUST be registered with
`createAsync` in `tradeEngine/utils/interpreter.js` (`purchase`, `sellAtMarket`,
now `purchasePair`). Blocks bound only via `nativeToPseudo(bot_interface)` do
not suspend the interpreter, so the purchase-conditions stack spins while the
buy is in flight.

## Run-panel layout: never use the 1280px device breakpoint
`useDevice().isDesktop`, the `mobile-or-tablet-screen` mixin and
`desktop-screen` are all `min-width: 1280px`. The builder runs inside the
NeuroTrade iframe, which on a laptop is narrower than that, so desktops got the
phone bottom-sheet. Layout is now decided by `src/hooks/useRunPanelLayout.ts`
(`(min-width: 768px) and (pointer: fine)`), and the stylesheet keys off the
`dc-drawer--side` / `dc-drawer--sheet` classes that hook sets — one source of
truth for JS and CSS. Docked desktop width is `RUN_PANEL_DESKTOP_WIDTH = 293px`
(mirrored by `.run-panel__container`, `--bot-content-width`, and the dashboard
`--translate-panel-*` vars).

## Connection status is tri-state, not boolean
`connectionStatus$` starts at `UNKNOWN` and emits a momentary `CLOSED` on every
routine socket refresh. Treating "not OPENED" as offline latched
`is_web_socket_intialised = false` forever and kept the "You're back online /
Go to Reports" dialog up while online (and NeuroTrade has no Reports page). Use
`utils/connection-state.ts#getConnectionAction`: `online` clears the flag,
`pending` does nothing, `maybe-offline` stops the bot only after a 2.5s grace
period and logs to the Journal. The dialog component was deleted.
