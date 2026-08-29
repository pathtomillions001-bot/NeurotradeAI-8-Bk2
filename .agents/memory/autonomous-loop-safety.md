---
name: Autonomous trading loop safety
description: Concurrency guards and P&L accuracy for the autonomous trading engine
---

## Concurrency Guard (`isLoopRunning` flag)
- Module-level `let isLoopRunning = false` in `ai.ts`
- Set to `true` at start of `runAutonomousLoop()` after checking `engineRunning`
- Reset in `finally` block so ALL paths (normal, error, early return) release the lock
- If a loop iteration is already running when the timer fires, it logs a warning and reschedules instead of spawning a duplicate

## Open-trade Guard
- At the start of each iteration (before trade execution), queries DB for `status = 'open'` trades
- If any open trade exists, skips the trade execution and reschedules
- Prevents opening a second trade before the first Deriv contract settles

## Deriv P&L Accuracy
- **Live trades**: `profit = contractResult.profit` (from Deriv — ground truth)
- **Actual payout**: `actualPayout = won ? stake + profit : 0` (not estimated multiplier)
- Settlement timeout increased to `(duration + 30) * 1000` ms for both ai.ts and trades.ts
- Paper trades still use estimated payout: `won ? stake * payoutMultiplier - stake : 0`

## scheduleNext timing
- After a trade executes: 5000ms delay before next scan
- No trade (skip): 3000ms delay
- These delays ensure Deriv account balance updates are reflected before next loop reads balance

**Why:** Without `isLoopRunning`, rapid engine toggles or slow async operations could spawn parallel loops opening multiple concurrent trades. Without the open-trade guard, network delays in `waitForContractResult` could cause the loop to restart and open a new trade before the previous contract settles in Deriv.
