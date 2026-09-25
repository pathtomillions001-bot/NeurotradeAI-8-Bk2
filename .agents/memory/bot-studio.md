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

## Phase 2 — scan → DBot → Run (done)

- `lib/dbots/strategy-xml.ts` compiles a scan's decision into Blockly XML
  (scanned market/contracts, stake, SL/TP, the shared-ladder recovery and the
  live-payout-based recovery stake). `lib/dbots/factory.ts` is the ONE
  scanner-facing call (`createDbot`) — new scanners reuse it.
- `routes/dbots.ts`: create/list/get/xml/live/heartbeat/stop/live-current.
- Over/Under Turbo's LOCKED/SWITCHING pair is now secondary: the primary action
  is **Create Deriv DBot** → `POST /api/dbots` → `/bot-studio?dbot=<id>`; legacy
  server deployment sits under **Advanced**.
- Console contract: `overunder-turbo@2` + `dbot@1` (the live badge's console for
  a running DBot) in `WEB_CONSOLE_IDS` / `CONSOLE_REGISTRY`; the API's
  `botConsoleIds()` pin and `GET /api/bots/live`'s `dbot` → `dbot@1` mapping
  follow.
- Vendored builder: `?load=<dbotId>` fetches `/api/dbots/:id/xml` into the
  workspace, and `dbot:running` reports Run/Stop to the host.

## Phase 3 — fills → journal + shared ledger + arbiter (done)

- `lib/dbots/registry.ts`: heartbeat liveness (45 s TTL) and the arbiter's
  `dbot` owner — the account has ONE executor, DBot or server engine.
- `lib/dbots/mirror.ts`: each heartbeat mirrors newly settled `profit_table`
  rows (symbol + contract types + since-live, deduped by `derivContractId`) into
  journal rows tagged `[deriv-dbot]` and one `recordOutcome` per fill into the
  SINGLE shared ledger. An account switch (demo ↔ real) stops the bot.
- Web: `lib/dbot-run-bridge.ts` claims the lock on Run and heartbeats it;
  leaving Bot Studio (or a stop from any page) releases it. The live badge opens
  a running DBot in Bot Studio and stops that exact bot; the Journal badges DBot
  fills as `DBOT` (`isDbot` on `/deriv-journal`).

## Still to build

4. Capability matrix saying which scan semantics survive in Blockly, and
   Kill-Shot / Dual-Lock adapters on top of `createDbot`.
