# Desk: title-bar cleanup, owner-configurable auto-trader, sticky bridge, 1R management

Four owner-reported defects, the reasoning behind each fix, and the files that
carry it. Read this before touching `title-bar.tsx`, `desk-settings.ts`,
`position-manager.ts`, `bridge-links.ts` or the EA's `OnDeinit`.

---

## 1. The top bar was three chips too wide

**Reported:** *"STREAM / V4 SHADOW / Equity $754.59 USD / Day +0.00% / Open risk
0.00% of 2% cap — they are overlapping, delete them completely."*

`title-bar.tsx` rendered, left to right: dot, `DESK`, source badge
(`data-testid="data-source"`), stream badge (`stream-status`), V4 chip, the
key-numbers block (`key-numbers`: Equity / Day / Open risk), then the controls.
At 1024–1279 px the chips plus the controls exceeded the row, so they overlapped
the mode segmented control.

**Decision:** the three informational blocks are DELETED — not hidden, not moved
behind a tooltip. Every number they carried is already rendered somewhere that
has room:

| Removed | Still visible in |
|---|---|
| `data-source` badge (MT5 LIVE/STALE/WARMING/REQUIRED) | status bar (`status-bar.tsx`) + Feed & health panel |
| `stream-status` badge (STREAM/POLL) | status bar feed counts + Feed & health |
| V4 chip | Learning workspace header + `v4` on `/desk/state` (the layer flags are the Learning panel's own empty states) |
| Equity / Day / Open risk | stat strip tiles 1–3 (every workspace except Command, which carries the same values in the pipeline/decision panels) |

The title bar keeps what acts on the whole desk: mode, timezone, Auto, the MT5
bridge button, FLATTEN — plus the new **Auto-trader settings** gear.

`scripts/desk-layout.spec.mjs` (the checked-in Playwright contract) no longer
requires `data-source` / `stream-status`; it requires the settings button
instead. `docs/mt5-live-desk-v5-ui.md` §1 constraint 4 is amended.

---

## 2. The auto-trader is now the owner's, not the constant's

**Reported:** *"a setting where the user can adjust how the auto trader takes
trades — risk per trade, modes of trailing, partial trades, SL management, and
modes of each mode (aggressive/balanced per scalp/intraday/swing). No setting
left behind, and the setting the user sets is respected by the auto trader."*

Before this change the whole management policy was compiled into
`buildManagementPlan()` in `agent.ts` — fixed partial ladders, fixed BE
trigger, fixed trail multiples, fixed time stop. The owner could change
`baseRiskPct` and nothing else.

**The model** (one definition, `lib/multiasset/desk-settings.ts`, mirrored on
the client in `src/lib/desk-settings.ts`):

```
AutoTradeSettings {
  risk:  sizing mode (percent | fixed money), amount, and every RiskPolicy
         ceiling (daily loss, drawdown, positions, exposure, halt streak,
         margin, cooldown, live enable)
  perMode: { scalp | intraday | swing }: ModeSettings {
    style: conservative | balanced | aggressive | custom
    riskPct: the per-trade budget for THIS mode
    management: ManagementSettings
  }
}

ManagementSettings {
  breakeven  { enabled, triggerR, offsetR, requireStructure, structureFallbackR }
  partials   { enabled, rungs: [{ atR, closePct }] }   // 0–4 rungs
  trail      { enabled, mode: atr_chandelier | structure | fixed_points,
               period, mult, activateAtR, stepPoints, minStepAtr }
  pyramid    { enabled, maxAdds, addAtR, sizeRatio, requireBaseAtBreakeven,
               portfolioRiskCapR }
  timeStop   { enabled, noProgressBars, timeframe }
  guards     { maxSpreadPoints, newsBlackoutMin, flatBeforeSessionClose }
}
```

Every field is:
* **validated** — `sanitiseAutoTradeSettings()` clamps each number to its own
  documented range, drops unknown keys, and never throws. A typo cannot widen a
  risk limit.
* **preset-driven** — `MANAGEMENT_PRESETS[mode][style]` gives all three modes a
  conservative / balanced / aggressive policy that is *mode-specific* (a scalp
  aggressive is not an intraday aggressive). Picking a preset copies the whole
  policy into the mode, flipping `style` to `"custom"` only when a field is then
  hand-edited.
* **honoured on the wire** — `resolveManagementSettings(settings, mode)` feeds
  `buildManagementPlan()`, so the `management` block on the armed plan IS the
  owner's policy. The plan is what the EA captures at arm time
  (`CaptureManagement`), so a filled position follows the settings that were in
  force when it was armed.
* **honoured mid-trade** — changing settings enqueues `set_management` for every
  open position (`desk-settings-runtime.ts` → `pushManagementToPositions`), and
  the sync path re-pushes whenever a position's policy version differs from the
  settings version the desk last sent. That is what makes a change to trailing
  or partials affect a position that is already open.
* **remembered** — persisted in `desk_settings` (session-scoped), so a deploy or
  an API restart does not silently revert the desk to the factory policy.

---

## 3. The bridge may only end for two reasons

**Reported:** *"our desk disconnects itself from the MT5 at times; keep the
connection until the user closes MT5, or disconnects the account from the desk.
Nothing else."*

The engine that used to drop it, and what happens now:

| Cause | v3.08 | now |
|---|---|---|
| 120 s without a heartbeat (lease sweep) | tokens revoked, account claim released, pairing code retired, desk terminal cleared | **link kept.** Marked stale (the Desk already renders `MT5 STALE`); the token, the code and the claim all survive. A long MT5 sleep, a laptop lid, a weekend market close — nothing ends the link. |
| `OnDeinit` — `REASON_CHARTCLOSE`, `REASON_INITFAILED`, `REASON_ACCOUNT` | `POST /bridge/disconnect` | **no disconnect.** Only `REASON_CLOSE` (the terminal itself is going down) ends it. |
| EA reload / recompile / symbol change | re-paired from the live code | unchanged, plus the saved link resumes it |
| API redeploy | link ended if the terminal was closed, or if the store (PGlite) was wiped | the terminal **re-adopts its saved link**; the server accepts a *signed resume* (`bridge-resume.ts`) even when the row is gone |
| Store unreadable | 503 — retry | unchanged (503 never revokes) |
| Unverified 401 | the EA treated it as final | only an explicit `bridge_link_revoked` (the user pressed Unlink) is final. Everything else retries forever with backoff. |

The terminal-side link file is back (`NeurotradeBridge_<login>_<server>.link`),
but it is now a **resume credential, not a bearer token**: it holds
`sessionId|account|code|issuedAt` and an HMAC over them with a server secret.
It is deleted when — and only when — the Desk answers "unlinked".

---

## 4. At 1R something must actually happen

**Reported:** *"trade management is not that good — we may be 1R in profit and
nothing happens: no SL adjustment, no partials."*

Three real defects, not one:

1. **Structure confirmation could defer break-even forever.** `beStructure`
   required a confirmed fractal pivot AND a closed bar beyond entry. On a fast
   frame that can simply never occur, so a position sat at +1.5R with its
   original stop. Now: `structureFallbackR` (default `+0.35R` past the trigger,
   configurable, `0` = never fall back). Past it, the stop moves on the R
   trigger alone and the event says why (`structure_deferred`). Implemented in
   `position-manager.ts` and in the EA's `ManageOnePosition()`, pinned by the
   same golden vectors.
2. **A rung that cannot be split silently disappeared.** `buildManagementPlan`
   filtered out any partial the broker's volume step could not express, so on a
   0.01-lot position the ladder was empty and nothing de-risked at 1R. Now the
   first rung is *mapped to the stop* instead: if the volume cannot be split,
   break-even moves down to the first rung's R (with `offsetR` retained) so the
   trade still de-risks at the same point — and the reason is recorded on the
   plan (`partialsDeferredToBreakeven: true`).
3. **Nothing ever pushed a policy to an existing position.** `set_management`
   existed in the EA and was never sent by the server, so a position opened
   before a settings change — or defaulted by `PsApplyDefaults` — kept the old
   (or default) policy. The desk now pushes it (see §2).

`PsApplyDefaults()` in the EA — the policy for a position with no plan — also
gains a default ladder now, so an orphaned position is not the one position in
the terminal with no partials at all.

---

## Status — SHIPPED (implementation complete, all checks green)

Everything in this document is implemented on both sides and verified. The
summary, in the same order as the four requests:

1. **Title bar** — the informational blocks are deleted (not hidden), the
   surviving controls keep their testids, `open-settings` is added, and
   `scripts/desk-layout.spec.mjs` now asserts the deleted chips are absent.
2. **Auto-trader settings** — `desk-settings.ts` (model + sanitiser + presets +
   bounds), `desk-settings-store.ts` (`desk_settings` table), the runtime's
   `adoptSettings` / `reconcileManagement` / `managementForPosition`, the
   settings dialog (`auto-trader-settings.tsx`, opened from the title bar), and
   the terminal half: EA v3.09 note 33–34 makes the break-even offset and all
   three trailing styles the owner's, and the trail mode is stored in the
   position record (`v3`, 31 fields; `v1`/`v2` still decode).
3. **Bridge persistence** — the link ends only on `/unpair` (revoked; the one
   final answer) or a terminal close (`REASON_CLOSE` only). Silence is display
   only: `sweepExpiredLinks()` returns 0, the token, code and account claim all
   survive, and the EA saves/re-adopts its credential per MT5 account. New
   contract doc: `docs/mt5-bridge-link-lifetime.md`; the v3.08 doc is kept with
   a historical banner.
4. **Management at 1R** — the float-dust `progressR` bug, the structure
   deadline, the unrunnable-ladder fallback and the no-plan default, all
   implemented in `position-manager.ts` (server) and mirrored in the EA.

Verification: root `pnpm run typecheck` clean (libs first), root `pnpm test`
green — api-server 1230/1230 in 149 suites, trading-platform 97/97 —
`check:first-paint` all 8 routes pass, and the live API on `:8080` serves
`autoTradeSettings` + `autoTradeBounds` (28 keys) + `autoTradePresets` on
`GET /desk/state` with a working `POST /desk/settings` (a preset change was
applied server-side and reverted).

Release note: `docs/release-notes/mt5-desk-four-changes.md`.
