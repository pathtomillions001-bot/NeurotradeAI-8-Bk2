/** The REAL pooled request path, against a local fake Deriv broker; never a real account. */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { NexusOrder, NexusRuntime } from "./match-nexus-runner";

let http: Server, wss: WebSocketServer;
let engine: typeof import("./match-nexus-engine");
let deriv: typeof import("./deriv");
let runtime: NexusRuntime;
const requests: Array<Record<string, any>> = [];
const sockets = new Set<WebSocket>();
let rejectBuy = false,
  dropBuy = false,
  lateBuyDelay = 0,
  sendForeignReceipt = false;
const accountId = "NEXUS-FAKE-ACCOUNT";
const config = {
  activity: "balanced" as const,
  stake: 1,
  stopLoss: 10,
  takeProfit: 10,
  maxRecoverySteps: 3,
  executionMode: "live" as const,
};
const order = {
  symbol: "R_100",
  displayName: "V100",
  contractType: "DIGITMATCH",
  barrier: 7,
  duration: 1,
  durationUnit: "t",
  stake: 1,
  tick: {
    symbol: "R_100",
    sequence: 1,
    generation: 1,
    source: "live",
    epoch: Date.now() / 1000,
    receivedAt: Date.now(),
    price: 100.07,
    digit: 7,
  },
  decision: {
    digit: 7,
    p: 0.2,
    sigma: 0.01,
    conservativeP: 0.198,
    payout: 8.93,
    breakEven: 1 / 8.93,
    expectedValue: 0.786,
    utility: 0.768,
    threshold: 0.005,
    ready: true,
    reason: "test",
  },
} as NexusOrder;

before(async () => {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const wsPort = (wss.address() as { port: number }).port;
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const req = JSON.parse(String(raw));
      requests.push(req);
      if (req.proposal)
        socket.send(
          JSON.stringify({
            msg_type: "proposal",
            req_id: req.req_id,
            proposal: {
              id: `Q-${req.req_id}`,
              ask_price: req.amount,
              payout: req.amount * 8.5,
            },
          }),
        );
      else if (req.buy) {
        if (dropBuy) {
          socket.close();
          return;
        }
        if (sendForeignReceipt)
          socket.send(
            JSON.stringify({
              msg_type: "buy",
              req_id: -999,
              echo_req: { passthrough: { nexus_intent: "unrelated-intent" } },
              buy: { contract_id: 9999, buy_price: req.price },
            }),
          );
        const response = {
          msg_type: "buy",
          req_id: req.req_id,
          echo_req: req,
          ...(rejectBuy
            ? {
                error: {
                  code: "InsufficientBalance",
                  message: "Fake insufficient balance",
                },
              }
            : {
                buy: {
                  contract_id: 87654321,
                  buy_price: req.price,
                  start_time: Math.floor(Date.now() / 1000),
                },
              }),
        };
        const reply = () => socket.send(JSON.stringify(response));
        if (lateBuyDelay) setTimeout(reply, lateBuyDelay);
        else reply();
      } else if (req.req_id)
        socket.send(JSON.stringify({ msg_type: "ping", req_id: req.req_id }));
    });
  });
  http = createServer((req, res) => {
    if (
      req.method === "POST" &&
      req.url?.endsWith(`/accounts/${accountId}/otp`)
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { url: `ws://127.0.0.1:${wsPort}` } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  process.env.DERIV_REST_BASE = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  process.env.DERIV_APP_ID = "local-fake-nexus-test";
  // Dynamically imported AFTER fake broker config, so no external broker is contacted.
  engine = await import("./match-nexus-engine");
  deriv = await import("./deriv");
  await (
    await import("@workspace/db")
  ).schemaReady;
});
beforeEach(() => {
  deriv.closeAccountConnections();
  requests.length = 0;
  rejectBuy = false;
  dropBuy = false;
  lateBuyDelay = 0;
  sendForeignReceipt = false;
  runtime = engine.createNexusRuntime(
    "transport-test",
    config,
    { ...config, maxStake: 100, markupPercent: 10 },
    {
      id: 100,
      loginId: accountId,
      derivAccountId: accountId,
      token: "fake-test-token",
      bearerToken: "fake-test-token",
      currency: "USD",
      balance: "100",
      isActive: true,
    } as any,
  );
});
afterEach(() => runtime.release());
after(async () => {
  deriv.closeAccountConnections();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("Nexus pooled broker transport", () => {
  it("quotes and buys a single 1-tick DIGITMATCH on the persistent account connection", async () => {
    let checks = 0,
      sends = 0;
    const quote = await runtime.quote(order, () => checks++);
    assert.equal(quote.payout, 8.5, "actual quote, not nominal fallback");
    const purchase = await runtime.buy(
      quote,
      () => checks++,
      () => sends++,
    );
    assert.equal(purchase.contractId, "87654321");
    assert.equal(purchase.buyPrice, 1);
    assert.equal(sends, 1);
    assert.ok(checks >= 3);
    const proposals = requests.filter((r) => r.proposal),
      buys = requests.filter((r) => r.buy);
    assert.equal(proposals.length, 1);
    assert.equal(buys.length, 1);
    assert.equal(proposals[0]!.contract_type, "DIGITMATCH");
    assert.equal(proposals[0]!.duration, 1);
    assert.equal(proposals[0]!.duration_unit, "t");
    assert.equal(proposals[0]!.underlying_symbol, "R_100");
    assert.equal(proposals[0]!.barrier, "7");
    assert.equal(deriv.accountConnectionCount(), 1);
  });
  it("re-checks cancellation on the queued buy's actual socket send", async () => {
    const quote = await runtime.quote(order, () => {});
    let stopped = false,
      sent = false;
    const purchase = runtime.buy(
      quote,
      () => {
        if (stopped) throw new Error("stopped at send");
      },
      () => {
        sent = true;
      },
    );
    stopped = true;
    await assert.rejects(() => purchase, /stopped at send/);
    assert.equal(sent, false);
    assert.equal(requests.filter((r) => r.buy).length, 0);
  });
  it("does not open a connection for an entry rejected before quoting", async () => {
    await assert.rejects(
      () =>
        runtime.quote(order, () => {
          throw new Error("stale tick");
        }),
      /stale/,
    );
    assert.equal(requests.length, 0);
    assert.equal(deriv.accountConnectionCount(), 0);
  });
  it("reports a definite rejection separately from an uncertain sent buy", async () => {
    rejectBuy = true;
    const quote = await runtime.quote(order, () => {});
    let sent = false;
    await assert.rejects(
      () =>
        runtime.buy(
          quote,
          () => {},
          () => {
            sent = true;
          },
        ),
      (error) =>
        error instanceof Error && error.constructor.name === "NexusRejected",
    );
    assert.equal(sent, true);
    assert.equal(requests.filter((r) => r.buy).length, 1);
  });
  it("recovers a late acknowledgement by its echoed durable intent, never by stake/time guessing", async () => {
    lateBuyDelay = 6200;
    sendForeignReceipt = true;
    const quote = await runtime.quote(order, () => {});
    const intent = await runtime.createIntent(order);
    let sends = 0;
    const wrongReceiptSeen = new Promise<void>((resolve) =>
      deriv
        .getAccountConnection("fake-test-token", accountId)
        .once("message", () => resolve()),
    );
    const pending = runtime.buy(
      quote,
      () => {},
      () => sends++,
    );
    await wrongReceiptSeen;
    assert.equal(
      await runtime.findPurchase(intent),
      null,
      "a different intent must not resolve this purchase",
    );
    await assert.rejects(() => pending, /acknowledgement/);
    let purchase = null;
    for (let i = 0; i < 50 && !purchase; i++) {
      purchase = await runtime.findPurchase(intent);
      if (!purchase) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(purchase?.contractId, "87654321");
    assert.equal(sends, 1);
    assert.equal(requests.filter((r) => r.buy).length, 1);
    const tag = String(requests.find((r) => r.buy)!.passthrough.nexus_intent);
    assert.match(tag, /^nexus:[0-9a-f-]+$/);
    assert.equal(
      tag.includes("transport-test"),
      false,
      "no app session identifier is sent to the broker",
    );
    const { db, tradesTable } = await import("@workspace/db");
    const [stored] = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.id, intent));
    assert.ok(
      stored!.agentReasoning!.includes(`intent=${tag}`),
      "the exact correlation tag was persisted before buy",
    );
    runtime.release();
  });
  it("preserves a delayed definitive rejection after the pooled request timed out", async () => {
    rejectBuy = true;
    lateBuyDelay = 6200;
    const quote = await runtime.quote(order, () => {});
    const intent = await runtime.createIntent(order);
    await assert.rejects(
      () =>
        runtime.buy(
          quote,
          () => {},
          () => {},
        ),
      /acknowledgement/,
    );
    let rejected = false;
    for (let i = 0; i < 50 && !rejected; i++) {
      try {
        await runtime.findPurchase(intent);
      } catch (error) {
        rejected =
          error instanceof Error && error.constructor.name === "NexusRejected";
      }
      if (!rejected) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(rejected, true);
    assert.equal(requests.filter((r) => r.buy).length, 1);
    await runtime.cancelIntent(intent, "confirmed rejected");
    assert.equal(await runtime.findPurchase(intent), null);
  });
  it("a disconnect after send is ambiguous and never auto-requotes or re-buys", async () => {
    dropBuy = true;
    const quote = await runtime.quote(order, () => {});
    let sends = 0;
    await assert.rejects(
      () =>
        runtime.buy(
          quote,
          () => {},
          () => sends++,
        ),
      /acknowledgement/,
    );
    assert.equal(sends, 1);
    assert.equal(requests.filter((r) => r.buy).length, 1);
    assert.equal(requests.filter((r) => r.proposal).length, 1);
  });
});
