---
name: Generated client source files
description: How api-client-react and api-zod source generation works — requires real .ts files in src/generated/
---

## Rule
`lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/` must contain actual `.ts` source files — not just the compiled `.d.ts` in `dist/generated/`. TypeScript's `tsc --build` with `composite: true` requires real source to compile; the frontend uses project references to get types from the dist `.d.ts` files.

**Why:** The codegen tool (Orval) is broken in this repo ("failed to resolve input"). The `src/generated/` folders were empty, causing `typecheck:libs` to fail with "Cannot find module './generated/api'". The fix is to maintain handwritten source files there.

**How to apply:**
- When changing the API contract (openapi.yaml), manually update BOTH:
  1. `lib/api-client-react/src/generated/api.schemas.ts` — TypeScript interfaces
  2. `lib/api-client-react/src/generated/api.ts` — React Query hook implementations
  3. `lib/api-zod/src/generated/api.ts` — Zod validators (used server-side for validation)
  4. Mirror changes in `lib/api-client-react/dist/generated/api.schemas.d.ts` (dist .d.ts) so project references typecheck works without re-running tsc
- Use `any` (not `unknown`) for fields like `recommendation` that the frontend accesses without narrowing
- Make `priceHistory` non-optional in `Market` type or `chartData` downstream can be `undefined`
- Hook URLs must match Express route paths exactly: e.g. `/api/trades/daily-summary` not `/api/trades/daily`; `/api/ai/recommendation` (no `/best` suffix) for the best-recommendation endpoint
