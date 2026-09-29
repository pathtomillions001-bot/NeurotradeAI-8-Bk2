import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { BUILDER_STAMP_FILE, hashBuilderSources, readBuilderStamp } from "./scripts/bot-skeleton-hash.mjs";
import { WEB_CONSOLE_IDS } from "./src/lib/console-contract";

// Default to 5000 — Replit's standard webview port, required for autoStart preview.
const rawPort = process.env.PORT ?? "5000";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Default to "/" — safe for any hosting context.
const basePath = process.env.BASE_PATH ?? "/";

// ── Deriv bot builder dev serve ──────────────────────────────────────────────
// The bot builder is a standalone rsbuild app (artifacts/dbot-builder) that the
// Production build compiles and copies into dist/public/bot/preview. Production
// serves that bundle directly; dev has no such bundle unless it's built, and the
// legacy /bot/preview proxy pointed at a :4003 rsbuild process that nothing
// starts. That left a fresh dev instance showing an empty iframe (or a 404 when
// the page route was missing).
//
// This plugin reuses rsbuild's static output (out/preview) when it exists, so a
// developer who has ever built the builder gets a working /bot/preview with zero
// extra processes — matching production's behaviour exactly. When the output is
// absent it falls through to the legacy /bot/preview proxy (rsbuild dev on :4003)
// for incremental builder work, and finally to a 404 with a clear hint.
function botPreviewDevServe(): Plugin {
  const builderOut = path.resolve(
    __dirname,
    "..",
    "dbot-builder",
    "out",
    "preview",
  );
  const mime = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".wav", "audio/wav"],
    [".webp", "image/webp"],
    [".mp4", "video/mp4"],
    [".wasm", "application/wasm"],
  ]);

  const stripPrefix = "/bot/preview/";
  const indexFile = path.join(builderOut, "index.html");

  // ── Builder bundle parity ────────────────────────────────────────────────────
  // The bundle in out/preview is a PREBUILT, gitignored artifact. Before the
  // stamp existed, `vite dev` happily served a bundle that was days (or
  // working-tree-states) behind src/external/bot-skeleton — and the only
  // symptom surfaced when the user pressed Run in the Bot Builder and the
  // stale runtime choked on a strategy the current sources generate (the
  // ".epoch is not a function" incident). Compare the stamped content hash
  // with the live sources at boot and expose the verdict so the Bot Arena can
  // show an actionable panel instead of a cryptic interpreter error.
  let parity: {
    stamped: boolean;
    stale: boolean;
    reason: "no-bundle" | "unstamped" | "hash-mismatch" | "ok" | "sources-unavailable";
    stampSha?: string;
    stampSkeletonHash?: string;
    stampBuiltAt?: string | null;
    currentSkeletonHash?: string | null;
    rebuildCommand: string;
  };

  function computeParity(): typeof parity {
    const rebuildCommand = "pnpm --filter @workspace/trading-platform exec node scripts/build-dbot-builder.mjs";
    if (!fs.existsSync(indexFile)) {
      return {
        stamped: false,
        stale: false,
        reason: "no-bundle" as const,
        rebuildCommand,
      };
    }
    const stamp = readBuilderStamp(builderOut);
    const current = hashBuilderSources();
    if (!stamp) {
      return {
        stamped: false,
        stale: true,
        reason: "unstamped" as const,
        stampBuiltAt: null,
        currentSkeletonHash: current?.hash ?? null,
        rebuildCommand,
      };
    }
    if (!current) {
      return {
        stamped: true,
        stale: false,
        reason: "sources-unavailable" as const,
        stampSha: stamp.sha,
        stampSkeletonHash: stamp.skeletonHash,
        stampBuiltAt: stamp.builtAt ?? null,
        currentSkeletonHash: null,
        rebuildCommand,
      };
    }
    const stale = stamp.skeletonHash !== current.hash;
    return {
      stamped: true,
      stale,
      reason: stale ? ("hash-mismatch" as const) : ("ok" as const),
      stampSha: stamp.sha,
      stampSkeletonHash: stamp.skeletonHash,
      stampBuiltAt: stamp.builtAt ?? null,
      currentSkeletonHash: current.hash,
      rebuildCommand,
    };
  }

  return {
    name: "neurotrade-bot-preview-dev-serve",
    configureServer(server) {
      const outputReadyAtBoot = fs.existsSync(indexFile);
      if (!outputReadyAtBoot) {
        server.config.logger.info(
          "[bot-preview] Builder output not found — falling back to the /bot/preview " +
            "proxy (rsbuild dev on :4003). For a zero-process dev preview, run " +
            "`node scripts/build-dbot-builder.mjs` once, then restart `vite dev`.",
        );
      }

      parity = computeParity();
      if (parity.reason === "unstamped") {
        server.config.logger.warn(
          "[bot-preview] ⚠️  The Bot Builder bundle in artifacts/dbot-builder/out was built BEFORE build " +
            "stamping existed, so it CANNOT be verified against the current sources. It very likely runs " +
            "outdated bot-runtime code. Rebuild it once:\n" +
            `    ${parity.rebuildCommand}\n` +
            "then restart `vite dev`.",
        );
      } else if (parity.reason === "hash-mismatch") {
        server.config.logger.warn(
          `[bot-preview] ⚠️  STALE Bot Builder bundle: built ${parity.stampBuiltAt ?? "unknown date"} ` +
            `(skeleton ${parity.stampSkeletonHash}) but the sources are now ${parity.currentSkeletonHash}. ` +
            "The embedded builder will run OLD bot-runtime code against NEW forge strategies — Run in the " +
            "Bot Builder can fail with errors that never mention staleness. Rebuild it:\n" +
            `    ${parity.rebuildCommand}\n` +
            "then restart `vite dev`.",
        );
      } else if (parity.reason === "ok") {
        server.config.logger.info(
          `[bot-preview] Builder bundle verified current (skeleton ${parity.currentSkeletonHash}, built ${parity.stampBuiltAt ?? "unknown"}).`,
        );
      }

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        const pathname = url.split("?")[0];
        if (pathname !== "/bot/preview" && !pathname.startsWith(stripPrefix)) {
          return next();
        }

        // Machine-readable parity verdict for the Bot Arena's stale-bundle
        // panel. Computed per request so a rebuild is picked up without a
        // vite restart (the file middleware below serves the new bundle).
        if (pathname === "/bot/preview/__parity" || pathname === `${stripPrefix}__parity`) {
          parity = computeParity();
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(parity));
          return undefined;
        }

        // The stamp itself is served like any other static file below, but
        // never let a MISSING stamp fall through to the SPA (index.html).
        if (pathname === `/bot/preview/${BUILDER_STAMP_FILE}` && !readBuilderStamp(builderOut)) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Builder bundle predates build stamping — rebuild it." }));
          return undefined;
        }

        // When the builder bundle isn't available, defer to the legacy /bot/preview
        // proxy so incremental builder work (rsbuild dev on :4003) still functions.
        // Checked per request (not captured at boot) so a bundle built AFTER the
        // dev server started is served immediately — no restart needed.
        if (!fs.existsSync(indexFile)) return next();

        const relative = decodeURIComponent(
          pathname.replace(/^\/bot\/preview\/?/, ""),
        );
        const requested = relative
          ? path.resolve(builderOut, relative)
          : indexFile;
        const safe =
          requested === builderOut || requested.startsWith(`${builderOut}${path.sep}`);
        // Unknown nested paths get the SPA fallback (index.html), matching production.
        const filePath =
          safe && fs.existsSync(requested) && fs.statSync(requested).isFile()
            ? requested
            : indexFile;

        if (fs.existsSync(filePath)) {
          res.setHeader(
            "content-type",
            mime.get(path.extname(filePath)) ?? "application/octet-stream",
          );
          fs.createReadStream(filePath).pipe(res);
          return undefined;
        }

        res.statusCode = 404;
        res.end("Bot builder output missing. Run `node scripts/build-dbot-builder.mjs` then restart `vite dev`.");
        return undefined;
      });
    },
  };
}

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
    botPreviewDevServe(),
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
      // Development mount for the unmodified Deriv bot builder. Start it with:
      //   NEXT_PUBLIC_APP_BUILD=true NEXT_PUBLIC_DERIV_APP_ID=$DERIV_APP_ID npm --prefix artifacts/dbot-builder run dev -- --host 0.0.0.0
      // Production copies its static build into dist/public/bot/preview.
      "/bot/preview": {
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
