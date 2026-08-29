---
name: Payout multiplier cache optimization
description: Why and how payout multipliers are cached to speed up market scanning
---

The finalizeAnalysis function (trade-helpers.ts) calls getContractProposal which opens a WebSocket to Deriv. This takes 2-8 seconds per call. With 17 markets scanned in parallel, this caused 17 concurrent WS connections and slow scanning.

Fix: 20-minute in-memory cache keyed by `symbol:contractType:barrier`.

Also added `skipProposal` option: when true, uses DEFAULT_PAYOUT constants instead of fetching.
- Paper trade mode: skipProposal=true (no token, no need for real payout)
- Demo mode: skipProposal=true
- Live trade with token: fetches real payout (with 4s timeout fallback to defaults)

Default payouts: RISE/FALL/CALL/PUT=1.87, DIGITOVER/DIGITUNDER=9.4

**Why:** Scanning 17 markets sequentially at 4s each = 68s minimum. With cache, first scan fetches, subsequent scans are instant.

**How to apply:** Always pass skipProposal=!token when calling finalizeAnalysis in the autonomous loop.
