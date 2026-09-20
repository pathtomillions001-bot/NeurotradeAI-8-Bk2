/**
 * Bot-console contract — the WEB side of the handshake.
 *
 * The web bundle and the API are separate Railway services. When the web
 * service is a release behind, its console registry is missing the consoles the
 * API's catalogue asks for, and the old Bot Arena silently fell back to the
 * generic specialist console. That is the production incident this file exists
 * to prevent.
 *
 * The ids below are data (no React) so the Vite config can embed them in the
 * build's `release.json` without pulling components into the config graph, and
 * so `console-registry.ts` can be tested against them.
 *
 * RULES
 *  - Add the id here AND to the registry when a console ships.
 *  - Bump the `@N` revision when a console's UI/flow changes materially, so
 *    bundles built before the change are detected even though the bot id did
 *    not change.
 */

export const WEB_CONSOLE_IDS = [
  /** Legacy specialist suite: sides / digit lock / barrier controls. */
  "specialist@1",
  /** Dual-Lock Range Sentinel — scan once, freeze the pair. */
  "dual-lock@1",
  /** Kill-Shot Oracle — one contract, one market, one shot. */
  "killshot@1",
  /** Kill-Shot family oracles (Over/Under, Even/Odd, Matches/Differs). */
  "killshot-family@1",
  /** Match Prism — Matches only, structure-proof gated, priced ladder. */
  "prism@1",
  /** Twin-Rail Sentinel — two frozen straddles on one shared tick. */
  "twin-rail@1",
] as const;

export type WebConsoleId = (typeof WEB_CONSOLE_IDS)[number];
