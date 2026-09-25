/**
 * Production static server for the trading-platform SPA.
 *
 * Why this exists (Railway / two-service deploy):
 * - The browser talks to same-origin `/api/*` (cookies, EventSource/SSE, relative fetch).
 * - Vite's dev proxy only exists in `vite dev` — production needs an explicit reverse proxy.
 * - Build output lives at `dist/public` (see vite.config.ts), not plain `dist`.
 *
 * Env:
 *   PORT              — listen port (Railway injects this)
 *   API_UPSTREAM      — upstream API base, e.g. http://api.railway.internal:8080
 *                       Falls back to http://127.0.0.1:8080 for local smoke tests.
 *
 * Fix for release-skew incident (2026-09-19):
 * - Old web bundle at 39300a9 had no __release handler, so /__release fell through
 *   to index.html (200) and Railway healthcheck passed while bot consoles were wrong.
 * - Now /__release and /release.json are handled explicitly BEFORE static handler,
 *   always returning JSON with no-store cache, so healthcheck and deployment
 *   verification can never be fooled by SPA fallback.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import handler from "serve-handler";
import httpProxy from "http-proxy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const publicDir = path.resolve(packageRoot, "dist/public");

const rawPort = process.env.PORT ?? "5000";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const upstream =
  (process.env.API_UPSTREAM ?? process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8080").replace(
    /\/+$/,
    "",
  );

if (!fs.existsSync(publicDir)) {
  console.error(
    `[web] Static build not found at ${publicDir}. Run: pnpm --filter @workspace/trading-platform build`,
  );
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({
  target: upstream,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  proxyTimeout: 0,
  timeout: 0,
});

proxy.on("error", (err, _req, res) => {
  console.error("[web] API proxy error:", err.message);
  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Bad gateway — API upstream unreachable", detail: err.message }));
  }
});

function readOwnRelease() {
  try {
    return JSON.parse(fs.readFileSync(path.join(publicDir, "release.json"), "utf8"));
  } catch {
    return { service: "web", sha: "unknown", shortSha: "unknown", builtAt: null, environment: "unknown", consoles: [] };
  }
}
const ownRelease = readOwnRelease();

async function releaseReport() {
  const web = ownRelease;
  let api = null;
  let apiError = null;
  try {
    const response = await fetch(`${upstream}/api/healthz`, {
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const body = await response.json();
      api = { release: body.release ?? null, consoles: body.consoles ?? [] };
    } else {
      apiError = `API healthz responded ${response.status}`;
    }
  } catch (error) {
    apiError = error instanceof Error ? error.message : String(error);
  }

  const webConsoles = new Set(web.consoles ?? []);
  const apiConsoles = new Set(api?.consoles ?? []);
  const missingHere = [...apiConsoles].filter(id => !webConsoles.has(id)).sort();
  const missingOnApi = [...webConsoles].filter(id => !apiConsoles.has(id)).sort();

  return {
    status: "ok",
    web,
    api: api ? { ...api.release, consoles: api.consoles } : null,
    apiError,
    parity: apiError || missingHere.length > 0 ? "skew" : "ok",
    missingConsolesHere: missingHere,
    consolesNotOnApi: missingOnApi,
    hint:
      missingHere.length > 0
        ? `This web build (${web.shortSha}) cannot render ${missingHere.join(", ")} — redeploy the web service from main; do not Redeploy the old deployment.`
        : undefined,
    ts: new Date().toISOString(),
  };
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];

  // ── Release endpoints — MUST be before static handler ────────────────────
  if (pathname === "/__release") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("access-control-allow-origin", "*");
    releaseReport()
      .then(report => {
        if (!res.writableEnded) {
          res.writeHead(200);
          res.end(JSON.stringify(report, null, 2));
        }
      })
      .catch(error => {
        if (!res.writableEnded) {
          res.writeHead(200);
          res.end(JSON.stringify({ status: "error", detail: String(error), web: ownRelease }, null, 2));
        }
      });
    return undefined;
  }

  if (pathname === "/release.json") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("access-control-allow-origin", "*");
    try {
      const data = fs.readFileSync(path.join(publicDir, "release.json"), "utf8");
      res.writeHead(200);
      res.end(data);
    } catch {
      res.writeHead(200);
      res.end(JSON.stringify(ownRelease, null, 2));
    }
    return undefined;
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return proxy.web(req, res, { target: upstream });
  }

  return handler(req, res, {
    public: publicDir,
    rewrites: [{ source: "**", destination: "/index.html" }],
    directoryListing: false,
    headers: [
      {
        source: "**/*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "assets/**",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ],
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    proxy.ws(req, socket, head, { target: upstream });
    return;
  }
  socket.destroy();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[web] Serving ${publicDir} on 0.0.0.0:${port}`);
  console.log(`[web] Proxying /api → ${upstream}`);
  console.log(`[web] Release: ${ownRelease.shortSha} consoles=${(ownRelease.consoles ?? []).join(",")}`);
});

process.on("uncaughtException", (err) => {
  console.error("[web] uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[web] unhandledRejection", err);
});
