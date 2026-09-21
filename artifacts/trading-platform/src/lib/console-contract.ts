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
  /** Omni Sentinel — multi-contract, cross-market normal and recovery. */
  "omni@1",
  /** Echo Apex — institutional Matches engine. */
  "apex@1",
  /** Barrier Bastion — recovery-first Over/Under bands (Over 1 / Under 8 → Over 3 / Under 6). */
  "bastion@1",
  /** Over/Under Navigator — configurable normal/recovery digit bands. */
  "overunder-navigator@1",
  /** Parity Forge — Even/Odd parity specialist with recovery-first intelligence. */
  "parity-forge@1",
  /** Vector Surge — Rise/Fall momentum specialist with recovery-first intelligence. */
  "surge@1",
  /** Legacy specialist suite: sides / digit lock / barrier controls. */
  "specialist@1",
  /** Dual-Lock Range Sentinel — scan once, freeze the pair. */
  "dual-lock@1",
  /** Kill-Shot Oracle — one contract, one market, one shot. */
  "killshot@1",
  /** Kill-Shot family oracles (Over/Under, Even/Odd, Matches/Differs). */
  "killshot-family@1",
] as const;

export type WebConsoleId = (typeof WEB_CONSOLE_IDS)[number];
