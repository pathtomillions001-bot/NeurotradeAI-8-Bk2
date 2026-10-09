import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { schemaReady } from "@workspace/db";
import { runWithSession } from "../lib/session";
import { __testing as linkTesting, resetBridgeLinks } from "../lib/multiasset/bridge-links";
import { resetClaims } from "../lib/multiasset/claims";
import { armPlan, getDesk, resetDesk } from "../lib/multiasset/store";
import type { ArmedPlan } from "../lib/multiasset/types";
import router, { pendingPairings } from "./bridge";

/**
 * The MT5 link survives restarts — and only the user can end it.
 *
 * The reported failures were one chain: the API restarted (deploy/crash/scaling),
 * which forgot both the pairing code and the bearer token; the EA fell back to a
 * dead code and printed `HTTP 401 … Unknown or expired pairing code` every five
 * seconds forever; with no successful sync there were no heartbeats, so the Desk
 * showed "reconnecting"; and armed plans were never delivered, so nothing
 * executed while the MT5 calendar, from the terminal's own point of view, stayed
 * invisible to the news gate.
 *
 * These tests drive the real HTTP routes and then wipe process memory to prove
 * the link is reconstructed from the database rather than from a Map.
 */
describe("MT5 bridge — durable link", () => {
  const app = express();
  const sessions = new Map<string, string>();
  let sessionId = "session-a";
  app.use(express.json());
  app.use((req, _res, next) => {
    req.sessionId = sessionId;
    runWithSession(sessionId, next);
  });
  app.use("/api/bridge", router);

  const server = createServer(app);
  let baseUrl = "";

  before(async () => {
    await schemaReady;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}/api/bridge`;
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    resetClaims();
    resetBridgeLinks();
    pendingPairings.clear();
    for (const id of sessions.values()) resetDesk(id);
  });

  function as<T>(session: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionId;
    sessionId = session;
    return fn().finally(() => {
      sessionId = previous;
    });
  }

  function post(path: string, body: unknown, token?: string) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function get(path: string) {
    return fetch(`${baseUrl}${path}`);
  }

  const browser = (name: string): string => {
    let id = sessions.get(name);
    if (!id) {
      id = randomUUID();
      sessions.set(name, id);
    }
    return id;
  };

  async function requestCode(session: string, body: Record<string, unknown> = {}) {
    const response = await as(session, () => post("/pairing-code", body));
    assert.equal(response.status, 200);
    return (await response.json()) as { pairingCode: string; expiresInMs: number; reused?: boolean };
  }

  function pair(
    session: string,
    code: string,
    login: number,
    server = "BROKER-DEMO",
    extra: Record<string, unknown> = {},
  ) {
    return as(session, () =>
      post("/pair", {
        pairingCode: code,
        terminal: { login, server, company: "Broker Ltd", currency: "USD", version: "3.03" },
        catalog: [],
        ...extra,
      }),
    );
  }

  /** Pair and return the bearer token, as the EA would hold it. */
  async function connect(session: string, login: number, server = "BROKER-DEMO"): Promise<string> {
    const { pairingCode } = await requestCode(session);
    const response = await pair(session, pairingCode, login, server);
    assert.equal(response.status, 201, `pairing ${login}@${server} should succeed`);
    return ((await response.json()) as { bridgeToken: string }).bridgeToken;
  }

  /**
   * Lose everything the process held, exactly as a redeploy does: the desks,
   * the token mappings, the pairing-code mirror. Only the database survives.
   */
  function restartServer(): void {
    for (const id of sessions.values()) resetDesk(id);
    linkTesting.forgetProcessMemory();
    pendingPairings.clear();
    resetClaims();
  }

  it("hands back the same pairing code instead of invalidating the one in the terminal", async () => {
    const session = browser("a");
    const first = await requestCode(session);
    const second = await requestCode(session);

    assert.equal(second.pairingCode, first.pairingCode, "reopening the dialog must not rotate the live code");
    assert.equal(second.reused, true);
  });

  it("rotates the code only when the user explicitly asks for a new one", async () => {
    const session = browser("a");
    const first = await requestCode(session);
    const rotated = await requestCode(session, { rotate: true });

    assert.notEqual(rotated.pairingCode, first.pairingCode);
    assert.equal(rotated.reused, false);
    // And the old code is genuinely gone, so nobody can pair with a value the
    // user believes they have retired.
    const stale = await pair(session, first.pairingCode, 6101);
    assert.equal(stale.status, 401);
  });

  it("accepts the pairing code after a server restart", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    restartServer();

    const response = await pair(session, pairingCode, 6102);
    assert.equal(response.status, 201, "a code issued before the restart must still pair");
  });

  it("reconnects the Desk from the EA's saved token after a restart, instead of answering 401", async () => {
    const session = browser("a");
    const token = await connect(session, 6103);
    assert.equal((await as(session, () => post("/sync", { seq: 1 }, token))).status, 200);

    restartServer();

    const afterRestart = await as(session, () => post("/sync", { seq: 2, instanceId: "ea-1" }, token));
    assert.equal(afterRestart.status, 200, "the saved link is rebuilt from the durable record");

    const status = (await (await as(session, () => get("/status"))).json()) as {
      linked: boolean;
      login: number;
      durable: boolean;
    };
    assert.equal(status.linked, true);
    assert.equal(status.login, 6103);
    assert.equal(status.durable, true);
  });

  it("keeps a second EA instance's token alive so the two cannot invalidate each other", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const first = await pair(session, pairingCode, 6104);
    assert.equal(first.status, 201);
    const tokenA = ((await first.json()) as { bridgeToken: string }).bridgeToken;

    // Instance B (another chart, or the same chart after an EA reload) presents
    // the same code for the same account.
    const second = await pair(session, pairingCode, 6104);
    assert.equal(second.status, 201);
    const tokenB = ((await second.json()) as { bridgeToken: string }).bridgeToken;
    assert.notEqual(tokenA, tokenB);

    // Both keep working: the point of the fix is that neither is rotated away.
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "ea-a" }, tokenA))).status, 200);
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "ea-b" }, tokenB))).status, 200);
  });

  it("does not treat two instances' sequence counters as a terminal restart", async () => {
    const session = browser("a");
    const token = await connect(session, 6105);
    const desk = getDesk(session);
    desk.watchlist = ["XAUUSD"];
    armPlan(desk, armedPlan(6106, "XAUUSD"));

    // Instance A beats to 40.
    await as(session, () => post("/sync", { seq: 40, instanceId: "ea-a" }, token));
    assert.equal(desk.plans.size, 1);

    // Instance B has its own counter and reports a lower number. Before, this
    // was read as "the terminal restarted": armed plans were cleared and the
    // setup the user had approved silently disappeared.
    const response = await as(session, () => post("/sync", { seq: 3, instanceId: "ea-b" }, token));
    assert.equal(response.status, 200);
    assert.equal(desk.plans.size, 1, "an armed plan must survive a second instance's counter");
  });

  it("re-delivers armed plans to a terminal instance that has none", async () => {
    const session = browser("a");
    const token = await connect(session, 6107);
    const desk = getDesk(session);
    desk.watchlist = ["EURUSD"];
    armPlan(desk, armedPlan(6108, "EURUSD"));
    desk.outbox = []; // pretend the original arm_plan was already delivered

    await as(session, () => post("/sync", { seq: 1, instanceId: "ea-a" }, token));
    // A restart of the EA keeps the link but loses its local plan array: the
    // new instance must be given the plan again, or the trade never happens.
    const response = await as(session, () => post("/sync", { seq: 2, instanceId: "ea-b" }, token));

    assert.equal(response.status, 200);
    const body = (await response.json()) as { commands: { type: string }[] };
    assert.equal(body.commands.filter((command) => command.type === "arm_plan").length, 1);
    assert.equal(desk.plans.size, 1, "the Desk's own record is unchanged");
  });

  it("a genuine restart of the same instance still clears stale plans", async () => {
    const session = browser("a");
    const token = await connect(session, 6109);
    const desk = getDesk(session);
    desk.watchlist = ["GBPUSD"];
    armPlan(desk, armedPlan(6110, "GBPUSD"));

    await as(session, () => post("/sync", { seq: 40, instanceId: "ea-a" }, token));
    // Same instance, lower counter: the EA really was restarted, and its local
    // plans are gone, so the Desk's record must not pretend otherwise.
    await as(session, () => post("/sync", { seq: 1, instanceId: "ea-a" }, token));
    assert.equal(desk.plans.size, 0);
  });

  it("ends the link permanently when the user unlinks", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const response = await pair(session, pairingCode, 6111);
    const token = ((await response.json()) as { bridgeToken: string }).bridgeToken;

    assert.equal((await as(session, () => post("/unpair", {}))).status, 200);

    // The token is dead in this process AND after a restart — revocation is
    // durable, so a later deploy cannot resurrect a link the user ended.
    assert.equal((await as(session, () => post("/sync", { seq: 1 }, token))).status, 401);
    restartServer();
    assert.equal((await as(session, () => post("/sync", { seq: 1 }, token))).status, 401);

    // And so is the code the terminal was holding: reconnecting is a deliberate
    // act, not something that happens behind the user's back.
    assert.equal((await pair(session, pairingCode, 6111)).status, 401);
  });

  it("reports an out-of-date EA so a stale terminal is visible instead of silent", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const response = await as(session, () =>
      post("/pair", {
        pairingCode,
        terminal: { login: 6112, server: "BROKER-DEMO", company: "Broker Ltd", version: "2.00" },
        catalog: [],
      }),
    );
    const token = ((await response.json()) as { bridgeToken: string }).bridgeToken;

    const status = (await (await as(session, () => get("/status"))).json()) as {
      eaVersion: string | null;
      expectedEaVersion: string;
      eaUpdateAvailable: boolean;
    };
    assert.equal(status.eaVersion, "2.00");
    assert.equal(status.expectedEaVersion, "3.04");
    assert.equal(status.eaUpdateAvailable, true);

    // A terminal that reports the current version is not nagged.
    const current = await connect(session, 6113);
    await as(session, () => post("/sync", { seq: 1, version: "3.04" }, current));
    const fresh = (await (await as(session, () => get("/status"))).json()) as { eaUpdateAvailable: boolean };
    assert.equal(fresh.eaUpdateAvailable, false);
  });
});

/** A minimal but structurally complete plan, as the desk would arm it. */
function armedPlan(ticketLike: number, symbol: string): ArmedPlan {
  const now = Date.now();
  return {
    id: `plan-${ticketLike}-${symbol}`,
    symbol,
    side: "buy",
    mode: "intraday",
    trigger: 100,
    triggerType: "break",
    confirmTicks: 2,
    invalidate: 98,
    sl: 97,
    tp: [110],
    lots: 0.1,
    riskMoney: 100,
    riskPoints: 300,
    maxSpreadPoints: 30,
    maxSlippagePoints: 10,
    expiresAt: now + 60 * 60_000,
    createdAt: now,
    management: {
      breakeven: { triggerR: 1, offsetR: 0, structureBuffer: false },
      partials: [],
      trail: null,
    },
    rationale: {
      confluenceScore: 80,
      grade: "A",
      regime: "trending_up",
      winProbability: 0.6,
      expectancyR: 0.4,
      rewardRisk: 2,
      markovPersistence: 0.6,
      factors: [],
      warnings: [],
    },
  };
}
