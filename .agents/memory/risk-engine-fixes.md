---
name: Risk engine bug fixes
description: Key bugs fixed in the 13-agent risk/recovery pipeline and their root causes.
---

# Risk Engine Bug Fixes

## Bug 1 — risk-intelligence.ts: wrong field + maxDrawdown scale
- `ctx.dailyPnl` does not exist in ScanContext — correct field is `ctx.daily.profit`
- `settings.maxDrawdown` is stored as a **percentage** (e.g. 20) but the old code compared it against `currentDrawdown` which is a **fraction** (0–1). Fixed: `(settings.maxDrawdown ?? 20) / 100`.
- Without this fix, the daily-loss and drawdown hard-stops in risk-intelligence never fired (NaN and 0.2 >= 20 both false).

**Why:** TypeScript doesn't catch undefined field destructuring on `any`-typed ctx, so the bug was silent.

**How to apply:** If you ever add new fields to ScanContext, always verify consumers use the correct field path.

## Bug 2 — recovery-engine.ts: stake inflation via conservativeFactor
- `computeDynamicStake` divided `minRecovery` by `conservativeFactor` (= `0.7 * winP + 0.3` < 1), which **inflated** the stake significantly above what was needed to recover.
- Fixed: stake = `(unrecoveredAmount / netPayout) * 1.02` — exact minimum + 2% rounding buffer.

**Why:** Dividing by a factor < 1 makes the result larger than the minimum. The intent was to "account for probability of not winning" but it exposed too much capital.

## Bug 3 — confidence-fusion.ts: recovery intelligence not a hard gate
- `recoveryIntelligence` score was only used in weighted averaging, not a hard gate.
- After ≥4 consecutive losses, recovery-intelligence emits score 15. Added explicit gate: `if (recoveryIntelligenceScore < 20) → blocker`.
- This ensures the agent pipeline itself blocks trades after severe loss streaks, complementing the loop-level cooldown.

## Tuning changes (intentional behavior changes)
- Loss streak threshold boost: 3pts/loss → 6pts/loss, max 30 (was 15). After 5 losses, threshold is +30 on top of adaptive base.
- `recoveryIntelligence` base weight: 0.6 → 1.2 (in both dynamic-confidence.ts and confidence-fusion.ts BASE_AGENT_WEIGHTS — keep in sync).
- `learningAgent` base weight: 0.9 → 1.1.
- Learning agent now seeded from `market_win_rates` DB table at startup (in app.ts bootstrapDb chain).
