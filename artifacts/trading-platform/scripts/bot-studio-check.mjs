/**
 * Bot Studio render check (dev-only; the app never imports this).
 *
 * Renders the real App at /bot-studio in Node via Vite SSR and inspects the
 * FIRST paint. Run with:
 *   pnpm --filter @workspace/trading-platform run check:bot-studio
 *
 * Written the same way as first-paint-check.mjs (same harness, same globals) so
 * it exercises the genuine app tree — router, layout, nav — rather than the page
 * in isolation. It guards the four ways this integration silently breaks:
 *
 *   1. the route stops matching, so /bot-studio falls through to Not Found;
 *   2. the "Bot Studio" menu entry disappears from the sidebar;
 *   3. the builder iframe stops pointing at the same-origin `/bot/` mount —
 *      which is exactly what makes the builder open ALREADY signed in on the
 *      platform's account (a cross-origin or absolute URL would force a second
 *      login, the thing this integration exists to remove);
 *   4. the not-connected state disappears, leaving someone with no account in
 *      front of a builder that cannot trade with no explanation.
 *
 * It also pins the SCAN → DBOT → RUN handshake, which spans three files and
 * would otherwise only fail in a browser:
 *
 *   5. the Over/Under Turbo console's primary action builds a DBot from the
 *      scanned lock (`POST /api/dbots`) and opens Bot Studio on it — the old
 *      server-side LOCKED/SWITCHING buttons must stay behind "Advanced";
 *   6. Bot Studio turns the builder's Run into `POST /api/dbots/:id/live` plus
 *      heartbeats (which is what mirrors fills into the journal + the shared
 *      recovery ledger) and forwards the app's kill switch to the iframe;
 *   7. the journal can tag those fills (the API marks them `isDbot`).
 *
 * The builder bundle itself is not loaded here — this is a routing/embedding
 * contract check, cheap enough to run on every change.
 */
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url).pathname;
const server = await createServer({
  configFile: root + "vite.config.ts",
  root,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

// ── Minimal browser globals so wouter/hooks can render in SSR ────────────────
const noop = () => {};
globalThis.window = {
  location: { pathname: "/bot-studio", search: "", href: "http://localhost/bot-studio" },
  addEventListener: noop,
  removeEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  history: { state: null },
};
globalThis.location = globalThis.window.location;
globalThis.history = { state: null, pushState: noop, replaceState: noop };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.localStorage = {
  _d: { neurotrade_landing_dismissed: "1" },
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
globalThis.sessionStorage = globalThis.localStorage;

const App = (await server.ssrLoadModule("/src/App.tsx")).default;
const { BOT_STUDIO_MOUNT } = await server.ssrLoadModule("/src/pages/bot-studio.tsx");
const html = renderToString(createElement(App));

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const turboConsole = read("../src/components/overunder-turbo-console.tsx");
const runBridge = read("../src/lib/dbot-run-bridge.ts");
const liveBots = read("../src/lib/live-bots.ts");
const journalPage = read("../src/pages/trades.tsx");

const CHECKS = [
  ["/bot-studio renders the Bot Studio page", () => html.includes("Bot Studio")],
  [
    "the builder mount is a same-origin path (never absolute/cross-origin)",
    () => BOT_STUDIO_MOUNT === "/bot/" && !/^https?:/i.test(BOT_STUDIO_MOUNT),
  ],
  [
    "the page points at that mount instead of a hosted Deriv bot",
    () => html.includes(BOT_STUDIO_MOUNT) && !html.includes("deriv.com"),
  ],
  ["it is reachable from the sidebar menu", () => /href="\/bot-studio"/.test(html)],
  [
    "the account binding is explained (trades land on the app's account)",
    () => html.includes("same account as NeuroTrade"),
  ],
  [
    "the turbo scan's primary action builds a Deriv DBot from the locked scan",
    () =>
      turboConsole.includes("Create Deriv DBot") &&
      /fetch\("\/api\/dbots"/.test(turboConsole) &&
      turboConsole.includes("/bot-studio?dbot="),
  ],
  [
    "the server-side engines stay available, but only behind Advanced",
    () =>
      turboConsole.includes("showAdvanced") &&
      turboConsole.includes("Advanced — run on the server instead") &&
      turboConsole.indexOf("Create Deriv DBot") < turboConsole.indexOf("Advanced — run on the server instead"),
  ],
  [
    "running a DBot claims the account lock and mirrors fills (live + heartbeat)",
    () => /api\/dbots\/\$\{dbotId\}\/live/.test(runBridge) && /heartbeat/.test(runBridge) && runBridge.includes("neurotrade:stop-bot"),
  ],
  [
    "leaving Bot Studio stops the run instead of leaving a live lock behind",
    () => /stop\("page-closed"\)/.test(runBridge),
  ],
  [
    "the live badge can open a running DBot in Bot Studio and stop that exact bot",
    () => liveBots.includes('return "/bot-studio"') && liveBots.includes("/api/dbots/${dbotId}/stop"),
  ],
  [
    "the journal badges DBot fills instead of showing them as anonymous trades",
    () => journalPage.includes("isDbot") && journalPage.includes("DBOT"),
  ],
];

for (const [name, ok] of CHECKS) console.log(`${ok() ? "PASS" : "FAIL"}  ${name}`);
await server.close();

const failures = CHECKS.filter(([, ok]) => !ok());
if (failures.length > 0) {
  console.error(`\n${failures.length} BOT STUDIO CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL BOT STUDIO CHECKS PASSED");
// Explicit exit: the Vite SSR context can keep handles alive, and this script is
// run from CI where a lingering process looks like a hang.
process.exit(0);
