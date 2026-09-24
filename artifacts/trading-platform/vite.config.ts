import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { WEB_CONSOLE_IDS } from "./src/lib/console-contract";

// Default to 5000 — Replit's standard webview port, required for autoStart preview.
const rawPort = process.env.PORT ?? "5000";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Default to "/" — safe for any hosting context.
const basePath = process.env.BASE_PATH ?? "/";

// ── Release stamp ─────────────────────────────────────────────────────────────
// The web and API services deploy independently, so every build carries the
// commit it came from plus the bot consoles it implements. The bundle compares
// that against `/api/healthz` / `/api/bots` and shows an "update available"
// panel when the two services are on different releases, instead of silently
// rendering the wrong bot consoles (see src/lib/console-contract.ts).
const releaseSha =
  (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? process.env.COMMIT_SHA ?? "")
    .trim() || "unknown";
const webRelease = {
  service: "web" as const,
  sha: releaseSha,
  shortSha: releaseSha.slice(0, 7),
  builtAt: new Date().toISOString(),
  environment:
    (process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "local").trim() || "local",
  consoles: [...WEB_CONSOLE_IDS],
};

/**
 * Emits `release.json` next to the built assets so the production server
 * (scripts/serve-production.mjs → `/__release`) and `check:release` can report
 * exactly which build is deployed — the missing piece that let a stale web
 * service run unnoticed.
 */
function releaseManifest(): Plugin {
  return {
    name: "neurotrade-release-manifest",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(import.meta.dirname, "dist/public");
      fs.writeFileSync(path.join(outDir, "release.json"), `${JSON.stringify(webRelease, null, 2)}\n`);
    },
  };
}

export default defineConfig({
  base: basePath,
  define: {
    // Read at runtime by src/lib/release.ts (and printed in the Bot Arena's
    // release-skew panel).
    __WEB_RELEASE__: JSON.stringify(webRelease),
  },
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    releaseManifest(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      // Bot Studio: the vendored Deriv DBot builder runs as its own rsbuild dev
      // server on 4003 and is mounted under /bot/ so it shares this origin (and
      // therefore the platform's session cookie + localStorage) — that is what
      // makes the builder open already signed in.
      //
      // No rewrite: the builder dev server is itself mounted under /bot
      // (rsbuild `server.base`), so its HTML, assets and HMR socket all resolve
      // through this proxy unchanged.
      "/bot": {
        target: "http://localhost:4003",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
