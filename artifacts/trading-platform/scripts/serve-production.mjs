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

const releasePath = path.join(publicDir, "release.json");
let release = null;
try {
  release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
} catch (err) {
  console.error(`[web] Release metadata missing or invalid at ${releasePath}:`, err.message);
}

const proxy = httpProxy.createProxyServer({
  target: upstream,
  changeOrigin: true,
  xfwd: true,
  // EventSource / long-lived responses
  ws: true,
  // Don't time out SSE streams aggressively
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

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const pathname = url.split("?", 1)[0];

  // This healthcheck proves which browser bundle is actually serving users.
  // Checking only "/" allowed a months-old SPA to remain "healthy" forever.
  if (pathname === "/__healthz") {
    const healthy = Boolean(release?.commit && release?.botConsoleContract);
    res.writeHead(healthy ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(release?.commit ? { "x-neurotrade-web-release": String(release.commit) } : {}),
    });
    res.end(JSON.stringify({ status: healthy ? "ok" : "error", service: "web", release }));
    return;
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return proxy.web(req, res, { target: upstream });
  }

  if (release?.commit) res.setHeader("x-neurotrade-web-release", String(release.commit));
  return handler(req, res, {
    public: publicDir,
    // SPA fallback — wouter client routes
    rewrites: [{ source: "**", destination: "/index.html" }],
    // Don't directory-list
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
  if (url === "/api" || url.startsWith("/api/")) {
    proxy.ws(req, socket, head, { target: upstream });
    return;
  }
  socket.destroy();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[web] Serving ${publicDir} on 0.0.0.0:${port}`);
  console.log(`[web] Release ${release?.commit ?? "UNKNOWN"} · ${release?.botConsoleContract ?? "NO CONTRACT"}`);
  console.log(`[web] Proxying /api → ${upstream}`);
});

// Keep process alive on proxy hiccups
process.on("uncaughtException", (err) => {
  console.error("[web] uncaughtException", err);
});
