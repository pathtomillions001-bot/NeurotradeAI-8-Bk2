# Manual trading: one order per confirmation

Manual execution places **one contract at the entered stake**. There is no
quantity selector or repeated-order execution mode.

## Preserved behavior

- Choose the market, contract, direction, digit barrier and duration as before.
- NeuroAI Assist remains optional and keeps its existing Ready/Wait guidance.
- Paper/demo and connected-account execution use the existing single-trade path.
- Settlement, the trade journal, account isolation and bot strategies are not
  replaced by this change. Existing journal records are not deleted.

The market dialog labels its confirmation **Execute 1 Trade**. A synchronous
in-flight guard and a disabled pending button prevent rapid repeat clicks in
that dialog. All `useExecuteTrade` mutations disable automatic retries: a lost
HTTP response must not silently cause another purchase. If a request fails,
check the journal/account before deliberately submitting another order.
These client protections are not a server-side idempotency guarantee across
separate tabs, separate requests or page reloads.

## API contract

`POST /api/trades` accepts one strict `TradeInput` object and returns one `Trade`.
Quantity/count fields, order arrays and order envelopes are rejected with HTTP
400. The former multi-order endpoint has no route and returns HTTP 404.

The React API client, Zod validator and OpenAPI specification reflect the same
single-order contract. The removed executor, settlement sweep, burst transport,
client hook and multi-order schemas must not be reintroduced through stale
client generation.

The shared account connection, journal adapter, single-order quote retry
classification and timestamp normalization are still required. Transient
**proposals** may be retried; **buys** are never automatically repeated.

## Regression checks

```sh
pnpm run typecheck:libs
DATABASE_URL=pglite:memory pnpm --filter @workspace/api-server exec tsx \
  --test --test-timeout=90000 --test-force-exit \
  src/lib/single-trade-execution.test.ts src/routes/manual-trades.test.ts
pnpm --filter @workspace/trading-platform test
pnpm run build:api
pnpm run build:web
```

The API tests use an in-memory database and mocked broker transport. They do not
connect to an account or place real trades.
