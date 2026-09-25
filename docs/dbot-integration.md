# DBot Integration — the embedded Deriv Bot Builder

NeuroTrade ships Deriv's official DBot (Blockly strategy builder + executor)
**inside** the app, at the **Bot Builder** menu entry (`/bot-builder`). Users
never leave NeuroTrade and never log in to Deriv twice: the embedded builder
trades with exactly the account connected in `/connect` — demo active ⇒ demo
trades, real active ⇒ real trades.

Source: vendored from `pathtomillions001-bot/neurotrade-dbot-builder` (Deriv
bot-web repackaged as an Rsbuild + React SPA) into `artifacts/dbot-builder`.

## Architecture

```
trading-platform (/bot-builder page)
   │  seeds localStorage (auth_info / deriv_accounts / active_loginid)
   │  from GET /api/dbot/bridge-token            ← same origin ⇒ shared storage
   ▼
iframe  /dbot/?embed=1   (artifacts/dbot-builder, embed build)
   │  Blockly workspace + run panel + transactions/journal ONLY
   │  (header/footer/tabs stripped by src/preview/preview-branding.tsx)
   │  postMessage: nt:ready / nt:run-state / nt:contract / nt:auth-lost
   ▼
trading-platform bridge  →  POST /api/dbot/events   (journaling)
                           POST /api/dbot/run-state (arbiter owner `dbot`)
```

### Serving
- `pnpm run build:dbot` builds the embed bundle (`NEXT_PUBLIC_APP_BUILD=true`,
  `NEXT_PUBLIC_BASE_PATH=/dbot/`) into `artifacts/dbot-builder/out/preview`.
- The API server serves that directory at `/dbot` (express static + SPA
  fallback); the Vite dev server proxies `/dbot` to it, so the iframe is
  **same-origin** with the app — which is what makes the storage-seed SSO work.

### SSO (no second login)
`GET /api/dbot/bridge-token` returns the token + loginid + demo/real type of
the account **active in this browser session**. The Bot Builder page writes
the keys DBot reads on boot (`auth_info`, `deriv_accounts` in
sessionStorage, `active_loginid`, `account_type`) *before* the iframe loads.
DBot's WS connection is then authorized via Deriv's OTP-URL flow with that
token. A parity guard re-seeds + reloads the frame if the builder ever reports
a different loginid than the one we seeded; `nt:auth-lost` (token expiry)
triggers the same re-sync (OAuth bearers are refreshed server-side).

### Create Bot (Over/Under Turbo → DBot)
`POST /api/bots/overunder-turbo/create-bot` (same body as `/start`) compiles
the scanned lock into Blockly XML (`lib/dbot-xml/generator.ts`):

- trade definition: found symbol, digits over/under, prediction = scanned
  barrier, 1-tick duration, stake from the deploy form;
- **recovery ladder**: `lib/dbot-xml/ladder.ts` precomputes the account's own
  debt-exact stakes with `calculateBotRecoveryStake` +
  `applyRecoveryStakeLimits` (the same pure helpers the specialist bots use)
  and embeds them as loss-streak → stake conditionals, with a circuit breaker
  that stops the session past `maxRecoverySteps`;
- TP/SL act on session PnL between contracts (digits 1-tick contracts are not
  sellable mid-contract), matching the turbo engine's semantics.

The Turbo console shows **Create DBot** as the primary action; **Locked** and
**Switching** (server-engine execution) remain as secondary options.

The saved strategy (`dbot_strategies` table, session-scoped) is loaded into
the builder workspace via `nt:load-xml`; the user presses **Run** there and
DBot executes — our server engines do not.

### Single-executor rule
`POST /api/dbot/run-state {running:true}` claims the engine-arbiter owner
`dbot` for the session; while held, autonomous/NeuroAI/specialist engines
refuse to start (and vice-versa). Stopping the DBot releases it.

### Journaling (full integration)
Every contract streams back (`nt:contract`, open + settled) and is posted to
`POST /api/dbot/events`, which:
- inserts/updates a row in `trades` keyed by `deriv_contract_id`
  (`agentReasoning` tagged `[DBOT]`), so Journal and Analytics show it;
- feeds the market win-rate store (`recordTradeOutcome`);
- records the outcome in the **single recovery ledger**
  (`recovery-engine.recordOutcome`), so switching back to a server engine
  continues recovery from the debt the DBot left behind.

### Recovery-ladder parity test
`artifacts/api-server/src/lib/dbot-xml/generator.test.ts` replays a loss
sequence through the recovery engine and asserts every ladder step equals
`getBotRecoveryStake`'s output — the XML can never drift from our math.

## Embed-mode rules (what the frame shows)
Only: Blockly workspace + toolbox + toolbar (save/load/reset), run panel, and
the Summary/Transactions/Journal panel. Hidden: Deriv header, footer,
dashboard/chart/tutorial tabs, login/signup, account switcher.

## Ops notes
- DBot executes **client-side** (the user's browser holds the WS). Closing the
  Bot Builder page stops the bot — same behaviour as Deriv's own DBot.
- Rebuild the bundle after touching `artifacts/dbot-builder`:
  `pnpm run build:dbot`, then hard-reload the page.
- Live Deriv execution cannot be exercised in sandboxes without outbound WS;
  validate on a deployment with Deriv reachability (demo account first).
