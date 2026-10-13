# Change: the four Desk requests — no title-bar noise, a real settings surface, a bridge that stays connected, and management that actually fires

Four things were asked for, in the user's words:

1. delete the overlapping title-bar text completely;
2. an auto-trader settings surface that exposes **everything**, which the auto
   trader then **respects** (open positions included);
3. an MT5 bridge that stays connected until the user closes MT5 or unlinks the
   account — nothing else may sever it;
4. fix trade management: at ~1R in profit, the stop move / partial / trail that
   should happen did not.

---

## 1. The title bar is controls only

**Deleted, not hidden:** `data-source` (MT5 LIVE / STALE / WARMING),
`stream-status` (STREAM / POLL), the v4 layer chip and the key-numbers block
(Equity · Day % · Open risk). Between 1024 and 1279 px they overlapped the mode
control.

Every value is still on screen, one layer down:

| Deleted | Still rendered by |
| --- | --- |
| feed state | status bar + Feed & execution health |
| stream vs poll | status bar feed counts (`useDeskStream` still wins over polling) |
| v4 layer flags | Learning workspace headers; `v4` on `GET /desk/state` |
| equity / day / open risk | the stat strip (Equity, Day, Open risk, Daily loss used) |

`scripts/desk-layout.spec.mjs` now asserts that the deleted testids are **absent
even as hidden nodes**, and the surviving controls keep theirs.

## 2. The auto-trader settings surface

`[data-testid="open-settings"]` in the title bar opens
`src/components/desk/auto-trader-settings.tsx`. It renders the whole
`AutoTradeSettings` model — risk & budget, per-mode stance (conservative /
balanced / aggressive × scalp / intraday / swing), break-even, partial ladders,
trailing (three styles), pyramids, time stop and entry guards. Inputs are
bounded by `autoTradeBounds`, the server's own clamp table, shipped on
`GET /desk/state`; presets are applied **by the server** (the dialog sends a
style, the server swaps in that mode's whole policy).

Where each knob is enforced is tabulated in
`docs/mt5-auto-trader-settings.md`. The short version:

* **server** — sizing, the risk budget, daily loss, drawdown, position and
  exposure caps, cooldowns, halts, margin level;
* **server → plan → terminal** — break-even trigger/offset/structure deadline,
  partial rungs, trail mode/period/multiple/activation/minimum step, pyramid
  ladder, time stop, entry guards. The plan carries the policy at ARM time and
  `set_management` replaces it on a live position, so a change applies to trades
  that are already open.

### The terminal was reading two settings and ignoring them

`offsetR` was captured into the position state and then unused: the break-even
stop always landed at the EA's own `0.05R` constant. And every trail was a
chandelier, so choosing "structure" or "fixed points" in the UI changed nothing
inside MT5. Both are fixed in EA v3.09 (notes 33–34):

* the break-even offset is the owner's, with the constant only as a floor for a
  position the Desk has not pushed a policy to yet;
* `structure` trails the last confirmed swing beyond entry
  (`PmLastSwingStop`), `fixed_points` trails a fixed distance in points, the
  chandelier is unchanged;
* the minimum trail step is the owner's `minStepAtr`/`stepPoints` (the Desk
  folds the two into one step before sending) instead of a forced `0.1×ATR`;
* the trail mode travels in the position's saved record (`v3`, 31 fields), so a
  restart cannot quietly revert it; v1 and v2 records still decode.

## 3. The MT5 bridge persists until the user ends it

The v3.08 rule — *a link lives only as long as the terminal session* — is
overturned; `docs/mt5-bridge-link-lifetime.md` states the new contract and
`docs/mt5-bridge-session-link.md` is kept as the historical record.

* **Ending 1 — the user unlinks the terminal.** `/api/bridge/unpair` revokes.
  That `401 { code: "bridge_link_revoked" }` is the only answer the EA acts on,
  and the only place it deletes its saved credential.
* **Ending 2 — the user closes MT5.** `OnDeinit` posts `/disconnect` for
  `REASON_CLOSE` **alone**. Chart closes, EA removal, recompile, timeframe and
  account switches report nothing.
* **Silence ends nothing.** `BRIDGE_LINK_LEASE_MS` is a display window: the
  Desk shows `MT5 STALE` and pauses new entries, the sweeper returns 0, and the
  token, code and account claim all survive. A reboot, a redeploy, a database
  failover and a weekend cost the user nothing.
* **The terminal saves its link** per MT5 account
  (`NeurotradeBridge_<login>_<server>.link`, `v1|token|code`) and re-adopts it in
  `OnInit`; an empty `PairingCode` input falls back to the saved code.
* **`/status` says it in both branches** (`durable: true`,
  `linkModel: "unlink-or-terminal-close"`, `linkEndsWithTerminal: false`,
  `resumesAutomatically: true`), and the bridge dialog's copy is written from
  that — the old copy promised the opposite in the same dialog.

## 4. Trade management at 1R

Four causes were found and fixed; the first is the one that made "1R and nothing
happens" literally true.

1. **Float dust.** `progressR` was `0.9999999999999787` on a trade exactly 1R
   up, so a `>= 1.0` trigger did not fire. R is now rounded to 6 dp before any
   comparison, in the server's state machine and pinned by golden vectors.
2. **A structure confirmation with no deadline.** Break-even waited for a
   confirmed swing that on a fast frame may never print. `structureFallbackR`
   (default 0.35R, 0 = wait forever, per mode in the settings) moves the stop on
   the R trigger alone once the deadline passes, and the journal says it was the
   deadline rather than structure.
3. **A ladder the broker cannot split.** On a minimum-lot account every rung was
   filtered out. The first rung's R now becomes the break-even trigger, so the
   trade still protects itself at the point the owner meant
   (`partialsDeferredToBreakeven`).
4. **A position with no plan had no policy at all.** `PsApplyDefaults` now
   seeds a 1R/50% rung and the default deadline, so the orphaned position is not
   the one with nothing scheduled — until the Desk pushes the owner's own policy
   on the next heartbeat.

The same break-even/default/record changes are mirrored in the terminal, and the
golden vectors that asserted "no action at ≥1R without a confirmed pivot" were
rewritten rather than kept: that behaviour was the defect.

---

## Verification

* `artifacts/api-server` — `desk-settings.test.ts` (S1–S21),
  `position-manager.test.ts` (31), `mt5-bridge-session.test.ts` (17), plus the
  agent / store / claims / account-claims / ea-contract / v5-ui suites.
* `artifacts/trading-platform` — 97 tests, including the EA source contracts
  (`ea-bridge-resilience`, `ea-download-parity`, `ea-tf-index-safety`) that pin
  the link lifetime, the record version and the terminal's fidelity to the
  owner's settings.
* `pnpm run typecheck` (libs first) and `pnpm test` at the root.
* `scripts/desk-layout.spec.mjs` — 1440×900 / 1024×768 layouts, overflow,
  panel bands, tab keyboard behaviour, and the title-bar testid set.
