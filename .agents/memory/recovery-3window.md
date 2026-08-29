---
name: Recovery 3-Window Consensus
description: The new recovery fast path replaces the full tournament scan with a 3-window consensus check. Key design decisions for future reference.
---

## Rule
When `recoveryEngine.isInRecovery()` is true, the autonomous loop skips the full 8-agent tournament and runs `runRecoveryConsensus()` from `recovery-consensus.ts` instead. A recovery trade fires the instant all 3 windows agree; otherwise the loop rescans in 3s.

## Where it lives
- New module: `artifacts/api-server/src/lib/agents/recovery-consensus.ts`
- Recovery fast path: `artifacts/api-server/src/routes/ai.ts` — inserted after `contractCompatibleMarkets` is built, before the group tournament scan
- Helper: `getRecoveryPayout(contractType, barrier)` at module scope in `ai.ts`
- Payout table imported: `DIGIT_PAYOUTS` from `digit-probability.ts`

## Design decisions

**Why 3 windows (50/100/150)?**
The window sizes were chosen to capture short-term (50), medium-term (100), and longer-term (150) digit patterns. Requiring all 3 to agree eliminates noise while still responding within seconds when a genuine signal is present.

**Why, not long minimum intervals?**
The old path used the full tournament with quality floor ≥ 50, regime gate for EVEN/ODD/MATCH/DIFF in trending markets, and multi-family scoring — these gates would often reject for 30+ minutes. The 3-window consensus IS the quality gate; no other gates apply to the recovery path.

**Contract-type dispatch:**
- DIGITOVER/DIGITUNDER: Bayesian win prob for barrier must be above theoretical in all 3 windows (> theoretical + 0.005)
- DIGITEVEN/DIGITODD: `analyzeEvenOdd()` must recommend the target direction in all 3 windows
- DIGITMATCH: `analyzeMatchDiffers()` matchRecommended=true in all 3 windows
- DIGITDIFF: `analyzeMatchDiffers()` diffRecommended=true in all 3 windows
- CALL/PUT: consistent price trend (first-half and second-half both same direction) in all 3 price windows

**MATCH/DIFF selection during recovery:**
Same as normal recovery logic — DIGITMATCH for first 3 consecutive recovery attempts, DIGITDIFF fallback after `consecutiveMatchLosses >= 3`.

**Markets:**
Same `contractCompatibleMarkets` as the normal path — no market switching. `cooledDownSymbols` already filtered. Per-symbol cooldown safety net checked before execution.

**Stake:**
Uses `recoveryEngine.getDynamicRecoveryStake()` with the payout for the consensus contract type. Base stake param is ignored when `state.inRecovery === true` (engine uses `state.baseStake`).

**Why:** The old full tournament + quality gates caused 30+ min recovery delays. 3-window consensus is contract-specific, fast (<100ms), and executes within the first 3s cycle where all windows agree.
