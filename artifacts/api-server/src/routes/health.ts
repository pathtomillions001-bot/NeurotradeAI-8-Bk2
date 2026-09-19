import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool, schemaReady } from "@workspace/db";
import { accountConnectionCount, tickManager } from "../lib/deriv";
import { logger } from "../lib/logger";
import { deploymentRelease } from "../lib/deployment-release";

const router: IRouter = Router();

// ── Deriv OAuth client probe (cached 5 minutes) ──────────────────────────────
//
// DERIV_APP_ID being *set* is not the same as it being *registered*. When the
// app id does not exist, Deriv's authorization endpoint 302s to an error page
// with error=invalid_client — which is the root cause of "Sign in with Deriv"
// bouncing users to a Deriv error page, and of PAT connects being rejected with
// 401 (PAT auth requires a valid registered Deriv-App-ID). Probe the endpoint
// here so `GET /api/healthz` reports the real status instantly.

type OauthClientStatus = "ok" | "not_configured" | "unregistered" | "unknown";

interface OauthClientProbe {
  status: OauthClientStatus;
  detail?: string;
  checkedAt: string;
}

let oauthClientProbeCache: { value: OauthClientProbe; expiresAt: number } | null = null;
const OAUTH_PROBE_TTL_MS = 5 * 60 * 1000;

async function probeDerivOauthClient(appId: string, authBase: string): Promise<OauthClientProbe> {
  const checkedAt = new Date().toISOString();
  if (oauthClientProbeCache && oauthClientProbeCache.expiresAt > Date.now()) {
    return oauthClientProbeCache.value;
  }

  let value: OauthClientProbe;
  if (!appId) {
    value = { status: "not_configured", checkedAt };
  } else {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: appId,
      redirect_uri: "https://example.com/callback",
      scope: "trade",
      state: "healthz-probe",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    try {
      const res = await fetch(`${authBase}/oauth2/auth?${params.toString()}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      // Deriv responds with a 302 to an error page when the request is
      // rejected. error=invalid_client means the app id itself is not
      // registered. Any other error (e.g. about this probe's dummy redirect
      // URI) still proves the client exists, so it counts as "ok".
      const location = res.headers.get("location") ?? "";
      const errMatch = /[?&]error=([^&]+)/.exec(location);
      if (errMatch && decodeURIComponent(errMatch[1]!) === "invalid_client") {
        value = {
          status: "unregistered",
          detail:
            `Deriv does not recognize DERIV_APP_ID "${appId}". Register the app at ` +
            "https://app.deriv.com/apps, add this site's /connect URL (e.g. " +
            "https://neuro-trade.site/connect) as an allowed redirect URL, then update " +
            "DERIV_APP_ID on the api service (and VITE_DERIV_APP_ID on web) and redeploy.",
          checkedAt,
        };
      } else {
        value = { status: "ok", checkedAt };
      }
    } catch {
      value = {
        status: "unknown",
        detail: "Could not reach auth.deriv.com to verify the app id",
        checkedAt,
      };
    }
  }

  oauthClientProbeCache = { value, expiresAt: Date.now() + OAUTH_PROBE_TTL_MS };
  return value;
}

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
  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
      ),
    ]);

  try {
    await withTimeout(schemaReady, 3000, "schemaReady");
    const { rows } = await withTimeout<{ rows: Array<Record<string, unknown>> }>(
      pool.query(
        `SELECT
          (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'settings') AS settings,
          (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'accounts') AS accounts,
          (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'trades')   AS trades,
          (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'adaptive_thresholds') AS adaptive`,
      ),
      3000,
      "db healthz query",
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
  const { APP_ID, DERIV_AUTH_BASE } = await import("../lib/deriv");
  const oauthClient = await probeDerivOauthClient(APP_ID, DERIV_AUTH_BASE);

  res.json({
    ...base,
    release: deploymentRelease,
    db: dbDiag,
    deriv: {
      appIdConfigured: Boolean(APP_ID),
      appId: APP_ID || undefined,
      oauthClient,
      hint: APP_ID
        ? undefined
        : "Set DERIV_APP_ID on the api service (and VITE_DERIV_APP_ID on web, then rebuild web). Register your Railway <web-domain>/connect as a redirect URL at app.deriv.com/apps.",
    },
    tickFeed: tickManager.getTickHealth(),
    // Authenticated sockets currently held. Deriv allows 5 concurrent
    // WebSockets per user; the pool keeps this at one per traded account.
    derivSockets: accountConnectionCount(),
    ts: new Date().toISOString(),
  });

  if (!dbDiag.ok) {
    logger.warn({ db: dbDiag }, "Healthz reports missing DB tables — schema bootstrap did not complete");
  }
  if (oauthClient.status === "unregistered") {
    logger.warn(
      { appId: APP_ID, detail: oauthClient.detail },
      "Healthz: DERIV_APP_ID is not a registered Deriv OAuth client — Sign in with Deriv and PAT connects will fail",
    );
  }
});

export default router;