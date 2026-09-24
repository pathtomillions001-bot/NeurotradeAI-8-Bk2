# Bot Studio — the embedded Deriv DBot builder

`BOT-STUDIO` / route `/bot-studio` / builder mounted at `/bot/`.

Bot Studio is the [Deriv DBot](https://github.com/deriv-com/bot) builder
(MIT, © deriv.com) vendored into NeuroTrade as the workspace package
`artifacts/dbot-builder`, served from **the same origin** as the trading platform
and reachable from the sidebar. Users build, load and **run** a bot there, and
the trades land on **the Deriv account they already connected in NeuroTrade** —
demo or real, exactly as selected in the platform.

## Why same origin is the whole trick

A hosted Deriv Bot authenticates itself: OAuth → an access token in the browser
→ the account list → an OTP WebSocket URL. Inside NeuroTrade that would mean
(a) asking a user who is already connected to log in **a second time**, and
(b) putting a Deriv bearer token in the browser, which this platform
deliberately never does (credentials live server-side in `accounts`).

Serving the builder from the platform's own origin removes both problems:

| Concern | How it is solved |
|---|---|
| Second login | The host app writes `active_loginid` / `account_type` / `deriv_accounts` from its own session (see `neurotrade-bridge.ts`), so the builder boots *already authorised*. |
| Token in the browser | The builder asks **`GET /api/dbot/ws-url`**; the API refreshes the stored token if it is near expiry and mints a single-use OTP URL. The token never leaves the server. |
| Demo vs real | Never a builder setting. `/api/dbot/ws-url` resolves the **active account of this session** — whichever the user picked in NeuroTrade. |
| A builder in session A trading session B's account | `?accountId=` is only honoured for accounts that belong to the requesting session. Tested in `routes/dbot.test.ts`. |
| One-time-use OTP URLs | The URL is fetched *per connection*, so every reconnect in the builder gets a fresh one — unlike a token cached in `localStorage`. |

## Surface (embedded mode)

`NEXT_PUBLIC_DBOT_EMBEDDED=true` trims the builder to what Bot Studio needs:

- the **Blockly workspace** (toolbox, load/save, quick strategies, toolbar) and
  the **run panel** — the trades window: transactions, contract cards, summary;
- **removed**: the DBot dashboard/bot list, the charts tab, tutorials, Deriv
  login/signup and logout, links back to deriv.com, LiveChat, Google Tag Manager
  and Survica analytics, and the OAuth callback handler.

The tab strip is gone, so nothing in the builder can navigate the user away from
the workspace (see the `isEmbeddedMode()` branch in `src/pages/main/main.tsx`).

## Hosting

| Environment | Wiring |
|---|---|
| Dev | `artifacts/dbot-builder` runs `rsbuild dev` on **4003** mounted under `/bot` (`server.base`), and `artifacts/trading-platform/vite.config.ts` proxies `/bot` → 4003 including the HMR socket. |
| Production | `pnpm --filter @workspace/dbot-builder run build:embedded` emits `artifacts/dbot-builder/dist` with `assetPrefix: /bot/`; `scripts/serve-production.mjs` serves that directory under `/bot` **before** the platform's SPA fallback, so builder deep links resolve inside the builder. |

The platform's `iframes-src` is same-origin, so the platform session cookie is
sent with `/api/dbot/*` requests with no postMessage handshake needed.

## Run & verify

```bash
pnpm --filter @workspace/api-server run dev          # 8080
pnpm --filter @workspace/dbot-builder run dev:embedded   # 4003, mounted at /bot
pnpm --filter @workspace/trading-platform run dev   # 5000
```

- `pnpm --filter @workspace/trading-platform run check:bot-studio` — renders the
  real App at `/bot-studio` and asserts the route, the sidebar entry, the
  same-origin mount and the not-connected explainer.
- `pnpm --filter @workspace/api-server run test` — includes `routes/dbot.test.ts`
  (not-connected state, active-account reporting, no-credential-leak, and the
  cross-session refusal).

## Gotchas

- **The vendored builder needs four upstream-missing deps** (`prop-types`,
  `lodash.debounce`, `rxjs`, `immutable`) plus `jsdom` for its own typecheck —
  without them `rsbuild build` / `tsc --noEmit` fail. Do not remove them when
  re-syncing with upstream.
- **React must stay on the workspace catalog.** The upstream tree asked for
  React 19.3 while this workspace pins 19.1; the mismatch hoisted a second React
  and a second `@types/react` into `node_modules`, which broke unrelated
  packages (`mockup-sandbox` calendar/spinner, and any react-query hook load).
  `react`, `react-dom`, `@types/react`, `@types/react-dom` are therefore
  declared as `catalog:` in `artifacts/dbot-builder/package.json`.
- **Execution is browser-side.** A DERIV DBot runs in the tab: if the tab is
  closed the bot stops. That is inherent to DBot, and it is why the server-side
  engines (autonomous, NeuroAI FAB, specialist bots, Over/Under Turbo) remain the
  unattended option.
- **One executor per account.** A DBot must acquire the arbiter owner `dbot`
  before executing, and the platform must stop its own engines for that account
  when a DBot starts — otherwise two engines size recovery from the same ledger
  (the incident `engine-arbiter.ts` exists to prevent).
