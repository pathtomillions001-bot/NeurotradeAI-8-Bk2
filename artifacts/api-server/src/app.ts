import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { execSync } from "child_process";
import { resolve } from "path";
import router from "./routes";
import { logger } from "./lib/logger";
import { loadPersistedToken } from "./routes/auth";
import { tickManager, DERIV_MARKETS, APP_ID } from "./lib/deriv";
import { loadWinRatesFromDb } from "./lib/win-rate-store";
import { seedFromDb as seedLearningAgent } from "./lib/agents/learning-agent";
import { loadCalibrationCache } from "./lib/calibration";
import { loadRecoveryStateFromDb, resumeEngineIfEnabled, forceDayReset } from "./routes/ai";
import { registerMidnightCallback, scheduleNextMidnight } from "./lib/tz";
import { loadFromDb as loadDynamicConfidence } from "./lib/agents/dynamic-confidence";
import { startTradeReconciler } from "./lib/trade-reconciler";
import { pool, db, marketWinRatesTable, schemaReady } from "@workspace/db";
import { browserSession } from "./lib/session";

/** Ensure DB schema is applied — runs drizzle-kit push if tables or columns are missing. */
async function bootstrapDb() {
  try {
    // The embedded DDL (CREATE TABLE IF NOT EXISTS …) must finish before we
    // probe information_schema — on Railway the runtime has no pnpm/drizzle-kit,
    // so this in-process DDL is the only guaranteed schema path.
    await schemaReady;
    const { rows } = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM information_schema.tables   WHERE table_schema = 'public' AND table_name = 'settings')           AS settings_exists,
        (SELECT COUNT(*) FROM information_schema.tables   WHERE table_schema = 'public' AND table_name = 'adaptive_thresholds') AS adaptive_exists,
        (SELECT COUNT(*) FROM information_schema.columns  WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'bearer_token') AS bearer_col_exists,
        (SELECT numeric_precision FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'recovery_multiplier') AS recovery_multiplier_precision,
        (SELECT numeric_scale FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'recovery_multiplier') AS recovery_multiplier_scale,
        (SELECT COUNT(*) FROM information_schema.columns  WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'bot_recovery_markup') AS bot_markup_col_exists,
        (SELECT COUNT(*) FROM information_schema.tables   WHERE table_schema = 'public' AND table_name = 'trades')            AS trades_exists,
        (SELECT COUNT(*) FROM information_schema.tables   WHERE table_schema = 'public' AND table_name = 'accounts')           AS accounts_exists`
    );
    const settingsExists   = Number(rows[0].settings_exists) > 0;
    const adaptiveExists   = Number(rows[0].adaptive_exists) > 0;
    const bearerColExists  = Number(rows[0].bearer_col_exists) > 0;
    const botMarkupColExists = Number(rows[0].bot_markup_col_exists) > 0;
    const tradesExists     = Number(rows[0].trades_exists) > 0;
    const accountsExists   = Number(rows[0].accounts_exists) > 0;
    const recoveryMultiplierWideEnough =
      Number(rows[0].recovery_multiplier_precision) >= 20 &&
      Number(rows[0].recovery_multiplier_scale) >= 4;

    // Push whenever a required table/column is missing or the legacy NUMERIC(4,2)
    // multiplier column would still reject an unrestricted Manual value.
    // Trades and accounts are created by the in-process DDL; only attempt the
    // drizzle-kit push when core tables exist but a specific column is missing.
    if (!(settingsExists && adaptiveExists && bearerColExists && recoveryMultiplierWideEnough && botMarkupColExists && tradesExists && accountsExists)) {
      if (!(tradesExists && accountsExists && settingsExists)) {
        logger.warn(
          "Core tables missing — in-process DDL should have created them; check DB connectivity/permissions",
        );
      }
      logger.warn("DB schema out of date — running schema push");
      try {
        const root = resolve(import.meta.dirname, "../../../../");
        execSync("pnpm --filter @workspace/db run push", { cwd: root, stdio: "inherit" });
        logger.info("DB schema push complete");
      } catch (pushErr) {
        // Embedded PGlite has no DATABASE_URL for drizzle-kit; the explicit
        // ALTER TABLE statements below still apply the missing columns.
        logger.error({ err: pushErr }, "DB schema push unavailable — applying fallback column migrations");
      }
    }

    // Multi-user safety migration. Existing single-user rows are intentionally
    // assigned to the inaccessible `legacy` namespace instead of being exposed
    // to the first visitor after deployment.
    const sessionMigrations = [
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS bot_recovery_markup NUMERIC(5, 2) NOT NULL DEFAULT '10'`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `UPDATE settings SET session_id = 'legacy-' || id::text WHERE session_id = 'legacy'`,
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS deriv_contract_id TEXT`,
      // Per-account intelligence / learning tables (previously global).
      `ALTER TABLE trade_intelligence_reports ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE missed_opportunities ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE trade_features ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE adaptive_thresholds ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE ai_insights ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE market_win_rates ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'legacy'`,
      `DROP INDEX IF EXISTS market_win_rates_key`,
      `CREATE UNIQUE INDEX IF NOT EXISTS market_win_rates_key ON market_win_rates (session_id, symbol, contract_type, barrier)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS adaptive_thresholds_session_unique ON adaptive_thresholds (session_id)`,
      `CREATE INDEX IF NOT EXISTS trade_intel_session_idx ON trade_intelligence_reports (session_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS missed_opps_session_idx ON missed_opportunities (session_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS trade_features_session_idx ON trade_features (session_id)`,
      `CREATE INDEX IF NOT EXISTS trades_unsettled_idx ON trades (status, created_at) WHERE status IN ('open', 'error')`,
      `ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_login_id_unique`,
      `CREATE UNIQUE INDEX IF NOT EXISTS accounts_session_login_unique ON accounts (session_id, login_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS settings_session_unique ON settings (session_id)`,
      `CREATE INDEX IF NOT EXISTS trades_session_created_idx ON trades (session_id, created_at)`,
    ];
    for (const statement of sessionMigrations) await pool.query(statement);
    logger.info("Browser-session data isolation schema verified");
  } catch (err) {
    logger.error({ err }, "DB bootstrap failed — continuing, routes will surface errors");
  }
}

const dbReady = bootstrapDb();
const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(
  cors({
    origin: true,
    credentials: true,
    // The web client reads `x-session-id` to keep a tab pointed at the session
    // that actually served it (durable-binding inheritance, connect rotation).
    exposedHeaders: ["x-session-id"],
  }),
);
app.use(cookieParser());
app.use(browserSession);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Never let an API request race a production schema migration during startup.
app.use(async (_req, res, next) => {
  try {
    await dbReady;
    next();
  } catch {
    res.status(503).json({ error: "Database initialization is still unavailable" });
  }
});

app.use("/api", router);

// ── Embedded Deriv DBot builder (static bundle) ──────────────────────────────
// The vendored builder (artifacts/dbot-builder, `build:embed` → out/preview)
// is served from THIS origin so the iframe shares localStorage with the
// trading platform — that is what makes the no-second-login token bridge
// possible. In dev the Vite server proxies /dbot here.
const dbotDist = resolve(import.meta.dirname, "../../../artifacts/dbot-builder/out/preview");
app.use("/dbot", express.static(dbotDist, { index: "index.html" }));
app.get(/^\/dbot(\/.*)?$/, (_req, res) => {
  res.sendFile(resolve(dbotDist, "index.html"), (err) => {
    if (err) res.status(404).json({ error: "DBot builder bundle not built — run: pnpm --filter @workspace/dbot-builder run build:embed" });
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────
// Ensure DB schema is applied before anything else touches the database
dbReady.then(() => {
  loadPersistedToken().catch((err) => logger.warn({ err }, "Token load on startup failed"));
  loadWinRatesFromDb().catch((err) => logger.warn({ err }, "Win rate load on startup failed"));
  loadCalibrationCache().catch((err) => logger.warn({ err }, "Calibration load on startup failed"));
  // loadRecoveryStateFromDb MUST finish before resumeEngineIfEnabled so that the
  // streak counter is accurate before the first autonomous loop scan fires.
  loadRecoveryStateFromDb()
    .then(() => resumeEngineIfEnabled())
    .catch((err) => logger.warn({ err }, "Recovery state load / engine auto-resume on startup failed"));
  loadDynamicConfidence().catch((err) => logger.warn({ err }, "Dynamic confidence load on startup failed"));
  // Settle any trade interrupted by a restart/disconnect from Deriv's own
  // profit table — a live trade must never be stuck on "open"/"error".
  startTradeReconciler();
  // Seed the learning agent's in-memory win-rate store from the database so the
  // AI has historical context immediately after a server restart rather than
  // starting from scratch and having to re-learn which markets/contracts perform well.
  db.select().from(marketWinRatesTable).then((rows: typeof marketWinRatesTable.$inferSelect[]) => {
    seedLearningAgent(rows.map((r: typeof marketWinRatesTable.$inferSelect) => ({
      symbol:       r.symbol,
      contractType: r.contractType,
      barrier:      r.barrier,
      winRate:      Number(r.winRate),
      tradeCount:   r.tradeCount,
    })));
    logger.info({ count: rows.length }, "Learning agent seeded from historical win rates");
  }).catch((err: unknown) => logger.warn({ err }, "Learning agent seed from DB failed"));
});

// ── Server-side midnight reset scheduler ─────────────────────────────────────
// Fires forceDayReset() at the user's local midnight (timezone known once the
// frontend connects via POST /api/ai/day-reset).  Defaults to UTC until then.
// This is the fallback that keeps the server correct even when the browser is
// closed overnight.
registerMidnightCallback(() => {
  try {
    forceDayReset(true);
  } catch (err) {
    logger.warn({ err }, "Server-side midnight reset failed");
  }
});
scheduleNextMidnight();

// Start persistent Deriv tick subscription for all synthetic markets
tickManager.start(DERIV_MARKETS.map((m) => m.symbol));

export default app;
