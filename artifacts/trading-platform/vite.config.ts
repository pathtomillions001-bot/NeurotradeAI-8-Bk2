import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { BOT_CONSOLE_CONTRACT_VERSION } from "@workspace/deployment-contract";

// Default to 5000 — Replit's standard webview port, required for autoStart preview.
const rawPort = process.env.PORT ?? "5000";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Default to "/" — safe for any hosting context.
const basePath = process.env.BASE_PATH ?? "/";

const releaseMetadata = {
  commit:
    process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    process.env.GIT_COMMIT_SHA?.trim() ||
    "development",
  service:
    process.env.RAILWAY_SERVICE_NAME?.trim() ||
    process.env.SERVICE_NAME?.trim() ||
    "trading-platform",
  botConsoleContract: BOT_CONSOLE_CONTRACT_VERSION,
};

const releaseModuleId = "virtual:neurotrade-release";
const resolvedReleaseModuleId = `\0${releaseModuleId}`;

/** Provide build provenance to the browser and to the production healthcheck. */
function releaseMetadataPlugin(): Plugin {
  return {
    name: "neurotrade-release-metadata",
    resolveId(id) {
      return id === releaseModuleId ? resolvedReleaseModuleId : null;
    },
    load(id) {
      return id === resolvedReleaseModuleId
        ? `export default ${JSON.stringify(releaseMetadata)};`
        : null;
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "release.json",
        source: `${JSON.stringify(releaseMetadata, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    releaseMetadataPlugin(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
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
      "@assets": path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "attached_assets",
      ),
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
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
