// Capture real screenshots for the NeuroTrade AI user guide.
//
//   npm i -D playwright && npx playwright install chromium
//   node docs/guide/capture-screenshots.mjs
//
// Optional: BASE_URL=http://localhost:5000 VIEWPORT=1600x1000 node docs/guide/capture-screenshots.mjs
//
// Writes PNGs into docs/guide/shots/. Re-running the guide build
// (python3 docs/guide/build_user_guide.py) then swaps each matching schematic
// for the real capture automatically — no other edit needed.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:5000";
const [VW, VH] = (process.env.VIEWPORT ?? "1500x950").split("x").map(Number);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(OUT, { recursive: true });

// The four names below are the guide's figure slots. Extra names are captured too
// so they are ready when figures are added to the guide.
const ROUTES = [
  { name: "dashboard", path: "/", settle: 2500 },
  { name: "connect", path: "/connect", settle: 1500 },
  { name: "markets", path: "/markets", settle: 2000 },
  { name: "market-detail", path: "/markets/R_100", settle: 2500 },
  { name: "bots", path: "/bots", settle: 1500 },
  { name: "settings", path: "/settings", settle: 1500 },
  { name: "journal", path: "/trades", settle: 1500 },
  { name: "analytics", path: "/analytics", settle: 2000 },
  { name: "intelligence", path: "/intelligence", settle: 2000 },
  { name: "risk-calculator", path: "/risk-calculator", settle: 1500 },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 2, // retina capture, keeps small UI type legible in print
});
const page = await ctx.newPage();

// The app shows a landing gate until an account exists. Capturing a session with
// a synthetic account lets the real UI render; if you have a connected browser
// profile, reuse it and delete this block.
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("nt_capture_bypass_landing", "1");
  } catch {}
});

const shot = async (p, name) => {
  await p.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  console.log(`  ✓ ${name}.png`);
};

for (const { name, path, settle = 1500 } of ROUTES) {
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(settle);
    await shot(page, name);
  } catch (e) {
    console.warn(`  ! ${name}: ${String(e).split("\n")[0].slice(0, 110)}`);
  }
}

// Figure 3 target: the NeuroAI Quantum FAB panel, opened and left on the config step.
try {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const fab =
    page.getByRole("button", { name: /NeuroAI Engine/i }) ??
    page.locator('[aria-label="NeuroAI Engine"]');
  await fab.first().click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  await shot(page, "fab");
} catch (e) {
  console.warn("  ! fab: could not open the FAB panel —", String(e).split("\n")[0].slice(0, 90));
}

// Figure 4 target: a bot deploy console, opened over the arena.
try {
  await page.goto(BASE + "/bots", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.getByText(/Deploy/i).first().click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  await shot(page, "bots");
} catch (e) {
  console.warn("  ! bots console: could not open a deploy console —", String(e).split("\n")[0].slice(0, 90));
}

await browser.close();
console.log(`\nwrote captures to ${OUT}`);
console.log("then: python3 docs/guide/build_user_guide.py");
