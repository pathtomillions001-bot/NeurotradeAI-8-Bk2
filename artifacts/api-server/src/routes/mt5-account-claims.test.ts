import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { pool, schemaReady } from "@workspace/db";
import { browserSession, runWithSession } from "../lib/session";
import { __testing as claimTesting, accountKeyFor, resetClaims } from "../lib/multiasset/claims";
import { getDesk, resetDesk } from "../lib/multiasset/store";
import router, { parseNewsFeed } from "./bridge";
import { acquireConnector, saveBridgeLink } from "../lib/multiasset/bridge-links";

/**
 * End-to-end proof that one MT5 account can only be connected to one Desk.
 *
 * These drive the real HTTP routes, because the guarantee users care about is
 * not "the registry works" — it is "opening a second browser and pairing the
 * same login is refused, and the browser is told why".
 */
describe("MT5 bridge — one account, one Desk", () => {
  const app = express();
  const sessions = new Map<string, string>();
  let sessionId = "session-a";
  app.use(express.json());
  app.use((req, _res, next) => {
    req.clientId = typeof req.headers["x-client-id"] === "string" ? req.headers["x-client-id"] : undefined;
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

  beforeEach(async () => {
    resetClaims();
    await pool.query("DELETE FROM mt5_bridge_links");
    await pool.query("DELETE FROM mt5_account_claims");
    // Every browser starts from a genuinely empty Desk, so one test's
    // successful pairing can never mask another's refusal.
    for (const id of sessions.values()) resetDesk(id);
  });

  /** Act as `as` for the duration of one request. */
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

  /** A stable pretend browser. Its session id survives a `resetDesk`. */
  const browser = (name: string): string => {
    let id = sessions.get(name);
    if (!id) {
      id = randomUUID();
      sessions.set(name, id);
    }
    return id;
  };

  async function requestCode(session: string): Promise<string> {
    const response = await as(session, () => post("/pairing-code", {}));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { pairingCode: string };
    assert.ok(body.pairingCode, "a pairing code was issued");
    return body.pairingCode;
  }

  async function pair(session: string, code: string, login: number, server = "BROKER-DEMO") {
    return as(session, () =>
      post("/pair", {
        pairingCode: code,
        terminal: { login, server, company: "Broker Ltd", currency: "USD" },
        catalog: [],
      }),
    );
  }

  /** Pair `login` from `session` and return the bearer token. */
  async function connect(session: string, login: number, server = "BROKER-DEMO"): Promise<string> {
    const code = await requestCode(session);
    const response = await pair(session, code, login, server);
    assert.equal(response.status, 201, `pairing ${login}@${server} from ${session} should succeed`);
    const body = (await response.json()) as { bridgeToken: string };
    assert.ok(body.bridgeToken);
    return body.bridgeToken;
  }

  it("the first browser to pair an account receives a bridge token", async () => {
    const token = await connect(browser("a"), 5001);
    assert.ok(token.startsWith("nt_"));

    const status = (await (await as(browser("a"), () => get("/status"))).json()) as { linked: boolean; login: number };
    assert.equal(status.linked, true);
    assert.equal(status.login, 5001);
  });

  it("a second browser pairing the same account is rejected", async () => {
    await connect(browser("a"), 5002);

    const code = await requestCode(browser("b"));
    const refused = await pair(browser("b"), code, 5002);
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string; code: string };
    assert.equal(body.code, "account_already_connected");
    assert.match(body.error, /already connected in another browser/i);

    // The first Desk is untouched and still the owner.
    const status = (await (await as(browser("a"), () => get("/status"))).json()) as { linked: boolean; login: number };
    assert.equal(status.linked, true);
    assert.equal(status.login, 5002);
  });

  it("the refusal is shown in the second browser's setup dialog", async () => {
    await connect(browser("a"), 5003);
    const code = await requestCode(browser("b"));
    await pair(browser("b"), code, 5003);

    const status = (await (await as(browser("b"), () => get("/status"))).json()) as {
      linked: boolean;
      lastPairingError: string | null;
    };
    assert.equal(status.linked, false);
    assert.match(status.lastPairingError ?? "", /already connected in another browser/i);
  });

  it("the code survives a refusal, so a retry gets the same clear answer", async () => {
    await connect(browser("a"), 5004);
    const code = await requestCode(browser("b"));

    const first = await pair(browser("b"), code, 5004);
    assert.equal(first.status, 409);
    // Not 401 "unknown or expired" — the EA retries every few seconds with the
    // same code and must keep being told the real reason.
    const second = await pair(browser("b"), code, 5004);
    assert.equal(second.status, 409);
  });

  it("the same browser can re-pair its own account", async () => {
    await connect(browser("a"), 5005);
    const again = await connect(browser("a"), 5005);
    assert.ok(again.startsWith("nt_"));
  });

  it("different accounts in different browsers are all allowed", async () => {
    await connect(browser("a"), 5006, "BROKER-DEMO");
    await connect(browser("b"), 5007, "BROKER-DEMO");
    await connect(browser("c"), 5006, "BROKER-LIVE");

    for (const [name, login] of [["a", 5006], ["b", 5007], ["c", 5006]] as const) {
      const status = (await (await as(browser(name), () => get("/status"))).json()) as { linked: boolean };
      assert.equal(status.linked, true, `${name} should still hold ${login}`);
    }
  });

  it("unlinking releases the account for another browser", async () => {
    await connect(browser("a"), 5008);
    const codeB = await requestCode(browser("b"));
    assert.equal((await pair(browser("b"), codeB, 5008)).status, 409);

    const unpaired = await as(browser("a"), () => post("/unpair", {}));
    assert.equal(unpaired.status, 200);

    // The very same code now works, without the user generating a new one.
    assert.equal((await pair(browser("b"), codeB, 5008)).status, 201);
  });

  it("pairing a different account in one browser releases the previous one", async () => {
    await connect(browser("a"), 5009);
    await connect(browser("a"), 5010);

    const codeB = await requestCode(browser("b"));
    assert.equal((await pair(browser("b"), codeB, 5010)).status, 409, "the current account is still held");
    assert.equal((await pair(browser("b"), await requestCode(browser("b")), 5009)).status, 201, "the released account is free again");
  });

  it("the owner's heartbeat keeps syncing", async () => {
    const token = await connect(browser("a"), 5011);
    const sync = await as(browser("a"), () => post("/sync", { seq: 1, instanceId: "terminal-a" }, token));
    assert.equal(sync.status, 200);
  });

  it("explicit unlink revokes old code and token; closing MT5 does not", async () => {
    const code = await requestCode(browser("a"));
    const paired = await pair(browser("a"), code, 5012);
    const { bridgeToken } = await paired.json() as { bridgeToken: string };
    await claimTesting.ageClaim(accountKeyFor(5012, "BROKER-DEMO"), Date.now() - 30 * 86400_000);
    assert.equal((await pair(browser("b"), await requestCode(browser("b")), 5012)).status, 409);
    assert.equal((await pair(browser("a"), code, 5012)).status, 201);
    await as(browser("a"), () => post("/unpair", {}));
    assert.equal((await pair(browser("a"), code, 5012)).status, 401);
    assert.equal((await as(browser("a"), () => post("/sync", { seq: 2, instanceId: "terminal-a" }, bridgeToken))).status, 401);
    await connect(browser("b"), 5012);
  });

  it("same code retries are idempotent and preserve selection/plans", async () => {
    const session = browser("a");
    const code = await requestCode(session);
    const first = await pair(session, code, 5101);
    const { bridgeToken } = await first.json() as { bridgeToken: string };
    const desk = getDesk(session);
    desk.watchlist = ["EURUSD.m"];
    desk.autoTrade = true;
    const again = await pair(session, code, 5101);
    assert.equal(again.status, 201);
    assert.equal((await again.json() as { bridgeToken: string }).bridgeToken, bridgeToken);
    assert.deepEqual(desk.watchlist, ["EURUSD.m"]);
    assert.equal(desk.autoTrade, true);
  });

  it("code and token survive loss of all process caches; no prices are restored", async () => {
    const session = browser("a");
    const code = await requestCode(session);
    const paired = await pair(session, code, 5102);
    const { bridgeToken } = await paired.json() as { bridgeToken: string };
    resetDesk(session); resetClaims();
    assert.equal((await pair(session, code, 5102)).status, 201);
    resetDesk(session); resetClaims();
    const status = await as(session, () => get("/status"));
    assert.equal((await status.json() as { linked: boolean }).linked, true);
    assert.equal(getDesk(session).quotes.size, 0);
    const sync = await as(session, () => post("/sync", { seq: 1, instanceId: "terminal-a" }, bridgeToken));
    assert.equal(sync.status, 200);
  });

  it("a second connector cannot drain commands or update heartbeat", async () => {
    const session = browser("a");
    const token = await connect(session, 5103);
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "terminal-a" }, token))).status, 200);
    const lastSync = getDesk(session).terminal!.lastSyncAt;
    const competing = await as(session, () => post("/sync", { seq: 2, instanceId: "terminal-b" }, token));
    assert.equal(competing.status, 423);
    assert.equal(getDesk(session).terminal!.lastSyncAt, lastSync);
  });

  it("a code cannot be reused on a different broker account", async () => {
    const session = browser("a");
    const code = await requestCode(session);
    assert.equal((await pair(session, code, 5104)).status, 201);
    assert.equal((await pair(session, code, 5105)).status, 409);
    assert.equal(getDesk(session).terminal!.login, 5104);
  });

  it("saving settings after a browser-first restore does not revoke the EA token", async () => {
    const session = browser("a");
    const token = await connect(session, 5110);
    resetDesk(session);
    await as(session, () => get("/status"));
    assert.equal(getDesk(session).terminal!.bridgeToken, "");
    getDesk(session).watchlist = ["GBPUSD.m"];
    await saveBridgeLink(getDesk(session));
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "terminal-a" }, token))).status, 200);
  });

  it("connector handover is allowed only after the old executor silence bound", async () => {
    const session = browser("a");
    await connect(session, 5111);
    const now = Date.now();
    assert.equal((await acquireConnector(session, "a", now)).ok, true);
    assert.equal((await acquireConnector(session, "b", now + 120_000)).ok, false);
    const handover = await acquireConnector(session, "b", now + 150_001);
    assert.deepEqual(handover, { ok: true, changed: true });
  });

  it("replacement code revokes the old code, without disrupting the active token", async () => {
    const session = browser("a");
    const code = await requestCode(session);
    const response = await pair(session, code, 5112);
    const { bridgeToken } = await response.json() as { bridgeToken: string };
    const replacement = await requestCode(session);
    assert.equal((await pair(session, code, 5112)).status, 401);
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "a" }, bridgeToken))).status, 200);
    assert.equal((await pair(session, replacement, 5112)).status, 201);
    assert.equal((await as(session, () => post("/sync", { seq: 2, instanceId: "a" }, bridgeToken))).status, 401);
  });

  it("restart sequence clears undelivered commands instead of replaying old buys", async () => {
    const session = browser("a");
    const token = await connect(session, 5113);
    await as(session, () => post("/sync", { seq: 8, instanceId: "a" }, token));
    getDesk(session).outbox.push({ id: randomUUID(), type: "flatten_all", reason: "old command" });
    const response = await as(session, () => post("/sync", { seq: 1, instanceId: "a" }, token));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { commands: unknown[] }).commands, []);
  });

  it("empty MT5 calendar success is not an all-clear, and earlier releases are retained", () => {
    assert.equal(parseNewsFeed({ available: true, rawCount: 0, events: [] })!.available, false);
    const earlier = { id: "usd", time: Date.now() - 5 * 3600_000, name: "USD release", currency: "USD" };
    const feed = parseNewsFeed({ available: true, rawCount: 3, redCount: 1, events: [earlier] })!;
    assert.equal(feed.available, true);
    assert.equal(feed.events[0]!.id, "usd");
  });

  it("pairing binds the durable browser identity for new tabs/restarts", async () => {
    const session = browser("a");
    const clientId = randomUUID();
    const response = await as(session, () => fetch(baseUrl + "/pairing-code", { method: "POST", headers: { "Content-Type": "application/json", "x-client-id": clientId }, body: "{}" }));
    assert.equal(response.status, 200);
    const req = { headers: { "x-tab-session": randomUUID(), "x-client-id": clientId }, query: {}, cookies: {}, get(name: string) { return this.headers[name as keyof typeof this.headers]; } };
    const res = { cookie() {}, setHeader() {} };
    let resolved = "";
    await browserSession(req as never, res as never, () => { resolved = (req as unknown as { sessionId: string }).sessionId; });
    assert.equal(resolved, session);
  });

  it("a heartbeat from an unpaired session is still a 401", async () => {
    const response = await as(browser("a"), () => post("/sync", { seq: 1, instanceId: "terminal-a" }, "nt_not-a-real-token"));
    assert.equal(response.status, 401);
  });

  it("clearing the pairing error once a connection succeeds", async () => {
    await connect(browser("a"), 5013);
    const codeB = await requestCode(browser("b"));
    await pair(browser("b"), codeB, 5013);
    await as(browser("a"), () => post("/unpair", {}));

    const statusB = await (await as(browser("b"), () => get("/status"))).json() as {
      lastPairingError: string | null;
      linked: boolean;
    };
    assert.equal(statusB.linked, false);
    assert.match(statusB.lastPairingError ?? "", /already connected/i);

    await connect(browser("b"), 5013);
    const after = (await (await as(browser("b"), () => get("/status"))).json()) as {
      lastPairingError: string | null;
    };
    assert.equal(after.lastPairingError, null);
  });

  it("desk state is per session, so a refused pairing leaves no terminal data", async () => {
    await connect(browser("a"), 5014);
    const codeB = await requestCode(browser("b"));
    await pair(browser("b"), codeB, 5014);

    resetDesk(browser("b"));
    const status = (await (await as(browser("b"), () => get("/status"))).json()) as {
      linked: boolean;
      catalogCount: number;
    };
    assert.equal(status.linked, false);
    assert.equal(status.catalogCount, 0);
  });
});
