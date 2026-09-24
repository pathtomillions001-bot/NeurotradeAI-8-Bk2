# Bot Studio (embedded Deriv DBot builder)

Route `/bot-studio`, builder mounted at `/bot/`, package
`artifacts/dbot-builder` (vendored from
`github.com/pathtomillions001-bot/neurotrade-dbot-builder`, which is a fork of
`deriv-com/bot`, MIT © deriv.com).

## The rule this feature exists to enforce

**The user connects their Deriv account ONCE, in NeuroTrade, and the DBot builder
opens already signed in on that same account.** Demo/real is whatever the
platform has active for the session — never a builder setting, never a second
login, and never a Deriv bearer token in the browser.

Mechanism: the builder is served from the platform's OWN origin under `/bot`, so
it shares the session cookie and localStorage. It does not run OAuth; instead

- `GET /api/dbot/session` → `{ connected, accountId, accountType, isVirtual, accounts }`
  (no credentials), which `src/services/neurotrade-bridge.ts` seals into
  `active_loginid` / `account_type` / `deriv_accounts`;
- `GET /api/dbot/ws-url` → a fresh single-use OTP WebSocket URL for the session's
  active account, minted with the stored (and refreshed-if-needed) token.

`getSocketURL()` in `src/components/shared/utils/config/config.ts` calls the
bridge when `NEXT_PUBLIC_DBOT_EMBEDDED=true` and falls back to the public server
when nothing is connected, so the workspace still loads for building.

## Things that were non-obvious

- **Same origin beats postMessage.** No handshake, no shared secret, and the
  builder reconnects with a fresh OTP every time (which is what one-time-use OTP
  URLs require).
- **A second React silently breaks the whole workspace.** Upstream asked for
  React ^19.2/`@types/react` ^19.2 against this workspace's 19.1 pin; pnpm hoisted
  both, react-query hooks loaded hooks from one copy and the renderer from the
  other (`Invalid hook call`), and `mockup-sandbox` stopped typechecking. All four
  react-ish deps are now `catalog:` in the builder's package.json.
- **Four upstream deps are missing from the builder's package.json**
  (`prop-types`, `lodash.debounce`, `rxjs`, `immutable`) and it needs `jsdom` for
  its own `tsc --noEmit`. Without them the build fails.
- **Dev needs `server.base`.** rsbuild's `assetPrefix` alone does not prefix dev
  HTML asset URLs, so the builder's dev server is mounted under `/bot` and the
  platform proxies `/bot` unchanged (no rewrite) including the HMR socket.
- **Production serving order matters**: `/bot` is handled in
  `scripts/serve-production.mjs` BEFORE the platform SPA fallback, otherwise
  builder deep links would render the platform's index.html.

## Scope decisions taken with the user (2026-09-24)

- Execution: **both** — DBot is primary for "create a bot from a scan"; the
  server-side engines stay as the unattended option.
- Over/Under Turbo: LOCKED / SWITCHING move behind **Advanced**; the primary
  action becomes **Create Deriv DBot**.
- Recovery: **full parity** — the same debt × (1 + markup) / (payout − 1) ladder
  baked into the bot, and every fill mirrored into the app's single recovery
  ledger + journal (`source: deriv-dbot:<botId>`), reconciled server-side.
- Surface: **workspace + trades window only** (no DBot dashboard/bot list/
  tutorials), branded as Bot Studio.

## Still to build (phases agreed, Bot Studio is phase 0–1)

2. Spec → Blockly XML compiler + `POST /api/dbots` + the turbo console button
   (bump `overunder-turbo@2`, add `dbot@1` to the console contract).
3. Trade mirroring + reconciler + arbiter owner `dbot` + live badge + kill switch.
4. Generic factory so every scanner can emit a DBot, and the capability matrix
   saying which semantics survive in Blockly.
