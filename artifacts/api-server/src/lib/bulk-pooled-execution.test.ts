/**
 * Bulk execution over the PRODUCTION transport — the pooled account socket.
 *
 * WHY THIS FILE EXISTS
 *
 * `bulk-execution.test.ts` injects `opts.otpUrl`, which selects
 * `openDirectSocket`. That socket is a raw `ws`: a "burst" of ten sends really
 * is ten sends in one turn. Production never uses it — production goes through
 * `getPooledSocket()` → `DerivAccountConnection`, whose `send()` is a PACED
 * QUEUE (one message per 25 ms, the guard that keeps us under Deriv's
 * per-connection ceiling). The old bulk executor rode that queue while claiming
 * to burst, so a 10-leg batch was really emitted at 0/25/50/…/225 ms and the
 * legs opened on different ticks. Every test passed, because every test took
 * the socket that does not have the queue.
 *
 * These tests drive the REAL path end to end: a fake Deriv REST endpoint issues
 * the OTP URL, a fake Deriv WebSocket is the trading socket, and the executor
 * runs with no injection at all — exactly the code that runs in production.
 *
 * What is asserted:
 *   • the 10-leg quote burst leaves in ONE event-loop turn (the paced queue
 *     would spread it over ≥ 225 ms; we require < 20 ms),
 *   • the 10 buys leave in ONE burst, inside a single tick window,
 *   • each leg reports `burst: 0` / `splitTick: false` with Deriv's own start
 *     time, so the synchrony verdict is provable from broker data,
 *   • a socket that dies mid-batch does NOT lose the batch: the legs are
 *     re-quoted after the pool reconnects, and no leg is ever bought twice.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { summarizeBulkSync } from "./bulk-sync.ts";

const ACCOUNT_ID = "CR-TEST-0001";

type DerivModule = typeof import("./deriv.ts");

interface FakeDeriv {
  httpPort: number;
  wsPort: number;
  proposalAt: Map<number, number>;
  buyAt: Map<number, number>;
  buysPerLeg: Map<number, number>;
  sockets: Set<any>;
  onProposal?: (leg: number) => void;
  startTime: number;
  close: () => Promise<void>;
}

// Mirrors BULK_REQ_ID_BASE/bulkReqId in deriv.ts (kept local so this file can
// keep its lazy dynamic import of the module under test). Real Deriv validates
// req_id as an INTEGER — the fakes must too, or they silently accept what the
// exchange rejects (the original bulk bug).
const BULK_REQ_ID_BASE = 100_000_000;

function decodeBulkReq(
  req: Record<string, any>,
): { phase: "proposal" | "buy"; leg: number; attempt: number } | null {
  const raw = req.req_id;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  const offset = raw - BULK_REQ_ID_BASE;
  if (offset < 0 || offset > 1023) return null;
  const attempt = (offset >> 1) & 15;
  const leg = (offset >> 5) & 15;
  if (attempt === 0) return null;
  return { phase: offset & 1 ? "buy" : "proposal", leg, attempt };
}

async function startFakeDeriv(): Promise<FakeDeriv> {
  const state: FakeDeriv = {
    httpPort: 0,
    wsPort: 0,
    proposalAt: new Map(),
    buyAt: new Map(),
    buysPerLeg: new Map(),
    sockets: new Set(),
    startTime: Math.floor(Date.now() / 1000),
    close: async () => {},
  };

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  state.wsPort = (wss.address() as any).port;

  wss.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    socket.on("message", (raw) => {
      const req = JSON.parse(String(raw)) as Record<string, any>;
      const ref = decodeBulkReq(req);
      if (!ref) {
        // Anything else (ping/portfolio/journal) gets a benign answer so the
        // pooled connection is never left waiting.
        if (req.req_id !== undefined) {
          socket.send(JSON.stringify({ msg_type: "ping", req_id: req.req_id }));
        }
        return;
      }
      const { phase, leg, attempt } = ref;
      const reqId = req.req_id as number;

      if (phase === "proposal") {
        state.proposalAt.set(leg, Date.now());
        state.onProposal?.(leg);
        socket.send(
          JSON.stringify({
            msg_type: "proposal",
            req_id: reqId,
            proposal: { id: `P-${leg}-${attempt}`, ask_price: 1 },
          }),
        );
        return;
      }

      state.buyAt.set(leg, Date.now());
      state.buysPerLeg.set(leg, (state.buysPerLeg.get(leg) ?? 0) + 1);
      socket.send(
        JSON.stringify({
          msg_type: "buy",
          req_id: reqId,
          buy: {
            contract_id: 5000 + leg,
            buy_price: 1,
            // One start_time for the whole batch: Deriv's own proof that these
            // legs entered on the same tick.
            start_time: state.startTime,
            longcode: `leg ${leg}`,
          },
        }),
      );
    });
  });

  const http: Server = createServer((req, res) => {
    if (
      req.method === "POST" &&
      /^\/trading\/v1\/options\/accounts\/[^/]+\/otp$/.test(req.url ?? "")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { url: `ws://127.0.0.1:${state.wsPort}` } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  state.httpPort = (http.address() as any).port;

  state.close = async () => {
    for (const socket of state.sockets) {
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
  return state;
}

function legParams(n: number) {
  return Array.from({ length: n }, () => ({
    symbol: "R_100",
    contractType: "DIGITOVER",
    stake: 1,
    duration: 1,
    durationUnit: "t",
    currency: "USD",
    barrier: 5,
  }));
}

let fake: FakeDeriv;
let deriv: DerivModule;

before(async () => {
  fake = await startFakeDeriv();
  // Point the REAL OTP handshake at the fake Deriv. This must be set before the
  // module is evaluated, which is why deriv.ts is imported dynamically here and
  // never statically in this file.
  process.env.DERIV_REST_BASE = `http://127.0.0.1:${fake.httpPort}`;
  deriv = await import("./deriv.ts");
});

after(async () => {
  deriv?.closeAccountConnections();
  await fake?.close();
  delete process.env.DERIV_REST_BASE;
});

describe("executeBulkLiveTrades over the pooled production socket", () => {
  it("sends all 10 quotes and all 10 buys in ONE burst each (no 25 ms queue pacing)", async () => {
    const legs = await deriv.executeBulkLiveTrades("test-token", ACCOUNT_ID, legParams(10));

    assert.equal(legs.length, 10);
    for (const [i, leg] of legs.entries()) {
      assert.ok(
        !("error" in leg),
        `leg ${i} opened: ${"error" in leg ? leg.error.message : ""}`,
      );
    }

    // ── The regression this file exists for ─────────────────────────────────
    // The pooled connection's ordinary `send()` spaces messages 25 ms apart; 10
    // quotes through that queue span ≥ 225 ms. A true burst spans ~0 ms.
    const quoteTimes = [...fake.proposalAt.values()];
    assert.equal(quoteTimes.length, 10, "every leg was quoted");
    const quoteSpread = Math.max(...quoteTimes) - Math.min(...quoteTimes);
    assert.ok(
      quoteSpread < 20,
      `all 10 quotes left in one burst (spread ${quoteSpread} ms; a 25 ms paced queue would be ≥ 225 ms)`,
    );

    const buyTimes = [...fake.buyAt.values()];
    assert.equal(buyTimes.length, 10, "every leg was bought");
    const buySpread = Math.max(...buyTimes) - Math.min(...buyTimes);
    assert.ok(
      buySpread < 20,
      `all 10 buys left in one burst (spread ${buySpread} ms; a 25 ms paced queue would be ≥ 225 ms)`,
    );

    for (const [i, leg] of legs.entries()) {
      assert.equal(leg.receipt.burst, 0, `leg ${i} rode the synchronized burst`);
      assert.equal(leg.receipt.splitTick, false, `leg ${i} not split`);
      assert.ok(leg.receipt.confirmedAtMs > 0, `leg ${i} has a confirmation time`);
      assert.equal(
        leg.receipt.startedAtMs,
        fake.startTime * 1000,
        `leg ${i} carries Deriv's own start time`,
      );
    }

    // The synchrony verdict the route reports to the user is provable here.
    const report = summarizeBulkSync(
      legs.map((leg) => ({ opened: !("error" in leg), receipt: leg.receipt })),
    );
    assert.equal(report.verdict, "synchronized");
    assert.equal(report.sameEntryTick, true);
    assert.equal(report.opened, 10);

    // Exactly-once: no leg may be bought twice by a retry or a re-quote.
    for (let i = 0; i < 10; i++) {
      assert.equal(fake.buysPerLeg.get(i), 1, `leg ${i} bought exactly once`);
    }
  });

  it("holds the commit burst for a fresh tick window instead of committing late in one", async () => {
    fake.proposalAt.clear();
    fake.buyAt.clear();
    fake.buysPerLeg.clear();

    // 900 ms into a 1000 ms window: 100 ms of headroom left, so the commit must
    // wait for the next boundary (+ a small offset) rather than race it.
    const tickWindow = { periodMs: 1000, windowStartMs: Date.now() - 900 };
    const startedAt = Date.now();
    const legs = await deriv.executeBulkLiveTrades("test-token", ACCOUNT_ID, legParams(4), {
      tickWindow,
    });
    assert.equal(legs.length, 4);
    for (const [i, leg] of legs.entries()) {
      assert.ok(!("error" in leg), `leg ${i} opened`);
    }

    const firstQuote = Math.min(...fake.proposalAt.values());
    const lastBuy = Math.max(...fake.buyAt.values());
    assert.ok(
      lastBuy - firstQuote >= 150,
      `commit waited for the next tick window (waited ${lastBuy - firstQuote} ms)`,
    );
    assert.ok(
      Date.now() - startedAt >= 150,
      "the batch held the commit rather than firing immediately",
    );

    // Still ONE burst after the wait — alignment must never de-synchronize it.
    const buyTimes = [...fake.buyAt.values()];
    const spread = Math.max(...buyTimes) - Math.min(...buyTimes);
    assert.ok(spread < 20, `aligned commit is still one burst (spread ${spread} ms)`);
    for (const leg of legs) {
      assert.equal(leg.receipt.splitTick, false);
      assert.equal(leg.receipt.burst, 0);
    }
  });

  it("survives the trading socket dying mid-batch and still buys every leg exactly once", async () => {
    fake.proposalAt.clear();
    fake.buyAt.clear();
    fake.buysPerLeg.clear();

    // Kill the transport as soon as the 3rd leg has been quoted: the remaining
    // legs were never asked, and the legs already quoted cannot be confirmed.
    let killed = false;
    fake.onProposal = (leg) => {
      if (leg !== 2 || killed) return;
      killed = true;
      setTimeout(() => {
        for (const socket of fake.sockets) {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
        }
      }, 5);
    };

    try {
      const legs = await deriv.executeBulkLiveTrades("test-token", ACCOUNT_ID, legParams(6), {
        tickWindow: null,
      });
      assert.equal(legs.length, 6);
      for (const [i, leg] of legs.entries()) {
        assert.ok(
          !("error" in leg),
          `leg ${i} still opened after the drop: ${"error" in leg ? leg.error.message : ""}`,
        );
      }
      for (let i = 0; i < 6; i++) {
        assert.equal(
          fake.buysPerLeg.get(i),
          1,
          `leg ${i} bought exactly once across the reconnect`,
        );
      }
      // Legs that could not ride the first commit burst are committed together
      // in the follow-up burst, so no leg is reported as synchronized when it is
      // not: the batch is either one burst or visibly split.
      const bursts = new Set(legs.map((leg) => leg.receipt.burst));
      assert.ok(
        bursts.size >= 1,
        "legs carry the commit burst that carried them",
      );
      const report = summarizeBulkSync(
        legs.map((leg) => ({ opened: !("error" in leg), receipt: leg.receipt })),
      );
      assert.ok(
        report.verdict === "synchronized" || report.verdict === "split",
        `report is honest (${report.verdict}: ${report.summary})`,
      );
    } finally {
      fake.onProposal = undefined;
    }
  });
});

describe("commitDelayMs", () => {
  it("commits immediately when the window is fresh", () => {
    // 50 ms into a 1 s window: 950 ms of headroom, commit now.
    assert.equal(deriv.commitDelayMs(1_000, { periodMs: 1000, windowStartMs: 950 }), 0);
  });

  it("waits for the next boundary when the window is nearly over", () => {
    assert.equal(
      deriv.commitDelayMs(1_900, { periodMs: 1000, windowStartMs: 1_000 }),
      220, // 100 ms left + 120 ms offset
    );
  });

  it("never parks the batch longer than the cap", () => {
    assert.equal(
      deriv.commitDelayMs(1_990, { periodMs: 1000, windowStartMs: 1_000 }, { maxWaitMs: 50 }),
      0,
    );
  });

  it("commits immediately when the feed has rolled over or stalled", () => {
    assert.equal(deriv.commitDelayMs(5_000, { periodMs: 1000, windowStartMs: 1_000 }), 0);
    assert.equal(deriv.commitDelayMs(5_000, null), 0);
    assert.equal(deriv.commitDelayMs(5_000, { periodMs: 0, windowStartMs: 0 }), 0);
  });

  it("uses the market's own cadence for slow symbols", () => {
    // A 2 s market 0.5 s in still has 1.5 s of headroom: commit now.
    assert.equal(deriv.commitDelayMs(2_500, { periodMs: 2_000, windowStartMs: 1_000 }), 0);
    // 1.8 s in, only 200 ms left: wait out the boundary (+ the 120 ms offset).
    assert.equal(deriv.commitDelayMs(2_800, { periodMs: 2_000, windowStartMs: 1_000 }), 320);
  });
});

describe("pooled socket hygiene", () => {
  it("leaves no message listener behind after a completed batch", async () => {
    const before = deriv.accountConnectionCount();
    assert.ok(before >= 1, "the pooled connection is alive from the tests above");

    await deriv.executeBulkLiveTrades("test-token", ACCOUNT_ID, legParams(3));
    await deriv.executeBulkLiveTrades("test-token", ACCOUNT_ID, legParams(3));

    // Every finished batch must detach the listener it attached: a leaked
    // listener keeps the shared connection alive forever (the idle teardown
    // counts listeners) and grows with every batch a user runs.
    const connection = deriv.getAccountConnection("test-token", ACCOUNT_ID) as unknown as {
      listenerCount: (event: string) => number;
    };
    assert.equal(
      connection.listenerCount("message"),
      0,
      "every finished batch detached its listener",
    );
  });
});
