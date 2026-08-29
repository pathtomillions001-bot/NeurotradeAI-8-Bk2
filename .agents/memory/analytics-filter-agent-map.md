---
name: Analytics filter + agent name map
description: Date-filter implementation choices and the explicit AGENT_NAMES→AGENT_SCORE_KEYS mapping required for intelligence page
---

## Analytics date filter (analytics.tsx)

- Filter bar: Today / 7 Days / 30 Days / Custom (date inputs) — client-side filtering of Deriv journal trades
- Daily P&L bucketing uses a `toLocalDate()` helper (not `toISOString().slice(0,10)`) to avoid UTC↔local shift
- "Today's Summary" card always reads from `allTrades` (unfiltered), computed via a separate `todayStats` memo — prevents showing zeros when filter excludes today
- `buildAnalytics()` returns typed interfaces: `CategoryStat`, `MarketStat`, `DayPoint`, `WinRatePoint`

**Why:** toISOString() returns UTC date, which can bucket a trade into the wrong day in non-UTC timezones. Today's summary must always reflect real today, not the filtered window.

## Deriv profit_table limit

JournalManager and `fetchDerivProfitTable` both changed from `limit: 200` to `limit: 500`. Deriv supports up to ~999 per page.

## Intelligence agent name→key explicit map (CRITICAL)

String normalisation of AGENT_NAMES produces wrong keys (e.g. "Rise/Fall Model" → "risefallModel" ≠ "riseFallAgent"). Always use the explicit map:

```
"Market Scanner"       → "marketScanner"
"Tick Intelligence"    → "tickIntelligence"
"Digit Probability"    → "digitProbability"
"Rise/Fall Model"      → "riseFallAgent"       ← non-obvious
"Market Regime"        → "marketRegime"
"Execution Timing"     → "executionTiming"
"Confidence Fusion"    → "confidenceFusion"    ← meta-agent, no adaptive stats
"Recovery Intelligence"→ "recoveryIntelligence"
"Risk Intelligence"    → "riskIntelligence"
"Portfolio Manager"    → "portfolioManager"
"Learning Agent"       → "learningAgent"
"Pattern Discovery"    → "patternDiscovery"
"Trade Explainability" → "tradeExplainability" ← meta-agent, no adaptive stats
```

`confidenceFusion` and `tradeExplainability` are NOT in `BASE_WEIGHTS` / dynamic-confidence and will never have adaptive stats — show `—` for their accuracy.

## Recovery stake cap

`MAX_RECOVERY_MULTIPLIER = 3.0` in recovery-engine.ts. `computeDynamicStake` takes `baseStake` param and caps at `baseStake * 3.0`. This prevents huge stakes when the chosen recovery contract has a low payout ratio (e.g. OVER 3 = 1.28× → would need $65 stake to recover $18 loss, now capped at 3× $18 = $54). Partial recovery debt persists across trades.
