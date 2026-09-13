import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool, schemaReady } from "@workspace/db";
import { tickManager } from "../lib/deriv";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Health check with deployment diagnostics.
 *
 * The extra fields (db, deriv, tickFeed) are additive diagnostics — the core
 * `{ status: "ok" }` contract is unchanged so the Railway healthcheck and the
 * generated API clients keep working.
 *
 * Open https://<your-web-domain>/api/healthz after deploying to instantly see:
 *  - db.ok / db.tablesMissing — whether the Postgres schema exists (a missing
 *    schema is the root cause of "settings don't save", "can't connect Deriv",
 *    "no market data").
 *  - deriv.appIdConfigured — whether DERIV_APP_ID is set (required for
 *    OAuth "Sign in with Deriv").
 *  - tickFeed — whether the Deriv public WebSocket is delivering live ticks.
 */
router.get("/healthz", async (_req, res) => {
  const base = HealthCheckResponse.parse({ status: "ok" });

  // ── DB diagnostics ────────────────────────────────────────────────────────
  let dbDiag: {
    ok: boolean;
    external: boolean;
    tablesMissing: string[];
    error?: string;
  } = { ok: false, external: false, tablesMissing: [] };
  try {
    await schemaReady;
    const { rows } = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'settings') AS settings,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'accounts') AS accounts,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'trades')   AS trades,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'adaptive_thresholds') AS adaptive`
    );
    const missing: string[] = [];
    if (Number(rows[0].settings) === 0) missing.push("settings");
    if (Number(rows[0].accounts) === 0) missing.push("accounts");
    if (Number(rows[0].trades) === 0) missing.push("trades");
    if (Number(rows[0].adaptive) === 0) missing.push("adaptive_thresholds");
    dbDiag = {
      ok: missing.length === 0,
      external: Boolean(process.env.DATABASE_URL),
      tablesMissing: missing,
    };
  } catch (err) {
    dbDiag = {
      ok: false,
      external: Boolean(process.env.DATABASE_URL),
      tablesMissing: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Deriv config diagnostics ─────────────────────────────────────────────
  const { APP_ID } = await import("../lib/deriv");

  res.json({
    ...base,
    db: dbDiag,
    deriv: {
      appIdConfigured: Boolean(APP_ID),
      hint: APP_ID
        ? undefined
        : "Set DERIV_APP_ID on the api service (and VITE_DERIV_APP_ID on web, then rebuild web). Register your Railway <web-domain>/connect as a redirect URL at app.deriv.com/apps.",
    },
    tickFeed: tickManager.getTickHealth(),
    ts: new Date().toISOString(),
  });

  if (!dbDiag.ok) {
    logger.warn({ db: dbDiag }, "Healthz reports missing DB tables — schema bootstrap did not complete");
  }
});

export default router;