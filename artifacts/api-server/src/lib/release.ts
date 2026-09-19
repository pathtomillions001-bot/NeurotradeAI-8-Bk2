/**
 * Release identity for the API service.
 *
 * WHY THIS EXISTS
 * ---------------
 * The web bundle and the API are TWO independent Railway services built from
 * two different watch paths. Nothing used to tie them together, so a web
 * service that stopped picking up commits could keep serving an old Bot Arena
 * against a current API. That is exactly how Match Pulse, Twin-Hedge Edge and
 * the Compounding Range Sentinel ended up rendering their *previous* controls
 * on production while this checkout (one build, one commit) looked correct:
 *
 *   production web  = 39300a9 (PR #27, 2026-09-14)  ← stale bundle
 *   production api  = 1d7b39f (PR #33, 2026-09-19)  ← current
 *
 * The stale bundle does not know about the new consoles, so it silently opened
 * the generic specialist console for them. Silent fallbacks are the bug: the
 * page looked fine, so nobody could see the skew.
 *
 * The API therefore publishes (a) the commit it was built from and (b) the set
 * of bot-console ids its catalogue expects. The web bundle compares that set
 * with the consoles it implements and refuses to pretend (`/__release`,
 * `/api/healthz`, and the "update available" panel on the Bot Arena).
 */

export interface ReleaseInfo {
  service: "api" | "web";
  /** Full git commit the artifact was built from. */
  sha: string;
  /** First 7 characters of `sha`, for log lines and UI. */
  shortSha: string;
  /** ISO timestamp of the build, when the platform provides one. */
  builtAt: string | null;
  /** Railway environment name, or "local" outside Railway. */
  environment: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Git commit of this API build.
 *
 * Railway injects `RAILWAY_GIT_COMMIT_SHA` into the build environment; the
 * other names cover other CI systems and local builds with the variable set
 * by hand. `unknown` is deliberate — it is visible in `/api/healthz` instead
 * of pretending to be a real release.
 */
const API_SHA =
  firstNonEmpty(
    process.env["RAILWAY_GIT_COMMIT_SHA"],
    process.env["GIT_COMMIT_SHA"],
    process.env["COMMIT_SHA"],
    process.env["SOURCE_VERSION"],
  ) || "unknown";

export const API_RELEASE: ReleaseInfo = {
  service: "api",
  sha: API_SHA,
  shortSha: API_SHA.slice(0, 7),
  builtAt: firstNonEmpty(process.env["BUILD_TIME"]) || null,
  environment: firstNonEmpty(process.env["RAILWAY_ENVIRONMENT_NAME"], process.env["NODE_ENV"]) || "local",
};
