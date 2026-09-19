/**
 * First-paint routing check (dev-only; the app never imports this).
 *
 * Renders the real App component in Node via Vite SSR and inspects the FIRST
 * paint for several URLs. Run with: pnpm --filter @workspace/trading-platform \
 *   run check:first-paint
 *
 * Guards the reported refresh bug:
 *   - "/"     with the account check still pending → boot splash only
 *             (the old code painted Layout+Dashboard here: the refresh flash)
 *   - "/bots", "/trades", "/connect" → the requested page renders in place
 *             (the old code replaced them with the landing page: the bounce)
 */
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const root = new URL("../", import.meta.url).pathname;
const server = await createServer({
  configFile: root + "vite.config.ts",
  root,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

// ── Minimal browser globals so wouter can read the URL in SSR ──────────────
const noop = () => {};
globalThis.window = {
  location: { pathname: "/", search: "", href: "http://localhost/" },
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
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const App = (await server.ssrLoadModule("/src/App.tsx")).default;

const MARKERS = {
  splash: 'data-testid="boot-splash"',
  layout: ">Risk Calc<",
  landing: ">Market Open<",
};

function describe(html) {
  return Object.entries(MARKERS)
    .filter(([, marker]) => html.includes(marker))
    .map(([name]) => name)
    .join("+") || "empty";
}

const cases = [
  { url: "/", expect: "splash" },
  { url: "/bots", expect: "layout", note: "refresh on Bots stays on Bots" },
  { url: "/trades", expect: "layout", note: "refresh on Journal stays on Journal" },
  { url: "/connect", expect: "layout", note: "OAuth landing route is never gated" },
  { url: "/connect?code=abc&state=xyz", expect: "layout", note: "OAuth callback with query works" },
  { url: "/markets/cryBTCUSD", expect: "layout", note: "deep dynamic route" },
];

let failures = 0;
for (const c of cases) {
  globalThis.location.pathname = c.url.split("?")[0];
  globalThis.location.search = c.url.includes("?") ? "?" + c.url.split("?")[1] : "";
  const html = renderToString(createElement(App));
  const painted = describe(html);
  const ok = painted.split("+").includes(c.expect);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.url.padEnd(28)} first paint: ${painted.padEnd(12)} expected: ${c.expect}${c.note ? "   // " + c.note : ""}`,
  );
}

// ── Returning visitor: the funnel must never come back for them ────────────
globalThis.localStorage._d["neurotrade_landing_dismissed"] = "1";
globalThis.location.pathname = "/";
globalThis.location.search = "";
const returning = describe(renderToString(createElement(App)));
const returningOk = returning === "layout";
if (!returningOk) failures++;
console.log(
  `${returningOk ? "PASS" : "FAIL"}  ${"/ (returning visitor)".padEnd(28)} first paint: ${returning.padEnd(12)} expected: layout`,
);

await server.close();
console.log(failures === 0 ? "\nALL RENDER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
