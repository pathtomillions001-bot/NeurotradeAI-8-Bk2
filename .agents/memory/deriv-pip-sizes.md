---
name: Deriv market pipSizes
description: Correct pipSize values per symbol — wrong value causes extractLastDigit to always return 0
---

Verified from live prices:

| Symbol group | pipSize |
|---|---|
| R_10 | **3** (prices like 4865.826 — 3 decimal places) |
| R_25 | **3** (prices like 2592.726 — 3 decimal places) |
| 1HZ15V | **3** (prices like 13222.146 — 3 decimal places) |
| 1HZ30V | **3** (prices like 6527.120 — 3 decimal places) |
| 1HZ90V | **3** (prices like 18528.175 — 3 decimal places) |
| R_100, 1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V, all JD* | 2 |
| R_50, R_75 | 4 |
| RDBULL, RDBEAR | 4 |

**Key distinctions:**
- R_10: pipSize=3 (NOT 2 — confirmed from live prices like 4865.826)
- R_25 and 1HZ25V are NOT the same pip size: R_25=3, 1HZ25V=2
- 1HZ15V / 1HZ30V / 1HZ90V are 3-dp markets (unlike the other 1s volatility indices which are 2-dp). Rendering them with 2 decimals rounds away the digit that digit analysis must show: 13222.146 → "13222.15" shows last digit 5 instead of 6; 6527.120 → "6527.12"; 18528.175 → "18528.18" shows 8 instead of 5. Locked in by `artifacts/api-server/src/lib/pip-accuracy.test.ts` and rendered via `artifacts/trading-platform/src/lib/pip-size.ts` (single frontend source of truth, kept in sync with `DERIV_MARKETS`).

**Why:** extractLastDigit uses `Math.round(price * 10^pipSize) % 10`. Wrong pipSize causes the last digit to always be 0 (or wrong), skewing digit distribution to show 100% digit-0.

**How to apply:** When adding new symbols or fixing digit analysis bugs, verify pipSize from live Deriv WebSocket tick prices. The frontend market-detail.tsx pipSize calculation must match the backend DERIV_MARKETS definition in deriv.ts.
