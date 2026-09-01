---
name: Bot Recovery Markup Setting
description: The 10% fixed markup on debt used by the five specialist AI bots' recovery is now a user-adjustable Risk Management setting (botRecoveryMarkup). Default stays 10%.
---

# Bot Recovery Markup Setting

## The rule
`botRecoveryMarkup` (DB column `bot_recovery_markup NUMERIC(5,2) NOT NULL DEFAULT '10'`) is a percentage the user sets in **Settings → Risk Profile (Risk Management) → AI Bot Recovery Markup**. It controls ONLY the five specialist AI bots' recovery stake sizing:

- stake = `(unrecoveredAmount × (1 + markup/100)) / (payout − 1)`
- Default 10 % → a $1 loss is recovered by a trade sized to win $1.10.
- Clamped to ≥ 0 in `calculateBotRecoveryStake`; spec/UI allow 0–100 %.
- The **shared engine** (`getDynamicRecoveryStake`, autonomous loop in `ai.ts`, Speed AI FAB) is NOT affected — it never reads this value.

## Where it lives
- DB schema: `lib/db/src/schema/settings.ts` + INIT_DDL in `lib/db/src/index.ts` (CREATE TABLE + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- Server bootstrap: `artifacts/api-server/src/app.ts` `bootstrapDb()` — column added to the schema-check query and to `sessionMigrations` (guaranteed to run even when drizzle-kit push is unavailable for embedded PGlite; the push is wrapped in its own try/catch).
- API: `lib/api-spec/openapi.yaml` (TradingSettings + TradingSettingsInput, min 0 max 100), regenerated into `lib/api-zod` and `lib/api-client-react` via `pnpm --filter @workspace/api-spec run codegen`.
- Route: `artifacts/api-server/src/routes/settings.ts` (formatSettings + PUT mapping).
- Engine: `recovery-math.ts` `calculateBotRecoveryStake(unrecoveredAmount, payoutMultiplier, markupPercent = 10)` → `recovery-engine.ts` `getBotRecoveryStake(..., markupPercent = 10)` → `bot-engine.ts` `runLoop` reads `settings[0].botRecoveryMarkup` and passes it through `computeRecoveryStake`.
- UI: `artifacts/trading-platform/src/pages/settings.tsx` (NumInput row, suffix %, 0–100 step 0.5) and read-only display in `bot-console.tsx` Recovery Engine section ("Markup on debt").

## Gotchas
- The 10 % markup is used ONLY when `getBotRecoveryStake` is the sizing function — i.e. only the bot-engine path. `getDynamicRecoveryStake` (main engine) intentionally ignores it.
- `lib/api-zod/src/index.ts` re-exports generated types under the `types` namespace (`export * as types from "./generated/types"`) because orval names the switch-account request type `SwitchAccountBody`, colliding with the zod schema const of the same name in `generated/api.ts`.
- The OpenAPI spec is the source of truth; after editing it run `pnpm --filter @workspace/api-spec run codegen` (regenerates both api-zod and api-client-react).
- `DerivAccount.isActive` was missing from the spec while the server returns it (pre-existing typecheck error) — fixed by adding it to the spec and regenerating.
