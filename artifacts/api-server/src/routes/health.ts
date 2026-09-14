import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool, schemaReady } from "@workspace/db";
import { accountConnectionCount, tickManager } from "../lib/deriv";
import { logger } from "../lib/logger";
import { botConsoleIds } from "../lib/bot-catalog";
import { API_RELEASE } from "../lib/release";

const router: IRouter = Router();

// ── Deriv OAuth client probe (cached 5 minutes) ──────────────────────────────
//
// DERIV_APP_ID being *set* is not the same as it being *registered*. When the
// app id does not exist, Deriv's authorization endpoint 302s to an error page
// with error=invalid_client — which is the root cause of "Sign in with Deriv"
// bouncing users to a Deriv error page, and of PAT connects being rejected with
// 401 (PAT auth requires a valid registered Deriv-App-ID). Probe the endpoint
// here so `GET /api/healthz` reports the real status instantly.

type OauthClientStatus = "ok" | "not_configured" | "unregistered" | "redirect_mismatch" | "unknown";

interface OauthClientProbe {
  status: OauthClientStatus;
  detail?: string;
  redirectUri?: string;
  checkedAt: string;
}

const oauthClientProbeCache = new Map<string, { value: OauthClientProbe; expiresAt: number }>();
const OAUTH_PROBE_TTL_MS = 60 * 1000;

async function probeDerivOauthClient(
  appId: string,
  authBase: string,
  redirectUri?: string,
): Promise<OauthClientProbe> {
  const checkedAt = new Date().toISOString();
  const cacheKey = `${appId}|${redirectUri ?? "dummy"}`;
  const cached = oauthClientProbeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let value: OauthClientProbe;
  if (!appId) {
    value = { status: "not_configured", checkedAt };
  } else {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: appId,
      redirect_uri: redirectUri ?? "https://example.com/callback",
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
      // registered. When probing with the app's REAL redirect URL (supplied by
      // the Connect page), ANY other error (typically invalid_request about
      // redirect_uri) is a genuine configuration problem every user will hit
      // on "Sign in with Deriv" — Deriv bounces them to its own
      // "We couldn't find that page" error page.
      const location = res.headers.get("location") ?? "";
      const errMatch = /[?&]error=([^&]+)/.exec(location);
      const errorCode = errMatch ? decodeURIComponent(errMatch[1]!) : null;
      if (errorCode === "invalid_client") {
        value = {
          status: "unregistered",
          detail:
            `Deriv does not recognize DERIV_APP_ID "${appId}". Register the app at ` +
            "https://app.deriv.com/apps, then update DERIV_APP_ID on the api service " +
            "(and VITE_DERIV_APP_ID on web) and redeploy.",
          checkedAt,
        };
      } else if (errorCode && redirectUri) {
        value = {
          status: "redirect_mismatch",
          detail:
            `Deriv rejected the redirect URL ${redirectUri} (${errorCode}). Open ` +
            "https://app.deriv.com/apps → your app → redirect URLs and add " +
            `${redirectUri} EXACTLY as written (https, no trailing slash), then try again.`,
          redirectUri,
          checkedAt,
        };
      } else {
        // Dummy-URI probe (no redirect_uri supplied — e.g. Railway healthcheck):
        // any non-invalid_client error still proves the client exists.
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

  oauthClientProbeCache.set(cacheKey, { value, expiresAt: Date.now() + OAUTH_PROBE_TTL_MS });
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
router.get("/healthz", async (req, res) => {
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
  // The Connect page passes ?redirect_uri=<its exact OAuth redirect URL> so the
  // probe verifies the REAL registration state users hit on "Sign in with Deriv".
  const { APP_ID, DERIV_AUTH_BASE } = await import("../lib/deriv");
  const redirectUriParam = typeof req.query["redirect_uri"] === "string"
    ? (req.query["redirect_uri"] as string)
    : undefined;
  const safeRedirectUri = redirectUriParam && /^https:\/\//.test(redirectUriParam)
    ? redirectUriParam
    : undefined;
  const oauthClient = await probeDerivOauthClient(APP_ID, DERIV_AUTH_BASE, safeRedirectUri);

  res.json({
    ...base,
    release: API_RELEASE,
    /**
     * Console ids the catalogue expects a web bundle to implement. The web
     * service compares this set with its own build (`/__release`) — a mismatch
     * means the two services are on different releases and the Bot Arena will
     * show an "update available" panel instead of the wrong controls.
     */
    consoles: botConsoleIds(),
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
  if (oauthClient.status === "unregistered" || oauthClient.status === "redirect_mismatch") {
    logger.warn(
      { appId: APP_ID, oauth: oauthClient },
      `Healthz: Deriv OAuth configuration problem (${oauthClient.status}) — Sign in with Deriv will fail`,
    );
  }
});

export default router;