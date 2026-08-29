---
name: Multi-agent system
description: New 9-agent AI architecture replacing the old monolithic 8-section scoring function
---

## Architecture
9 agents, each returns `{ agentId, score, confidence, signal, reasoning, data, executionTimeMs }`.

| Agent | File | Responsibility |
|-------|------|----------------|
| FeatureEngineering | feature-engineering.ts | Centralized price/digit features, no duplication |
| MarketRegime | market-regime.ts | Trending/mean-reverting/choppy/volatile via Hurst + autocorr |
| Direction | direction-agent.ts | RISE/FALL probability with 5-tick label horizon |
| Digit | digit-agent.ts | OVER/UNDER: Markov+chi2, barrier optimization, EV-ranked |
| EVCalculator | ev-calculator.ts | True EV using actual payout multipliers per product |
| RiskManager | risk-manager.ts | Kelly position sizing, drawdown, exposure limits |
| ExecutionTiming | execution-timing.ts | Momentum, entry quality, wait signal |
| PerformanceFeedback | performance-feedback.ts | Per-strategy real win rates (true wins/total, not EWMA) |
| MasterDecision | master-decision.ts | Aggregates all agents, final execute/skip/wait |

## Coordinator
`artifacts/api-server/src/lib/agent-coordinator.ts` — exports:
- `runCoordinator(ctx: ScanContext)` → `CoordinatorOutput`
- `buildLegacyAnalysis(output)` → backward-compat `LegacyAnalysis` for old routes
- `recordTradeOutcome(symbol, contractType, won, confidence)` → feeds performance feedback

## Context type
`ScanContext` in `agents/types.ts`: `{ symbol, displayName, category, prices[], digits[], balance, settings, daily, token, currency }`

**Why:** The old system had 8 agents that were just sections of one function, retrained ML from scratch on every call, had hardcoded logistic regression weights, no product-specific logic, and no real feedback loop.

**How to apply:**
- Markets and AI routes use `runCoordinator` then `buildLegacyAnalysis` for backward compat
- After every trade (won/lost), call `recordTradeOutcome` so performance feedback updates
- New fields returned by markets route: `qualityScore`, `confidenceScore`, `riskScore`, `trend`, `regime`, `recommendedContractType`, `agentOutputs`
