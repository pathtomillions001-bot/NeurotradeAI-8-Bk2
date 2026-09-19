/**
 * Release identity of THIS web bundle.
 *
 * Injected at build time by vite.config.ts (`__WEB_RELEASE__`, written to
 * `dist/public/release.json` as well so the production server can report it).
 * The Bot Arena prints it next to the API's commit whenever the two services
 * are on different releases — the difference used to be invisible, which is
 * exactly why a stale web service could serve the wrong bot consoles for days.
 */

export interface ReleaseInfo {
  service: "api" | "web";
  sha: string;
  shortSha: string;
  builtAt: string | null;
  environment: string;
}

export interface WebRelease extends ReleaseInfo {
  service: "web";
  /** Console ids this bundle implements (see lib/console-contract.ts). */
  consoles: string[];
}

declare const __WEB_RELEASE__: WebRelease | undefined;

/** Local/dev fallback — never pretends to be a real release. */
const FALLBACK: WebRelease = {
  service: "web",
  sha: "unknown",
  shortSha: "dev",
  builtAt: null,
  environment: "local",
  consoles: [],
};

export const WEB_RELEASE: WebRelease =
  typeof __WEB_RELEASE__ === "object" && __WEB_RELEASE__ ? __WEB_RELEASE__ : FALLBACK;

/** Short "web 1d7b39f · api 39300a9" pair for the skew panel and logs. */
export function releasePair(api: Partial<ReleaseInfo> | null | undefined): string {
  return `web ${WEB_RELEASE.shortSha} · api ${api?.shortSha ?? "unknown"}`;
}
