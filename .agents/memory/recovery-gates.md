---
name: Recovery gate architecture
description: How recovery trades get through the autonomous loop gates — and why they were silently blocked before the fix.
---

## The problem: recovery trades never executed

`runAutonomousLoop` has a chain of filters that silently blocked recovery trades:

1. **Tournament starvation** (`ai.ts`): `tournamentPool = tradeableWinners` where `tradeableWinners = groupWinners.filter(w => w.output.shouldTrade)`. During recovery, all candidates had `shouldTrade=false` → empty pool → `bestResult=null` → infinite rescan, zero recovery trades.

2. **`shouldTrade` gate** (`ai.ts` line ~685): `if (!output.shouldTrade) { scheduleNext(); return; }` — even if a candidate somehow survived the tournament, this gate sent the engine back to rescan.

3. **Consensus gate** (`master-decision.ts` gate 4): `if (weightedScore < Math.min(threshold, 50))` — recovery OVER 4/UNDER 5 produces lower agent scores, causing consensus < 50 → `shouldTrade=false` for all candidates.

4. **UNDER tier-1 barrier mismatch**: `master-decision.ts` checked `barrier === 8` for UNDER tier-1 (edge-only gate), but `digit-probability.ts` uses `barrier === 7` as the normal-mode UNDER barrier. UNDER 7 trades fell into the `EV > -0.06` gate, which often rejects them.

## The fixes applied

### `master-decision.ts`
- Gate 4 (consensus): Skip when `ctx.inRecovery === true` — recovery decision comes from the global system, not agent consensus.
- Tier-1 UNDER check: `barrier === 7` (not 8) to match `digit-probability.ts` normal-mode barrier.

### `ai.ts`
- Tournament pool fallback: `const tournamentCandidates = (tradeableWinners.length > 0 || !globalRecovery.isActive) ? tradeableWinners : groupWinners` — when recovery active and all candidates rejected, fall back to all group winners.
- `shouldTrade` bypass: `if (!output.shouldTrade && (!globalRecovery.isActive || hardVeto))` — during recovery, only hard-veto conditions (risk gate, outlier tick) block execution.

## Which barriers are correct (canonical)

`digit-probability.ts` (used by coordinator) defines the correct barriers:
- **Normal mode**: `DIGITOVER 2`, `DIGITUNDER 7` — both 70% theoretical win, 1.19x payout
- **Recovery mode**: `DIGITOVER 4`, `DIGITUNDER 5` — both 50% theoretical win, 1.50x payout

`digit-agent.ts` uses `TIER1_UNDER=8` but is NOT called by the coordinator — only used standalone.

**Why:** `digit-probability.ts` was written to match user spec (OVER 2 mirrors UNDER 7 at 70% win rate). `digit-agent.ts` is legacy. Master-decision must check `barrier===7` for UNDER tier-1.

## Recovery EV gate (gate 2 in master-decision.ts)
- Tier-1 (OVER 2, UNDER 7): check `edge > 0` only (positive EV impossible at 1.19x payout)
- Tier-2 (OVER 4, UNDER 5): allow `EV > -0.15` (50% win × 1.50x − 0.5 = −0.25; wide gate needed)
- Direction (CALL/PUT): `EV > -0.06`
- Hard-veto recovery overrides: Gate 1 (risk hard-stop) and Gate 3 (outlier tick) still respected even in recovery
