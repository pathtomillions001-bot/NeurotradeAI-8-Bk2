# MT5 Live Desk v5 — the one-screen Desk (UI programme)

This document is the running record of the v5 UI programme: the plan, the
assumptions, the panel-to-data-source map, how to run the checks, and the known
gaps. v5 changes **the screen around the data** — behaviour, APIs and trading
logic stay as v4 shipped them (`docs/mt5-live-desk-v4.md`).

Scope: `artifacts/trading-platform/src/pages/terminal.tsx`,
`src/components/desk/**` (new), `src/components/terminal/panes.tsx` (removed),
`src/pages/learning.tsx` (removed, folded into the Desk), `src/lib/desk.ts`,
`src/lib/desk-ui.ts` (new), `src/components/layout.tsx`, `src/App.tsx`, plus
small **additive, optional** API fields in `artifacts/api-server`
(`routes/desk.ts`, `lib/multiasset/presenter.ts`, `lib/multiasset/governance.ts`,
`lib/multiasset/governance-runtime.ts`). The Deriv engines, the bot-builder and
the MT5 EA are not touched.

## 1. What v5 is

One terminal-style dashboard at `/terminal` with four workspaces selected by
`?tab=`:

| Tab | Contents |
| --- | --- |
| **Command** | pipeline strip (L0–L6), Opportunities, Decision, Risk & safety, Positions & armed plans, Red-folder calendar |
| **Markets** | Broker market universe, Live scanner, Auto-select, Feed & execution health |
| **Learning** | Agent governance, Calibration, This week, Regime state, Why trades were refused, Safety rules & rollout, Learning journal |
| **Journal & performance** | Closed trades (+CSV export), By symbol / By agent, Decision journal |

`/learning` keeps working as a route and redirects to `/terminal?tab=learning`.
The sidebar's Learning item is removed.

**Hard constraints honoured:**

1. **No market or asset charts anywhere on the Desk.** `Sparkline`,
   `EquityCurve`, the client's `deskApi.series`/`DeskSeries`/`Bar` and every
   `sparkline` read are deleted. Markets render as numbers only. The only bars
   are small horizontal meters (limit meters, e-value bars, regime split bar,
   calibration bars) — not market charts. Calibration is a table with bars.
2. Learning is a workspace of the Desk, not a page. `src/lib/learning.ts` and
   its tests stay exactly as they are; the Learning workspace uses them.
3. No server behaviour change. The API additions in §3 are optional response
   fields computed from values the server already holds, each with a unit test.
4. Every existing `data-testid` survives: `data-source`, `stream-status`,
   `mode-scalp`, `mode-intraday`, `mode-swing`, `timezone-select`,
   `auto-trade-toggle`, `open-bridge`, `kill-switch` — plus `arm-plan`,
   `auto-select-report`, `watchlist-row-*` and `scan-row-*` for parity.
5. The live wiring is unchanged: `useDeskStream` and the react-query keys
   `["desk-state"]`, `["desk-markets"]`, `["desk-instruments"]`,
   `["desk-performance"]`, `["desk-analysis", symbol, mode]`,
   `["desk-scan", mode, watchlist]`, `["desk-governance"]`, `["desk-weekly"]`,
   `["desk-journal", kind]`, `["desk-regime"]` with their refetch intervals.
   The stream still beats polled data (`stream.x ?? query.data`). Learning
   endpoints 404-ing while the v4 flags are off is the normal "not available"
   state, rendered as an empty state — never an error toast, never zeros.
6. Safety behaviour is unchanged: FLATTEN, Resume-agent (reason ≥ 3 chars),
   Resume-symbol and Arm keep their mutations, confirmations and error paths.
   Arm is disabled whenever the decision is not armable.
7. No new dependencies.
8. Accessibility floor: 2px cyan `:focus-visible` ring scoped to `.desk-root`;
   every state carries a word or icon (colour is never the only signal); the
   workspace tabs are a real `tablist` with arrow-key navigation;
   `prefers-reduced-motion` disables every transition; no decorative animation.

## 2. The frame (the anti-misalignment contract)

All numbers live in **one** module, `src/components/desk/desk-layout.ts`, and
panels read from it. A pure layout-contract test
(`src/components/desk/desk-layout.test.ts`) proves the placements tile each
workspace grid exactly (no overlap, no gap, spans within 1–12) and that every
table height used is one of the documented set.

```
main area (the app's own sidebar stays as-is)
├─ title bar        48px
├─ workspace tabs   40px
├─ work area        1fr   (padding 12px)
│   ├─ alert strip  32px  (optional, one slot, most severe first)
│   ├─ context strip 60px (pipeline on Command; 8-tile stat strip elsewhere)
│   └─ panel grid   12 cols, 12px gaps, rows per workspace in fr
└─ status bar       28px
```

* Rows: 2-row workspaces `1fr 1fr`; Learning `250fr 214fr 200fr`; Command at
  1024–1279px `1fr 1fr 1fr` (see §6).
* Below **800px of viewport height** the work area scrolls vertically and rows
  get `min-height: 300px`; panels never overlap (CSS in `desk.css`).
* Panel: flex column, `min-width/min-height 0`, `overflow hidden`, 1px
  `--desk-line` border, radius 6px, bg `--desk-s1`. Header exactly 36px
  (padding 0 12px, gradient `--desk-s2 → --desk-s1`, title 12/600). Body
  `flex:1; min-height:0; overflow:auto` — **the only thing that ever scrolls is
  a panel body**.
* Documented height set: table header 24; rows 28 (refusals 29, scanner/regime
  30, universe 32, auto-select & closed trades 34 — each table picks ONE row
  height); sub-headers 28; footers 34; risk rows 44; calendar rows 40;
  opportunities rows 48; governance rows 40; search row 44. Every table defines
  its `grid-template-columns` ONCE in `desk-layout.ts` and applies the same
  value to header and rows; numbers right-aligned, labels left-aligned.
* Design tokens are CSS variables scoped to `.desk-root` in
  `src/components/desk/desk.css` (colours exactly as the brief; Inter;
  `font-variant-numeric: tabular-nums slashed-zero` for every number). Global
  theme variables are not edited.

## 3. WP1 — data audit and the additive API fields

Every figure the design needs was traced to a field in `AgentDecision`,
`ScanRow`, `DeskStateResponse`, `GovernanceAgent`, `WeeklyReport`, `RegimeRead`,
`DeskPerformance` or the existing `/execution` endpoint. The audit result:

| Design element | Source (already on the wire) |
| --- | --- |
| Verdict, quality caption | `decision.armed`, `qualityScore`, `qualityThreshold` |
| Win probability | `decision.winProbability` (top-level, blended) — mirrored as optional on the client |
| Reward : risk at fill | `decision.monteCarlo.rewardRisk` (IS `rrFill`, see `agent.ts` §5a) |
| Cost / vol | `decision.gatekeeper.costOverSigma` (v4) · `decision.costR` (legacy) |
| Per-gate pass/fail list | `decision.gatekeeper.reasons[]` (`code,label,pass,value,threshold,detail`) |
| Edge floor | `decision.gatekeeper.evLcbR` / `requiredEvLcbR` |
| Win-probability lower bound | `decision.sizingProbabilityLowerBound` |
| Order style | `plan.triggerType` |
| Regime label/probability, split bar, dwell, break risk, permits | `GET /desk/regime` → `RegimeRead` (`posterior`, `expectedDwellBars`, `changeProbability`, `sides.*.permit`) |
| Portfolio heat, daily loss budget rows | `/state` `risk.exposure[].riskPct` vs `policy.maxCurrencyExposurePct`; `risk.budget.usedPct` |
| News/session/spread row | `decision.news` (status/blocked/reason) |
| Slippage EWMA, spread vs normal | `GET /desk/execution` (existing; 404 ⇒ rows hidden) |
| EA version, heartbeat RTT | `GET /bridge/status` (existing) |
| Calibration/Brier/kill rules/refusals/weekly | `GET /desk/learning/weekly` + `src/lib/learning.ts` helpers |
| e-values, halve/disable thresholds | `GET /desk/governance` (`halveAt`, `disableAt`) |
| Closed trades, by symbol, P&L | `GET /desk/performance` |

Fields the design needs that were **not** exposed were added as OPTIONAL
fields computed from values the server already has, each with a unit test
(§3.1). Everything else the design shows comes from the table above; where a
value is absent at runtime the UI shows an em dash — never a made-up number.

### 3.1 The additive server fields (all optional, all tested)

1. `GET /desk/state` → `v4?: { enabled, shadow, layers: { governance,
   regimeHmm, gatekeeper, metaModel, execution, portfolio, ui } }` — a summary
   of `deskV4()`. This is the only honest source for the title bar's
   `V4 SHADOW` / `V4 LIVE` chip and for the Learning empty states' flag names.
   Pure helper `deskV4Summary()` in `desk-v4-config.ts`.
2. Positions on `/state` and in the SSE `deskSummary` →
   `managementState?: "open" | "be"` — derived from geometry the server
   already holds: the stop sits at or beyond the entry (`sl >= openPrice` for a
   buy, `sl <= openPrice` for a sell) ⇒ `"be"`, else `"open"`. Pure helper
   `positionManagementState()` in `presenter.ts`. **Assumption:** the EA does
   not report its WP0 state machine over the wire, so Partial / Runner / Time
   stop are NOT derivable and are omitted (the State column shows only what the
   API supplies, per the brief).
3. Scan rows → `rrFill?: number | null`, `edgeFloorR?: number | null`,
   `edgeRequiredR?: number | null` — from `decision.monteCarlo.rewardRisk` and
   `decision.gatekeeper` (`evLcbR`, `requiredEvLcbR`). Pure helper
   `scanEdgeFields()` in `presenter.ts`.
4. `GET /desk/analysis` → `thresholds?: { minRrFill, minCostCoverage }` — the
   two gate constants from `desk-constants.ts`, so the legacy (v4-off) gate
   rows print server thresholds, not hard-coded ones.
5. `GET /desk/learning/weekly` → `trades.calibrationBuckets?: { label, lower,
   upper, n, meanPredicted, realisedHitRate, gapPoints }[]` and
   `trades.meanRLower80?: number | null` — computed from the stored
   `(predictedProbability, realisedR)` pairs the report already reads.
   Buckets: <50, 50–60, 60–70, 70–80, 80–90, 90–100; only buckets with n > 0
   are included; a bucket with n < 10 renders as "-"/"n too small" in the UI.
   `meanRLower80` = mean − 1.2816·sd/√n over measured R (n ≥ 2), else null.
   Pure helpers `calibrationBuckets()` / `meanRLower80()` in `governance.ts`.
6. `GET /desk/performance` → closed trades gain `agents?: string[] | null` —
   the existing `planIdForTicket()` → `planMemory()` join. Null when the plan
   memory has expired (it is capped), rendered as an em dash. Pure helper
   `agentsForTicket()` in `governance-runtime.ts`.

Client mirrors of all six live in `src/lib/desk.ts` as optional fields, so
existing consumers keep working unchanged. `deskApi.execution()` is added
(existing endpoint, 404 ⇒ `{ available: false }`).

### 3.2 Thresholds the UI prints — one home each

* Server-supplied: `thresholds.minRrFill` / `minCostCoverage` (analysis),
  gatekeeper `reason.threshold` per gate, `policy.*` (/state),
  `agent.halveAt/disableAt` (governance), `MIN_EV_LCB_R` via
  `gatekeeper.requiredEvLcbR`.
* Not supplied by any API (documented rollout gates from the v4 brief):
  `DESK_THRESHOLDS` exported from `src/components/desk/desk-layout.ts` —
  `slippageMaxR: 0.15`, `rolloutDemoMinTrades: 200`, `nearLimitFraction: 0.8`,
  `breakRiskWarnFraction: 0.3`, `calibrationMinBucketTrades: 10`. The
  rollout stepper's "n of 200 trades needed to leave demo" reads
  `rolloutDemoMinTrades`, never a literal.

## 4. New client modules

| Module | Contents |
| --- | --- |
| `src/components/desk/desk.css` | tokens scoped to `.desk-root`, thin scrollbars, focus ring, reduced motion, `max-height: 800px` work-area scroll |
| `src/components/desk/desk-layout.ts` | every band/row/column number, per-workspace placements (large/medium/small), table column templates, `DESK_THRESHOLDS` |
| `src/components/desk/panel.tsx` | the one Panel component (header 36px, scrolling body) |
| `src/components/desk/primitives.tsx` | Badge, Meter (3px with limit tick), DataTable (one column template for header+rows), SubHeader, Footer, Chips, SkeletonRows, PanelEmpty, KeyValue |
| `src/components/desk/desk-shell.tsx` | frame: title bar, tabs, alert slot, context strip, panel grid, status bar; not-linked card; responsive switches |
| `src/components/desk/title-bar.tsx` | chips (data-source, stream, v4, demo/real), Equity / Day / Open risk, mode segmented control, timezone, Auto, MT5·login, Flatten |
| `src/components/desk/workspace-tabs.tsx` | `role="tablist"`, arrow keys, URL `?tab=` state, badges (Markets: selected count; Learning: halved+disabled agents), right-hand context text |
| `src/components/desk/alert-strip.tsx` | one 32px slot: halt › mismatch › stale › reconnecting › actionError, "+N more" popover |
| `src/components/desk/status-bar.tsx` | feed counts, heartbeat age, EA version, server time in zone, last journal event, note slot |
| `src/components/desk/stat-strip.tsx` | eight equal tiles (caption 10.5, value 18/600, unit, optional limit meter) |
| `src/components/desk/pipeline-strip.tsx` | L0–L6 nodes + chevrons, state dots, current node cyan |
| `src/components/desk/workspaces/command.tsx` | Opportunities, Decision, Risk & safety, Positions & plans, Calendar |
| `src/components/desk/workspaces/markets.tsx` | Universe, Scanner, Auto-select, Feed & execution health |
| `src/components/desk/workspaces/learning.tsx` | the seven Learning panels (logic moved from `pages/learning.tsx`) |
| `src/components/desk/workspaces/journal.tsx` | Closed trades + CSV export, By symbol/agent, Decision journal |
| `src/lib/desk-ui.ts` | new pure helpers: gate-row builder, pipeline derivation, day% and open-risk maths, tab/URL state, opportunity rows, risk rows, rollout stage, formatters |

## 5. Panel-to-source map (what each panel reads)

| Panel | Queries / stream | Mutations |
| --- | --- | --- |
| Title bar | `["desk-state"]`, stream (`account`), `["desk-bridge-status"]`* | `settings` (mode/timezone/autoTrade), `flatten` |
| Pipeline strip | `["desk-state"]`, `["desk-regime"]`, `["desk-analysis",s,m]`, stream positions | — |
| Opportunities | stream instruments → `["desk-instruments"]`, `["desk-scan",m,w]`, `["desk-regime"]` | `settings` (via Manage → Markets tab) |
| Decision | `["desk-analysis", symbol, mode]` | `arm` (testid `arm-plan`) |
| Risk & safety | `["desk-state"]` (risk/policy/account), `["desk-execution"]`* | `resumeSymbol` |
| Positions & plans | stream positions/plans → `["desk-state"]` | `closePosition`, `cancelPlan` |
| Calendar | `["desk-state"]` (`news`, `newsUpcoming`), analysis `news` gate | — |
| Universe | `["desk-markets"]`, `["desk-state"].watchlist` | `settings({watchlist})` |
| Scanner | `["desk-scan", mode, watchlist]`, `["desk-state"].autoSelect.nextDueAt` | refetch (Rescan) |
| Auto-select | `["desk-state"].autoSelect` | `deskApi.autoSelect` ("Run now") |
| Feed & health | `["desk-state"]` (market/feed/terminal), `["desk-execution"]`*, `["desk-bridge-status"]`* | — |
| Learning panels | `["desk-governance"]`, `["desk-weekly"]`, `["desk-journal",kind]`, `["desk-regime"]` | `resumeAgent` (reason ≥ 3, toasts unchanged) |
| Closed trades / By symbol | `["desk-performance"]` | CSV export (client-side) |
| Decision journal | `["desk-state"].journal` | — |
| Status bar | `["desk-state"]`, `["desk-bridge-status"]`* | — |

\* new lightweight keys added by v5 (`["desk-execution"]` 30s, 
`["desk-bridge-status"]` 60s, both `enabled` only when a terminal is paired);
the required v4 keys and intervals are untouched.

## 6. Responsive

* **≥ 1280px**: the placements in `desk-layout.ts` (`PLACEMENTS.large`).
* **1024–1279px**: Command becomes Opportunities cols 1–4 rows 1–3, Decision
  cols 5–12 row 1, Risk & safety cols 5–8 row 2, Positions cols 9–12 row 2,
  Calendar cols 5–12 row 3 (`PLACEMENTS.medium.command`). Other workspaces keep
  their grid (they already fit 12 columns at these widths).
* **< 1024px**: single column (`PLACEMENTS.small` — every panel 12 cols, one
  row each, ordered as the workspace lists them); the tabs render as a bottom
  bar (sticky, 4 items); the pipeline strip scrolls horizontally; panels use
  natural height; tables collapse to stacked cards; Arm and Flatten stay
  reachable; the page never scrolls horizontally.

## 7. States

* **Not linked**: title bar (controls disabled) + centred card "Connect MT5 to
  start the Desk", "Set up MT5 bridge" button (`open-bridge` still opens the
  dialog) and the three step tiles. No data panels, no tabs.
* **Degraded**: the alert strip variants (halt / feed mismatch / MT5 stale /
  reconnecting / action error), one slot, most severe first, "+N more"
  popover. Copy is carried over from the v4 banners verbatim where it exists.
* **Refused decision**: "No trade" verdict (rose), failing gate rows first with
  the plain-language reason from `decision.rejections`, Arm disabled with the
  note "Arm is unavailable while any gate fails".
* **Learning off** (endpoint 404): per-panel empty state — icon, one sentence,
  "How to turn on shadow mode" (inline note naming the `DESK_V4_*` flag). No
  zeros as measurements.
* **Loading**: skeleton rows at the same fixed heights (no layout shift).
  **Errors**: inline message in the panel body.

## 8. Assumptions (conservative choices where the brief was ambiguous)

1. **The reference files were not reachable in this workspace.**
   `desk-redesign-reference.html` and the sample PDF were not present in the
   sandbox (`/home/user/uploads/` does not exist). The build prompt's own spec —
   tokens, band heights, grid placements, column templates, row heights, copy
   and states — was therefore treated as the source of truth and implemented
   exactly. The side-by-side visual-match check could not be executed against
   the reference; see §10.
2. **No headless browser exists in this environment**, so the browser checks
   are covered by (a) the pure layout-contract test, and (b) a checked-in
   Playwright spec (`artifacts/trading-platform/scripts/desk-layout.spec.mjs`)
   that runs the five assertions of acceptance check 3 at the four viewport
   sizes; it requires `npx playwright install chromium` on a developer machine.
   Screenshots could not be captured here (§10).
3. `managementState` is derived geometry ("be" = stop at or beyond entry), not
   an EA report; richer states are omitted rather than invented (§3.1.2).
4. Calibration buckets and `meanRLower80` are computed from stored rows only;
   when the governance layer never recorded predictions the table shows its
   footer verdicts alone ("derive nothing", per the brief).
5. "Mean lower 80% bound" uses the one-sided normal bound
   mean − 1.2816·sd/√n (n ≥ 2) over measured R — the standard 80% lower
   confidence bound; recorded here because the brief did not give a formula.
6. Opportunities' "Manage" jumps to the Markets tab (the brief allowed popover
   OR jump; the jump reuses the tested universe panel without a second copy).
7. The calendar's amber blackout line uses the server's own sentence
   (`decision.news.reason`) when the selected symbol's news gate is in
   blackout; no window is computed client-side.
8. `TRADE_MODES` intraday label becomes "Intraday" (it was "Day"); the list is
   consumed only by the Desk. Mode buttons show labels only, no timeframes.
9. Regime split-bar mapping: Trend = `trend_up + trend_down` (cyan), Range =
   `range` (violet), Disorder = `volatile` (amber) — the four `RegimeState`
   labels the HMM can emit.
10. The rollout stepper's stage is derived, not stored: shadow (v4 off or
    `shadow`), demo (v4 live but account is demo or `liveTradingEnabled` is
    false), then the risk stage from `policy.baseRiskPct` (≤0.10 → "0.10%",
    ≤0.25 → "0.25%", else "0.35%").
11. Status-bar EA version and heartbeat come from the existing
    `GET /bridge/status` (polled 60s while paired); the stream payload carries
    no EA version and adding one there would change the stream contract.
12. Learning journal chips map to the existing kinds: All → `null`, Risk →
    `risk`, Execution → `execution`, No trade → `no_trade`, Signal → `signal`
    (the same `deskApi.journal({kind})` call, same query key).
13. `panes.tsx` is deleted whole in WP9 — no page other than the old Desk ever
    imported it (verified by grep). `bridge-dialog.tsx` is untouched.
14. Server `/desk/series` and `/desk/candles` routes stay (the brief forbids
    server behaviour changes; the comment on `/candles` already says no Desk
    chart uses it). The Desk client no longer references either.
15. Below 800px viewport height the whole work area (strip + grid) scrolls;
    each grid row gets `min-height: 300px` so panel bodies keep a usable
    viewport and nothing overlaps.
16. The "Quality 71 of 62 needed" caption is `qualityScore` of
    `qualityThreshold` from the decision — both already on the wire.
17. Net-open R in the Positions footer sums only positions whose
    `initialRiskMoney` the EA stamped; unstampable positions contribute to the
    money total and are counted in a "(n unmeasured)" caption rather than
    faking an R.

## 9. How to run the checks

```bash
# types (whole workspace)
pnpm typecheck

# client unit tests (includes the new desk-ui + desk-layout contract tests)
cd artifacts/trading-platform && pnpm test

# server unit tests (includes the new presenter/governance field tests)
cd artifacts/api-server && pnpm test

# browser layout contract (needs a dev machine with browsers installed)
cd artifacts/trading-platform
pnpm dev &  # plus the API on :8080
npx playwright install chromium   # once
npx playwright test scripts/desk-layout.spec.mjs
```

## 10. Known gaps / not verified here

* Visual side-by-side against `desk-redesign-reference.html` (acceptance 4) —
  the reference file was not available in this workspace; the implementation
  follows the written spec's numbers exactly instead.
* Real-browser screenshots at the four viewport sizes — no browser binary in
  this sandbox; the Playwright spec is checked in and saves screenshots next to
  the reference when run locally.
* The v4-gated surfaces (gatekeeper rows with thresholds, calibration buckets,
  governance, regime) were verified against unit fixtures and the live API with
  the flags off (404 → empty states). Verifying them against a paired MT5
  terminal with the flags on requires a real terminal.
* `meanRLower80` on n < 2 measured trades is null by construction (an sd of
  one sample is not a bound).
