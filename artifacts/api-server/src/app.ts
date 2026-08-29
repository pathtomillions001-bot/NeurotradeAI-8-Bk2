import express, { type Express } from "express";
import cors from "cors";
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
import { pool, db, marketWinRatesTable } from "@workspace/db";

/** Ensure DB schema is applied — runs drizzle-kit push if tables or columns are missing. */
async function bootstrapDb() {
  try {
    const { rows } = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM information_schema.tables   WHERE table_schema = 'public' AND table_name = 'settings')           AS settings_exists,
        (SELECT COUNT(*) FROM information_schema.tables   WHERE table_schema = 'public' AND table_name = 'adaptive_thresholds') AS adaptive_exists,
        (SELECT COUNT(*) FROM information_schema.columns  WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'bearer_token') AS bearer_col_exists,
        (SELECT numeric_precision FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'recovery_multiplier') AS recovery_multiplier_precision,
        (SELECT numeric_scale FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'recovery_multiplier') AS recovery_multiplier_scale`
    );
    const settingsExists   = Number(rows[0].settings_exists) > 0;
    const adaptiveExists   = Number(rows[0].adaptive_exists) > 0;
    const bearerColExists  = Number(rows[0].bearer_col_exists) > 0;
    const recoveryMultiplierWideEnough =
      Number(rows[0].recovery_multiplier_precision) >= 20 &&
      Number(rows[0].recovery_multiplier_scale) >= 4;

    // Push whenever a required table/column is missing or the legacy NUMERIC(4,2)
    // multiplier column would still reject an unrestricted Manual value.
    if (settingsExists && adaptiveExists && bearerColExists && recoveryMultiplierWideEnough) return;

    logger.warn("DB schema out of date — running schema push");
    const root = resolve(import.meta.dirname, "../../../../");
    execSync("pnpm --filter @workspace/db run push", { cwd: root, stdio: "inherit" });
    logger.info("DB schema push complete");
  } catch (err) {
    logger.error({ err }, "DB bootstrap failed — continuing, routes will surface errors");
  }
}

const app: Express = express();

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── Startup ──────────────────────────────────────────────────────────────────
// Ensure DB schema is applied before anything else touches the database
bootstrapDb().then(() => {
  loadPersistedToken().catch((err) => logger.warn({ err }, "Token load on startup failed"));
  loadWinRatesFromDb().catch((err) => logger.warn({ err }, "Win rate load on startup failed"));
  loadCalibrationCache().catch((err) => logger.warn({ err }, "Calibration load on startup failed"));
  // loadRecoveryStateFromDb MUST finish before resumeEngineIfEnabled so that the
  // streak counter is accurate before the first autonomous loop scan fires.
  loadRecoveryStateFromDb()
    .then(() => resumeEngineIfEnabled())
    .catch((err) => logger.warn({ err }, "Recovery state load / engine auto-resume on startup failed"));
  loadDynamicConfidence().catch((err) => logger.warn({ err }, "Dynamic confidence load on startup failed"));
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
