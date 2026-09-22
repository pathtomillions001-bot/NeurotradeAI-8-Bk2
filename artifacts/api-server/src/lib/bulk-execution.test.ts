/**
 * Bulk live trade execution — tests.
 *
 * Regression coverage for "bulk trades above ~3 delayed/missing": bursting N
 * proposals + N buys trips Deriv's per-call throttle, and Deriv error
 * envelopes don't reliably echo our req_id at the top level (only under
 * `echo_req`). A fake Deriv server scripts exactly that hostility — RateLimit
 * errors with NO top-level req_id on most legs' first quote — and the batch
 * must still execute every leg exactly once.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebSocketServer } from "ws";
import {
  BULK_REQ_ID_BASE,
  bulkReqId,
  commitDelayMs,
  executeBulkLiveTrades,
  isRetryableDerivError,
  parseBulkLegRef,
} from "./deriv.ts";

function legParams(n: number) {
  return Array.from({ length: n }, () => ({
    symbol: "R_100",
    contractType: "CALL",
    stake: 1,
    duration: 5,
    durationUnit: "t",
    currency: "USD",
  }));
}

/**
 * Mimics REAL Deriv `req_id` validation: the field must be an integer. The
 * original bulk bug shipped because these fakes accepted the string req_ids
 * real Deriv rejects with `Input validation failed: req_id` before any
 * contract was created — so this helper reproduces the server-side validation
 * and every fake below routes through it. A regression can never pass again.
 */
function decodeBulkReq(req: Record<string, any>) {
  if (!Number.isInteger(req.req_id)) return null;
  return parseBulkLegRef(req);
}

describe("parseBulkLegRef", () => {
  it("reads the top-level req_id on normal responses", () => {
    assert.deepEqual(
      parseBulkLegRef({
        msg_type: "proposal",
        req_id: bulkReqId("proposal", 3, 1),
        proposal: {},
      }),
      {
        phase: "proposal",
        leg: 3,
        attempt: 1,
      },
    );
    assert.deepEqual(
      parseBulkLegRef({ msg_type: "buy", req_id: bulkReqId("buy", 0, 2), buy: {} }),
      {
        phase: "buy",
        leg: 0,
        attempt: 2,
      },
    );
  });

  it("falls back to echo_req.req_id on Deriv error envelopes", () => {
    assert.deepEqual(
      parseBulkLegRef({
        msg_type: "proposal",
        echo_req: { proposal: 1, req_id: bulkReqId("proposal", 7, 1) },
        error: {
          code: "RateLimit",
          message: "You have reached the rate limit for proposal.",
        },
      }),
      { phase: "proposal", leg: 7, attempt: 1 },
    );
  });

  it("returns null for unattributed or foreign messages", () => {
    assert.equal(parseBulkLegRef({ msg_type: "proposal", proposal: {} }), null);
    assert.equal(parseBulkLegRef({ req_id: "something-else" }), null);
    // Foreign integer req_ids (journal, settlement polls, single trades) and
    // STRING req_ids (which real Deriv rejects with InputValidationFailed)
    // must never be attributed to a bulk leg.
    assert.equal(parseBulkLegRef({ req_id: 1 }), null);
    assert.equal(parseBulkLegRef({ req_id: 42 }), null);
    assert.equal(parseBulkLegRef({ req_id: "bulk-proposal-3-1" }), null);
    assert.equal(parseBulkLegRef({ req_id: BULK_REQ_ID_BASE + 4096 }), null);
    assert.equal(parseBulkLegRef(null), null);
    assert.equal(parseBulkLegRef({}), null);
  });

  it("bulkReqId emits integers Deriv accepts — round-trips through parseBulkLegRef", () => {
    for (let leg = 0; leg < 10; leg++) {
      for (const phase of ["proposal", "buy"] as const) {
        for (let attempt = 1; attempt <= 4; attempt++) {
          const id = bulkReqId(phase, leg, attempt);
          assert.ok(Number.isInteger(id), `req_id ${id} is an integer`);
          assert.deepEqual(parseBulkLegRef({ req_id: id }), { phase, leg, attempt });
          assert.deepEqual(
            parseBulkLegRef({ echo_req: { req_id: id } }),
            { phase, leg, attempt },
          );
        }
      }
    }
  });
});

describe("isRetryableDerivError", () => {
  it("retries throttles, transient failures and stale quotes", () => {
    assert.equal(
      isRetryableDerivError({
        error: { code: "RateLimit", message: "reached the rate limit" },
      }),
      true,
    );
    assert.equal(
      isRetryableDerivError({
        error: { code: "CircuitBreakerBusy", message: "busy" },
      }),
      true,
    );
    assert.equal(
      isRetryableDerivError({
        error: { code: "TemporaryUnavailable", message: "x" },
      }),
      true,
    );
    assert.equal(
      isRetryableDerivError({ error: { code: "Foo", message: "Price moved" } }),
      true,
    );
    assert.equal(
      isRetryableDerivError({
        error: { code: "Foo", message: "Service unavailable" },
      }),
      true,
    );
  });

  it("fails fast on hard rejections", () => {
    assert.equal(
      isRetryableDerivError({
        error: { code: "InsufficientBalance", message: "no funds" },
      }),
      false,
    );
    assert.equal(
      isRetryableDerivError({
        error: { code: "InputValidationFailed", message: "bad barrier" },
      }),
      false,
    );
    assert.equal(
      isRetryableDerivError({
        error: { code: "InvalidContractType", message: "nope" },
      }),
      false,
    );
  });
});

describe("executeBulkLiveTrades against a hostile fake Deriv", () => {
  it("executes all 10 legs exactly once despite throttled first quotes", async () => {
    const buysPerLeg = new Map<number, number>();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
    const address = wss.address();
    assert.ok(address && typeof address === "object", "server is listening");

    const sockets = new Set<any>();
    const closeServer = () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
        }
        wss.close(() => resolve());
      });
    wss.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("message", (raw) => {
        const req = JSON.parse(String(raw)) as Record<string, any>;
        const ref = decodeBulkReq(req);
        if (!ref) return;
        const { phase, leg, attempt } = ref;
        const reqId = req.req_id as number;

        if (phase === "proposal") {
          // Legs 0-2 quote cleanly; legs 3-9 are throttled on attempt 1 with
          // the real-world nasty shape: NO top-level req_id, echo_req only.
          if (leg >= 3 && attempt === 1) {
            socket.send(
              JSON.stringify({
                msg_type: "proposal",
                echo_req: { proposal: 1, req_id: reqId },
                error: {
                  code: "RateLimit",
                  message: "You have reached the rate limit for proposal.",
                },
              }),
            );
            return;
          }
          socket.send(
            JSON.stringify({
              msg_type: "proposal",
              req_id: reqId,
              echo_req: { proposal: 1, req_id: reqId },
              proposal: { id: `P-${leg}-${attempt}`, ask_price: 1 },
            }),
          );
          return;
        }

        buysPerLeg.set(leg, (buysPerLeg.get(leg) ?? 0) + 1);
        socket.send(
          JSON.stringify({
            msg_type: "buy",
            req_id: reqId,
            echo_req: { buy: req.buy, req_id: reqId },
            buy: {
              contract_id: 1000 + leg,
              buy_price: 1,
              start_time: 1700000000 + leg,
              longcode: `fake leg ${leg}`,
            },
          }),
        );
      });
    });

    try {
      const legs = await executeBulkLiveTrades(
        "test-token",
        "test-account",
        legParams(10),
        {
          otpUrl: `ws://127.0.0.1:${(address as any).port}`,
        },
      );
      assert.equal(legs.length, 10);
      for (let i = 0; i < 10; i++) {
        const leg = legs[i]!;
        assert.ok(
          !("error" in leg),
          `leg ${i} executed, got: ${"error" in leg ? leg.error.message : ""}`,
        );
        if (!("error" in leg)) assert.equal(leg.contract.contractId, 1000 + i);
        // Every leg rode the batch's ONE commit burst: no leg was split off.
        assert.equal(leg.receipt.burst, 0, `leg ${i} rode the first burst`);
        assert.equal(leg.receipt.splitTick, false, `leg ${i} was not split`);
        // No leg may ever buy twice (late original + retry double-fire).
        assert.equal(buysPerLeg.get(i), 1, `leg ${i} bought exactly once`);
      }
    } finally {
      await closeServer();
    }
  });

  it("fails only the hard-rejected leg and keeps the batch", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
    const address = wss.address();
    assert.ok(address && typeof address === "object", "server is listening");

    const sockets = new Set<any>();
    const closeServer = () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
        }
        wss.close(() => resolve());
      });
    wss.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("message", (raw) => {
        const req = JSON.parse(String(raw)) as Record<string, any>;
        const ref = decodeBulkReq(req);
        if (!ref) return;
        const { phase, leg } = ref;
        const reqId = req.req_id as number;

        if (phase === "proposal" && leg === 1) {
          socket.send(
            JSON.stringify({
              msg_type: "proposal",
              req_id: reqId,
              error: {
                code: "InsufficientBalance",
                message: "Insufficient balance.",
              },
            }),
          );
          return;
        }
        if (phase === "proposal") {
          socket.send(
            JSON.stringify({
              msg_type: "proposal",
              req_id: reqId,
              proposal: { id: `P-${leg}`, ask_price: 1 },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            msg_type: "buy",
            req_id: reqId,
            buy: {
              contract_id: 2000 + leg,
              buy_price: 1,
              start_time: 1,
              longcode: "",
            },
          }),
        );
      });
    });

    try {
      const legs = await executeBulkLiveTrades(
        "test-token",
        "test-account",
        legParams(3),
        {
          otpUrl: `ws://127.0.0.1:${(address as any).port}`,
        },
      );
      assert.equal(legs.length, 3);
      assert.ok(!("error" in legs[0]!), "leg 0 executes");
      assert.ok("error" in legs[1]!, "leg 1 fails fast on hard rejection");
      assert.ok(!("error" in legs[2]!), "leg 2 executes");
    } finally {
      await closeServer();
    }
  });

  it("bursts ALL proposals in the same tick — no staggered order delays", async () => {
    // Regression for "bulk trades above 3 are not executed at the same time":
    // a per-leg 150 ms stagger spread a 10-leg batch over ≥1.35 s of wall
    // clock, across tick boundaries, so legs opened (and closed) at different
    // times. All proposals must now arrive in one burst.
    const proposalTimes: number[] = [];
    const proposedLegs = new Set<number>();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.on("listening", resolve));
    const address = wss.address();
    assert.ok(address && typeof address === "object", "server is listening");

    const sockets = new Set<any>();
    const closeServer = () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
        }
        wss.close(() => resolve());
      });
    wss.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("message", (raw) => {
        const req = JSON.parse(String(raw)) as Record<string, any>;
        const ref = decodeBulkReq(req);
        if (!ref) return;
        const { phase, leg } = ref;
        const reqId = req.req_id as number;

        if (phase === "proposal") {
          proposalTimes.push(Date.now());
          proposedLegs.add(leg);
          socket.send(
            JSON.stringify({
              msg_type: "proposal",
              req_id: reqId,
              proposal: { id: `P-${leg}`, ask_price: 1 },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            msg_type: "buy",
            req_id: reqId,
            buy: { contract_id: 3000 + leg, buy_price: 1, start_time: 1, longcode: "" },
          }),
        );
      });
    });

    try {
      const legs = await executeBulkLiveTrades(
        "test-token",
        "test-account",
        legParams(10),
        {
          otpUrl: `ws://127.0.0.1:${(address as any).port}`,
        },
      );
      assert.equal(legs.length, 10);
      assert.equal(proposedLegs.size, 10, "every leg was proposed exactly once");
      const spreadMs =
        Math.max(...proposalTimes) - Math.min(...proposalTimes);
      // One burst: the whole 10-leg batch arrives within a few ms
      // (Date.now() is millisecond-resolved, so a true same-tick burst
      // measures a spread of 0–2 ms). The old 150 ms stagger measured
      // ≥ 1350 ms here.
      assert.ok(
        spreadMs < 150,
        `all proposals in one burst (spread ${spreadMs} ms < 150 ms)`,
      );
    } finally {
      await closeServer();
    }
  });
});
