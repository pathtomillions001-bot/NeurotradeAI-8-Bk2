import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { schemaReady } from "@workspace/db";
import { runWithSession } from "../lib/session";
import { __testing as claimTesting, accountKeyFor, resetClaims } from "../lib/multiasset/claims";
import { __testing as bridgeLinkTesting, resetBridgeLinks } from "../lib/multiasset/bridge-links";
import { resetDesk, revokeBridgeToken } from "../lib/multiasset/store";
import router, { pendingPairings } from "./bridge";

/**
 * The bridge must outlive both ends of the connection.
 *
 * The pairing code sits in the EA's inputs — which the user cannot change while
 * MT5 is running — and the bridge token lives in the EA's memory. If this
 * service forgets either one, the terminal cannot recover by itself: it retries
 * `/pair` with a code the server no longer knows and answers
 * "Unknown or expired pairing code." forever, while the Desk reports
 * "Reconnecting to the MT5 terminal", the calendar pane freezes on its last
 * read and armed plans never reach the terminal.
 *
 * These tests drive the real HTTP routes and simulate a service restart by
 * dropping every in-process map while leaving the database intact, which is
 * exactly what a redeploy does. The contract under test:
 *
 *   a code and its link are dropped ONLY when the user unlinks the terminal.
 */
describe("MT5 bridge — the link survives restarts", () => {
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

  beforeEach(async () => {
    resetClaims();
    pendingPairings.clear();
    await bridgeLinkTesting.purgeAll();
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

  async function requestCode(session: string): Promise<string> {
    const response = await as(session, () => post("/pairing-code", {}));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { pairingCode: string; expiresInMs: number | null };
    assert.ok(body.pairingCode, "a pairing code was issued");
    assert.equal(body.expiresInMs, null, "a pairing code has no expiry");
    return body.pairingCode;
  }

  async function pair(session: string, code: string, login: number, server = "BROKER-DEMO") {
    return as(session, () =>
      post("/pair", {
        pairingCode: code,
        terminal: { login, server, company: "Broker Ltd", currency: "USD" },
        catalog: [{ symbol: "EURUSD", description: "Euro vs US Dollar", assetClass: "forex" }],
      }),
    );
  }

  async function connect(session: string, login: number, server = "BROKER-DEMO"): Promise<string> {
    const code = await requestCode(session);
    const response = await pair(session, code, login, server);
    assert.equal(response.status, 201, `pairing ${login}@${server} should succeed`);
    const body = (await response.json()) as { bridgeToken: string };
    assert.ok(body.bridgeToken);
    return body.bridgeToken;
  }

  /**
   * Simulate a redeploy of this service: every in-process map is emptied, the
   * database is untouched. The terminal on the other end knows nothing about it
   * and simply keeps beating.
   */
  function simulateServiceRestart(session: string, token: string): void {
    resetClaims();
    pendingPairings.clear();
    resetBridgeLinks();
    revokeBridgeToken(token);
    resetDesk(session);
  }

  it("a heartbeat restores the link after the service restarts, with no re-pairing", async () => {
    const session = browser("a");
    const token = await connect(session, 6001);

    simulateServiceRestart(session, token);

    // The Desk's own in-memory state is gone, so the dialog would previously
    // have reported "not linked" and offered a new code.
    const restored = (await (await as(session, () => get("/status"))).json()) as {
      linked: boolean;
      login: number;
      linkPersistence: string;
    };
    assert.equal(restored.linked, true, "the stored link must restore the Desk");
    assert.equal(restored.login, 6001);
    assert.equal(restored.linkPersistence, "until-unlinked");

    // The EA's next heartbeat, with the token it already holds, must be accepted.
    const sync = await as(session, () =>
      post(
        "/sync",
        {
          seq: 1,
          clock: { terminalUtcMs: Date.now(), syncIntervalMs: 1000 },
          account: { balance: 10_000, equity: 10_000, currency: "USD", leverage: 100 },
        },
        token,
      ),
    );
    assert.equal(sync.status, 200, "a token that is valid in storage must not be rejected after a restart");
  });

  it("a pairing code is not consumed by being redeemed, so an EA restart can pair again", async () => {
    const session = browser("b");
    const code = await requestCode(session);
    assert.equal((await pair(session, code, 6002)).status, 201);

    // MT5 is closed and reopened: the EA has no token, only the code in its
    // inputs, and the service has restarted in the meantime.
    simulateServiceRestart(session, "nt_whatever");

    const again = await pair(session, code, 6002);
    assert.equal(again.status, 201, "the same code must pair again — it is still in the EA's inputs");
    const body = (await again.json()) as { bridgeToken: string };
    assert.ok(body.bridgeToken.startsWith("nt_"));
  });

  it("a code issued before a restart is still recognised after it", async () => {
    const session = browser("c");
    const code = await requestCode(session);

    resetBridgeLinks();
    pendingPairings.clear();
    resetDesk(session);

    assert.equal((await pair(session, code, 6003)).status, 201);
  });

  it("unlinking is the only thing that ends the connection", async () => {
    const session = browser("d");
    const code = await requestCode(session);
    const paired = await pair(session, code, 6004);
    assert.equal(paired.status, 201);
    const { bridgeToken } = (await paired.json()) as { bridgeToken: string };

    const unpaired = await as(session, () => post("/unpair", {}));
    assert.equal(unpaired.status, 200);

    const sync = await as(session, () => post("/sync", { seq: 1 }, bridgeToken));
    assert.equal(sync.status, 401, "the revoked token must stop working");

    const reused = await pair(session, code, 6004);
    assert.equal(reused.status, 401, "the revoked code must not re-attach the terminal");
    const body = (await reused.json()) as { code: string; error: string };
    assert.equal(body.code, "pairing_code_revoked");
    assert.match(body.error, /unlinked/i);
  });

  it("an unrecognised code is reported as unknown, not expired", async () => {
    const session = browser("e");
    const response = await pair(session, "ZZZZ-ZZZZ", 6005);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { code: string; error: string };
    assert.equal(body.code, "pairing_code_unknown");
    assert.match(body.error, /Link MT5/i, "the message must tell the user where to get a code");
  });

  it("a second browser still cannot take an account that is linked elsewhere", async () => {
    const holder = browser("f");
    await connect(holder, 6006);

    const intruder = browser("g");
    const code = await requestCode(intruder);
    const refused = await pair(intruder, code, 6006);
    assert.equal(refused.status, 409);

    // The refusal must not burn the intruder's code either: it connects by
    // itself the moment the other Desk lets go.
    await as(holder, () => post("/unpair", {}));
    assert.equal((await pair(intruder, code, 6006)).status, 201);
  });

  it("a superseded token cannot take the Desk back from the newer pairing", async () => {
    const session = browser("j");
    const code = await requestCode(session);

    const first = await pair(session, code, 6008);
    assert.equal(first.status, 201);
    const firstToken = ((await first.json()) as { bridgeToken: string }).bridgeToken;

    // The same EA pairs again — an MT5 restart that lost its stored token, or
    // the EA attached to a second chart. One Desk, one live credential.
    const second = await pair(session, code, 6008);
    assert.equal(second.status, 201);
    const secondToken = ((await second.json()) as { bridgeToken: string }).bridgeToken;
    assert.notEqual(firstToken, secondToken);

    assert.equal((await as(session, () => post("/sync", { seq: 1 }, secondToken))).status, 200);
    assert.equal(
      (await as(session, () => post("/sync", { seq: 1 }, firstToken))).status,
      401,
      "the older credential must not hijack the live link",
    );

    // Same check after a restart, so it is the stored row answering, not the
    // in-process token index.
    simulateServiceRestart(session, secondToken);
    assert.equal(
      (await as(session, () => post("/sync", { seq: 1 }, firstToken))).status,
      401,
      "a superseded token must stay dead across a restart",
    );
    assert.equal((await as(session, () => post("/sync", { seq: 2 }, secondToken))).status, 200);

    const status = (await (await as(session, () => get("/status"))).json()) as { linked: boolean; login: number };
    assert.equal(status.linked, true, "the newer terminal keeps its Desk");
    assert.equal(status.login, 6008);
  });

  it("a superseded terminal is not restored from storage on its next heartbeat", async () => {
    const first = browser("h");
    const firstToken = await connect(first, 6007);

    // The first terminal goes quiet long enough for its claim to be considered
    // abandoned, so a second Desk is allowed to take the account over.
    await claimTesting.ageClaim(accountKeyFor(6007, "BROKER-DEMO"), Date.now() - 11 * 60_000);
    const second = browser("i");
    await connect(second, 6007);

    // This service restarts, so the superseded terminal's next beat has to be
    // resolved against storage — and storage must not resurrect it.
    simulateServiceRestart(first, firstToken);

    const sync = await as(first, () => post("/sync", { seq: 1 }, firstToken));
    assert.equal(sync.status, 401, "the old terminal must not resume an account another Desk now owns");
    assert.equal(
      claimTesting.snapshot().filter((claim) => claim.sessionId === first).length,
      0,
      "the superseded Desk must not end up holding a claim",
    );

    const status = (await (await as(first, () => get("/status"))).json()) as { linked: boolean };
    assert.equal(status.linked, false, "the stored link must be dropped, not restored on the next poll");
  });
});
