#!/usr/bin/env node

/**
 * Verify that the public domain serves a release-aware web bundle and a
 * compatible API. This is intentionally dependency-free so it can be run from
 * a laptop, CI, or a Railway shell.
 *
 *   pnpm verify:production
 *   EXPECTED_WEB_COMMIT=<sha> EXPECTED_API_COMMIT=<sha> pnpm verify:production
 */

const baseUrl = (
  process.env.PRODUCTION_URL || "https://neuro-trade.site"
).replace(/\/+$/, "");

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} returned ${response.status} but not JSON (likely a stale SPA fallback)`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function matchesExpected(actual, expected) {
  return (
    !expected ||
    actual === expected ||
    actual.startsWith(expected) ||
    expected.startsWith(actual)
  );
}

try {
  const [web, api] = await Promise.all([
    getJson("/__healthz"),
    getJson("/api/healthz"),
  ]);
  const webRelease = requireValue(
    web.release,
    "Web health response has no release metadata",
  );
  const apiRelease = requireValue(
    api.release,
    "API health response has no release metadata",
  );
  const webContract = requireValue(
    webRelease.botConsoleContract,
    "Web release has no bot-console contract",
  );
  const apiContract = requireValue(
    apiRelease.botConsoleContract,
    "API release has no bot-console contract",
  );

  if (webContract !== apiContract) {
    throw new Error(
      `Bot-console contract mismatch: web=${webContract}, api=${apiContract}`,
    );
  }
  if (!matchesExpected(webRelease.commit, process.env.EXPECTED_WEB_COMMIT)) {
    throw new Error(
      `Web is ${webRelease.commit}, expected ${process.env.EXPECTED_WEB_COMMIT}`,
    );
  }
  if (!matchesExpected(apiRelease.commit, process.env.EXPECTED_API_COMMIT)) {
    throw new Error(
      `API is ${apiRelease.commit}, expected ${process.env.EXPECTED_API_COMMIT}`,
    );
  }

  console.log(`Production parity OK: ${baseUrl}`);
  console.log(`  web ${webRelease.commit} (${webRelease.service})`);
  console.log(`  api  ${apiRelease.commit} (${apiRelease.service})`);
  console.log(`  contract ${webContract}`);
} catch (error) {
  console.error(`Production parity FAILED: ${baseUrl}`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
