# DBot integration — scan → build → run inside NeuroTrade

User flow (matches how third-party Deriv sites like OptTraders work, but the
builder is **self-hosted inside this app**, so users never leave NeuroTrade):

1. **Scan** — any scanner (Over/Under Turbo first) finds the best market/contract.
2. **Create DBot** — the console calls `POST /api/bots/dbot/<scanner>/build`,
   which compiles the scan result + user metrics into a **Blockly XML strategy**.
3. **DBot Studio** (`/dbot-studio`) embeds the **vendored Deriv bot builder**
   (`/dbot`, an iframe) and, over a same-origin `postMessage` bridge:
   waits for `nt:ready` → sends `nt:auth` (the user's connected PAT — no
   re-login) → sends `nt:load` (the XML — the bot appears as blocks in seconds).
4. **Run** — the user presses the builder's Run button. The **Deriv DBot itself
   executes the trades**; the builder's chart / transactions / log panels are
   the trades window. Run state is mirrored back (`nt:run` / `nt:stop`).

## Product decisions (locked with the owner)

| Decision | Choice |
|---|---|
| Execution | In-browser, visual (same model as Deriv's own DBot: closing the tab stops trading) |
| Turbo console | Both paths kept — server Deploy (Locked/Switching) **and** Create DBot |
| Recovery in XML | Exact shared formula: `ceil2(debt × (1+markup/100) / (payout−1))`, debt ledger, partial repay |
| Account linking | Auto-inject the session's active Deriv account (PAT) into the builder |
| Market semantics | A DBot is **locked** to the scanned market (building blocks can't migrate markets mid-run like the server engine's switching rescue) |

## Where things live

| Piece | Path |
|---|---|
| Vendored builder (MIT fork of `deriv-com/binary-bot`, archived upstream) | `vendor/binary-bot` |
| Fork patch: postMessage bridge (`nt:auth` / `nt:load` / events) | `vendor/binary-bot/src/neurotrade-bridge.js` |
| Tooling package (build fork → sync bundle to web app) | `artifacts/dbot-builder` |
| Served bundle (gitignored, rebuilt) | `artifacts/trading-platform/public/dbot` |
| XML compiler (Over/Under Turbo dialect) + tests | `artifacts/api-server/src/lib/dbot/overunder-turbo-xml.ts` |
| API routes (`POST /api/bots/dbot/overunder-turbo/build`, `GET /api/bots/dbot/session`) | `artifacts/api-server/src/routes/dbot.ts` |
| Studio page | `artifacts/trading-platform/src/pages/dbot-studio.tsx` |
| Console entry point ("Create DBot" button) | `overunder-turbo-console.tsx` |

## The generated strategy (Over/Under Turbo dialect)

- `trade` block: the scanned market, `digits / overunder / both`, 1-tick,
  account currency; `tradeOptions` `AMOUNT`/`PREDICTION` are **procedures
  re-evaluated before every purchase** (same mechanism as the stock
  `martingale.xml`), so stake and barrier follow the debt ledger.
- `before_purchase`: buys the normal side, or the recovery side while debt > 0.
- `after_purchase`: win ⇒ profit repays debt (recovery ends at debt ≤ 0);
  loss ⇒ stake-sized debt is added; then TP / SL / max-consecutive-losses are
  checked — on a boundary the bot simply never calls `trade_again` (= stop).
- Old binary-bot XML schema (`collection="false"`), **not** the newer
  `is_dbot` format — this builder rejects `is_dbot` documents by design.

## Rebuilding the vendored builder

```bash
pnpm --filter @workspace/dbot-builder build   # npm install (isolated) + webpack + sync
DBOT_FORCE_BUILD=1 pnpm --filter @workspace/dbot-builder build   # force rebuild
```

The web app's `build` already chains this. Fork sources are in git; its
`node_modules`, `www` output and the synced `public/dbot` bundle are gitignored.

## Security notes

- `GET /api/bots/dbot/session` returns the session's **own** active-account PAT
  to that account owner's browser (session-cookie scoped; never logged). This
  is the same exposure as the user pasting their token into Deriv's DBot —
  deliberate, per the product decision. Do not widen its scope.
- The embedded builder talks straight to `wss://ws.derivws.com` from the browser.
  If you ever add CSP headers, allow `connect-src` to Deriv's WS/HTTPS origins.

## Phase 2 (not built yet)

- Mirror builder trade events (`nt:run`-adjacent observer events) into the
  NeuroTrade trades journal.
- Additional scanner dialects: any scanner that can express a blueprint
  (market + contract(s) + stake/policy + TP/SL) gets a small compiler module
  next to `overunder-turbo-xml.ts` and a build route; the Studio, bridge and
  console button pattern are reused unchanged.
- Optional headless/server runner for unattended DBot sessions.
