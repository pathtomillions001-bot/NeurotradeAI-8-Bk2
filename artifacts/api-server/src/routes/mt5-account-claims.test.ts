import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { schemaReady } from "@workspace/db";
import { runWithSession } from "../lib/session";
import { __testing as claimTesting, accountKeyFor, resetClaims } from "../lib/multiasset/claims";
import { resetDesk } from "../lib/multiasset/store";
import router, { pendingPairings } from "./bridge";

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
    pendingPairings.clear();
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
    assert.equal((await pair(browser("b"), codeB, 5009)).status, 201, "the released account is free again");
  });

  it("the owner's heartbeat keeps syncing", async () => {
    const token = await connect(browser("a"), 5011);
    const sync = await as(browser("a"), () => post("/sync", { seq: 1 }, token));
    assert.equal(sync.status, 200);
  });

  it("a superseded terminal is disconnected instead of silently sharing the account", async () => {
    const tokenA = await connect(browser("a"), 5012);
    assert.equal((await as(browser("a"), () => post("/sync", { seq: 1 }, tokenA))).status, 200);

    // Simulate a Desk that stopped heartbeating long enough to go idle: another
    // browser legitimately takes the account over.
    await claimTesting.ageClaim(
      accountKeyFor(5012, "BROKER-DEMO"),
      Date.now() - 60 * 60 * 1000,
    );
    await connect(browser("b"), 5012);

    // Terminal A still holds a cryptographically valid token. It must be told
    // to stop, or two Desks would stream and trade one balance.
    const late = await as(browser("a"), () => post("/sync", { seq: 2 }, tokenA));
    assert.equal(late.status, 409);
    const body = (await late.json()) as { code: string };
    assert.equal(body.code, "account_claimed_elsewhere");

    // And browser A is no longer shown as connected.
    const status = (await (await as(browser("a"), () => get("/status"))).json()) as { linked: boolean };
    assert.equal(status.linked, false);
  });

  it("a heartbeat from an unpaired session is still a 401", async () => {
    const response = await as(browser("a"), () => post("/sync", { seq: 1 }, "nt_not-a-real-token"));
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
