# The auto-trader's settings — what each knob does, and where it is enforced

The owner's requirement was: *"the user must be able to adjust how the auto
trader takes trades — risk per trade, trailing, partials, stop management, and
how aggressive each mode is — and the auto trader must respect it. No setting
left behind."*

The model lives in `artifacts/api-server/src/lib/multiasset/desk-settings.ts`
(one home per number), is stored per Desk session in `desk_settings`
(`lib/db/src/index.ts`, `lib/db/src/schema/desk.ts`), is exposed by
`GET /desk/state` and edited through `POST /desk/settings`, and is rendered by
`artifacts/trading-platform/src/components/desk/auto-trader-settings.tsx`
(one input per field, bounded by the server's own `autoTradeBounds` table).

Three rules the implementation obeys:

1. **Sanitise, never throw.** Every number is clamped to its range, every enum
   matched against its allowed set, unknown keys dropped. A malformed request
   can only produce a *tighter* policy.
2. **Presets are mode-specific.** Three modes × three stances = nine policies.
   A preset is applied BY THE SERVER (the client sends the style, not the
   numbers); hand-editing any field flips the mode's stance to `custom`.
3. **Open positions obey a change.** `POST /desk/settings` adopts the new policy
   and `reconcileManagement` enqueues `set_management` for every position whose
   fingerprint changed; the heartbeat re-checks fingerprints, so nothing has to
   be closed and re-opened.

## Where each setting is enforced

| Setting | Range | Enforced by |
| --- | --- | --- |
| `risk.sizingMode`, `riskPerTradePct`, `riskPerTradeMoney` | percent 0.05–2, money 1–1e6 | server sizing (`sizing.ts`) at plan creation |
| `perMode.*.riskPerTradePct` | 0.05–2 | server sizing, overriding the desk-wide budget |
| `risk.maxRiskPct` | 0.1–5 | server sizing ceiling |
| `risk.maxDailyLossPct` | 0.5–10 | server risk state — halts the day |
| `risk.maxDrawdownPct` | 1–30 | server risk state |
| `risk.maxOpenPositions`, `maxPositionsPerSymbol` | 1–50, 1–10 | server risk gates at arm time |
| `risk.maxCurrencyExposurePct` | 0.5–20 | server currency exposure gate |
| `risk.haltAfterConsecutiveLosses` | 2–20 | server risk state |
| `risk.minMarginLevelPct` | 150–5000 | server risk gate on the terminal's account snapshot |
| `risk.symbolCooldownMs` | 60 s–24 h | server risk state (per symbol) |
| `risk.liveTradingEnabled` | bool | server `limits.liveTradingEnabled` → the EA refuses live orders |
| `breakeven.enabled` | bool | plan: `breakeven: null` when off |
| `breakeven.triggerR` | 0.2–10 | server state machine + EA `ManageOnePosition` |
| `breakeven.offsetR` | 0–2 | the stop lands at `entry ± (round-trip cost + offsetR × R)` in both |
| `breakeven.requireStructure` | bool | structure gate in both |
| `breakeven.structureFallbackR` | 0–2 | deadline: the stop moves on R alone past `triggerR + fallback`; 0 = never |
| `partials.enabled`, `rungs[].atR`, `.closePct` | 0.2–10R, 5–100%, ≤4 ascending rungs | plan ladder → EA ladder; rungs the broker cannot split are folded into the break-even trigger |
| `trail.enabled` | bool | plan: `trail: null` when off |
| `trail.mode` | atr_chandelier / structure / fixed_points | EA branches on all three (v3.09 note 33) |
| `trail.period`, `trail.mult` | 2–200, 0.5–10 | ATR handle + distance |
| `trail.activateAtR` | 0.2–10 | trail arming on R |
| `trail.stepPoints`, `trail.minStepAtr` | 0–5000, 0–1 | minimum meaningful step; the Desk folds both into one step and the terminal no longer forces its own floor |
| `pyramid.enabled`, `maxAdds`, `addAtR`, `sizeRatio`, `requireBaseAtBreakeven`, `portfolioRiskCapR` | 0–5, 0.5–10R, 0.1–2, 0.1–10R | server state machine + EA pyramid block |
| `timeStop.enabled`, `noProgressBars`, `timeframe` | 1–500 bars, entry frame when unset | server state machine + EA time stop |
| `guards.maxSpreadPoints` | 1–100 000, `null` = derive from the asset's cost | plan spread guard at fill |
| `guards.newsBlackoutMin` | 0–240 | red-folder blackout on both sides |
| `guards.flatBeforeSessionClose` | bool | session-close flatten (scalp/intraday by default) |

## Reading and writing

```
GET  /desk/state      → autoTradeSettings, autoTradeBounds (RANGES), autoTradePresets (labels)
POST /desk/settings   → { autoTradeSettings: { … } }   (patch; server sanitises)
                      → { perMode: { scalp: { style } } }   (preset applied server-side)
                      ← { autoTradeSettings, autoTradeBounds, autoTradePresets, managementPushedTo }
```

`managementPushedTo` lists the tickets whose policy was re-sent, so the UI can
say *"saved — pushed to 2 open positions"* instead of leaving the user to guess
whether a change reached a live trade.

## Tests

* `artifacts/api-server/src/lib/multiasset/desk-settings.test.ts` — S1–S21:
  ranges, enums, unknown keys, preset adoption, `custom` promotion, fingerprints.
* `artifacts/api-server/src/lib/multiasset/position-manager.test.ts` — the same
  rules applied to a position, including the structure deadline.
* `artifacts/trading-platform/src/lib/ea-bridge-resilience.test.ts` — the
  terminal half: the break-even offset is the owner's, all three trail modes
  exist, and the record carries the mode across restarts.
