/**
 * Version of the browser/API contract used by the specialist bot consoles.
 *
 * Bump this value whenever a bot catalogue flag, dedicated console lifecycle,
 * or bot endpoint changes incompatibly. Both Railway services watch this
 * package, so a bump deliberately rebuilds the web and API from the same
 * revision. The browser refuses to open a specialist console when the API
 * reports a different version instead of silently falling back to the wrong UI.
 */
export const BOT_CONSOLE_CONTRACT_VERSION =
  "bot-console/2026-09-19.match-pulse-twin-avoid-accumulator.v1" as const;

export interface DeploymentRelease {
  /** Git commit baked into the deployment, or "development" outside CI. */
  commit: string;
  /** Railway service name (or a stable local fallback). */
  service: string;
  /** Browser/API compatibility boundary for specialist bot consoles. */
  botConsoleContract: string;
}
