import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { schemaReady, schemaTesting } from "@workspace/db";
import { runWithSession } from "../lib/session";
import {
  BRIDGE_LINK_LEASE_MS,
  __testing as linkTesting,
  resetBridgeLinks,
} from "../lib/multiasset/bridge-links";
import { claimHolder, resetClaims } from "../lib/multiasset/claims";
import { accountKeyFor } from "../lib/multiasset/claims";
import { getDesk, resetDesk } from "../lib/multiasset/store";
import router, { EXPECTED_EA_VERSION, pendingPairings, sweepExpiredLinks } from "./bridge";

/**
 * The MT5 link ends when the USER ends it, and at no other time.
 *
 * THE CONTRACT THESE TESTS PIN
 *
 *   • A link ends for exactly two reasons: the user presses "Unlink terminal"
 *     in the Desk (`/unpair`, which REVOKES — the only answer an EA may act on
 *     as final), or the user closes MT5 (the EA's `OnDeinit` posts
 *     `/api/bridge/disconnect` for `REASON_CLOSE` alone).
 *   • Silence ends nothing. `BRIDGE_LINK_LEASE_MS` is a DISPLAY window: past it
 *     the Desk shows the terminal as STALE, and the analysis path pauses, but
 *     the token, the pairing code and the account claim all stay valid —
 *     `sweepExpiredLinks()` returns 0.
 *   • Because the claim survives, an account stays reserved to this Desk
 *     through a sleeping laptop, a redeploy and a broker outage. Nobody can
 *     take an account by waiting for it.
 *
 * This file used to assert the OPPOSITE: that a link lived exactly as long as
 * one terminal session, that the heartbeat lease ended it, and that a silent
 * terminal released its claim. That contract disconnected users mid-trade, and
 * it is gone.
 */
describe("MT5 bridge — the link ends when the user ends it", () => {
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
    // One browser per test. The session id is the identity that owns a code, a
    // link and an account claim, so carrying it between tests would mean a test
    // inheriting the previous one's terminal — which is exactly the state the
    // new contract makes meaningful.
    sessions.clear();
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
    return (await response.json()) as {
      pairingCode: string;
      expiresInMs: number | null;
      reused?: boolean;
      redeemed?: boolean;
    };
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
        terminal: { login, server, company: "Broker Ltd", currency: "USD", version: EXPECTED_EA_VERSION },
        catalog: [],
        ...extra,
      }),
    );
  }

  /** Pair and return the bearer token, as the EA would hold it on disk. */
  async function connect(session: string, login: number, server = "BROKER-DEMO"): Promise<string> {
    const { pairingCode } = await requestCode(session);
    const response = await pair(session, pairingCode, login, server);
    assert.equal(response.status, 201, `pairing ${login}@${server} should succeed`);
    return ((await response.json()) as { bridgeToken: string }).bridgeToken;
  }

  /**
   * The terminal stopped beating without saying goodbye: a power cut, a killed
   * process, a VPS reboot, a laptop lid, a broker-side weekend.
   *
   * Its link rows and the Desk's own last-heartbeat stamp are pushed past the
   * display window, then the sweeper runs exactly as the interval does in
   * production. NOTHING here may end the link — every caller asserts the return
   * value is 0, because this is the state the Desk has to survive.
   */
  async function terminalWentSilent(session: string): Promise<number> {
    const aged = Date.now() - BRIDGE_LINK_LEASE_MS - 1_000;
    for (const record of linkTesting.linkSnapshot()) record.lastSeenAt = aged;
    const desk = getDesk(session);
    if (desk.terminal) desk.terminal.lastSyncAt = aged;
    const ended = await sweepExpiredLinks();
    for (const record of linkTesting.linkSnapshot()) record.lastSeenAt = aged;
    return ended;
  }

  it("hands back the same code to a Desk that is already showing one", async () => {
    const session = browser("a");
    const first = await requestCode(session);
    const second = await requestCode(session);

    assert.equal(second.pairingCode, first.pairingCode, "reopening the dialog must not rotate the live code");
    assert.equal(second.reused, true);
    assert.equal(second.redeemed, false);
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

  it("lets the SAME account re-present a live code (a second chart, an EA reload)", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const first = await pair(session, pairingCode, 6104);
    assert.equal(first.status, 201);
    const tokenA = ((await first.json()) as { bridgeToken: string }).bridgeToken;

    const second = await pair(session, pairingCode, 6104);
    assert.equal(second.status, 201, "one terminal with two charts is still one link");
    const tokenB = ((await second.json()) as { bridgeToken: string }).bridgeToken;
    assert.notEqual(tokenA, tokenB);

    // Both keep working: neither chart may invalidate the other.
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "ea-a" }, tokenA))).status, 200);
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "ea-b" }, tokenB))).status, 200);
  });

  it("lets a live terminal re-pair with its code after the API restarts", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const token = await connect(session, 6102);

    // The API is redeployed. The terminal never went away, so its link row is
    // still fresh and its code must still work — this is the case where "no
    // saved key" must NOT mean "re-type everything", because the user's
    // terminal was never closed.
    for (const id of sessions.values()) resetDesk(id);
    linkTesting.forgetProcessMemory();
    pendingPairings.clear();
    resetClaims();

    const again = await pair(session, pairingCode, 6102);
    assert.equal(again.status, 201, "a terminal that never left may re-pair on its live code");

    // The token it already held is still valid too: it was issued by this link.
    assert.equal((await as(session, () => post("/sync", { seq: 2, instanceId: "ea-1" }, token))).status, 200);
  });

  /**
   * ── Silence is not an ending ───────────────────────────────────────────────
   *
   * The reported failure was the Desk disconnecting itself from MT5 with no
   * user action. The cause was a lease: 120 s without a beat revoked the link.
   * The user's rule is now the only rule, so this test walks through the exact
   * sequence that used to kill a live account — silence, a sweep, a status
   * read, a beat, a re-pair — and asserts that NOTHING was lost.
   */
  it("keeps the link, the token and the claim when the terminal goes silent", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const token = await connect(session, 6201);
    assert.ok(claimHolder(accountKeyFor(6201, "BROKER-DEMO")), "pairing claims the account");

    assert.equal(await terminalWentSilent(session), 0, "the sweeper ends NOTHING — silence is a display state");

    // The Desk sees the truth: still linked, visibly stale.
    const status = (await (await as(session, () => get("/status"))).json()) as {
      linked: boolean;
      stale: boolean;
      linkEndsWithTerminal: boolean;
      resumesAutomatically: boolean;
    };
    assert.equal(status.linked, true, "a quiet terminal is a stale terminal, not an unlinked one");
    assert.equal(status.stale, true, "the analysis path must still pause on stale quotes");
    assert.equal(status.linkEndsWithTerminal, false);
    assert.equal(status.resumesAutomatically, true);

    // The token the EA holds on disk still beats…
    assert.equal((await as(session, () => post("/sync", { seq: 3, instanceId: "ea-1" }, token))).status, 200);
    // …the code it holds still pairs…
    const again = await pair(session, pairingCode, 6201);
    assert.equal(again.status, 201, "the code the terminal already saved still pairs");
    // …and the account is still this Desk's, so no other Desk can take it by waiting.
    assert.ok(claimHolder(accountKeyFor(6201, "BROKER-DEMO")), "the claim survives silence");
  });

  it("does not release an account a silent terminal still holds", async () => {
    const session = browser("a");
    await connect(session, 6202);
    assert.equal(await terminalWentSilent(session), 0);

    // A second browser asks for a code and tries to take the same account.
    const other = browser("b");
    const { pairingCode } = await requestCode(other);
    const refused = await pair(other, pairingCode, 6202);
    assert.equal(refused.status, 409, "an account is not freed by silence");
    assert.equal(((await refused.json()) as { code: string }).code, "account_already_connected");
    assert.ok(claimHolder(accountKeyFor(6202, "BROKER-DEMO")));
  });

  it("refuses a live code presented for a different account", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    assert.equal((await pair(session, pairingCode, 6203)).status, 201);

    const other = await pair(session, pairingCode, 6204);
    assert.equal(other.status, 401, "a code belongs to the link it created, not to any terminal that asks");
    assert.equal(((await other.json()) as { code: string }).code, "pairing_code_spent");
  });

  it("releases the link, the code and the account claim when the user closes MT5", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const token = await connect(session, 6301);
    assert.ok(claimHolder(accountKeyFor(6301, "BROKER-DEMO")), "pairing claims the account");

    // This is the ONE ending the EA reports: `OnDeinit` for REASON_CLOSE.
    const response = await as(session, () => post("/disconnect", { reason: "terminal closing" }, token));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ended: true });

    // Everything is released: the token, the code and the global claim that
    // would otherwise lock the account until the 10-minute idle timeout.
    assert.equal((await as(session, () => post("/sync", { seq: 1 }, token))).status, 401);
    assert.equal((await pair(session, pairingCode, 6301)).status, 401);
    assert.equal(claimHolder(accountKeyFor(6301, "BROKER-DEMO")), null);

    // Coming back is a NEW code, generated for the new session — which is what
    // "the user closed MT5" means.
    const fresh = await requestCode(session);
    const reconnected = await pair(session, fresh.pairingCode, 6301);
    assert.equal(reconnected.status, 201);
  });

  it("keeps the link alive when only ONE chart of the terminal disconnects", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const first = await pair(session, pairingCode, 6302);
    assert.equal(first.status, 201);
    const tokenA = ((await first.json()) as { bridgeToken: string }).bridgeToken;
    const second = await pair(session, pairingCode, 6302);
    assert.equal(second.status, 201);
    const tokenB = ((await second.json()) as { bridgeToken: string }).bridgeToken;

    const left = await as(session, () => post("/disconnect", {}, tokenA));
    assert.equal(left.status, 200);
    const leftBody = (await left.json()) as { ended: boolean; remaining: number };
    assert.equal(leftBody.ended, false, "a second chart is still streaming — the link is not over");
    assert.equal(leftBody.remaining, 1);

    // The surviving chart is untouched, and the account is still claimed.
    assert.equal((await as(session, () => post("/sync", { seq: 2, instanceId: "ea-b" }, tokenB))).status, 200);
    assert.ok(claimHolder(accountKeyFor(6302, "BROKER-DEMO")));
    // The departed chart's token, however, is dead.
    assert.equal((await as(session, () => post("/sync", { seq: 2, instanceId: "ea-a" }, tokenA))).status, 401);

    // When the last chart goes, so does the link.
    const last = await as(session, () => post("/disconnect", {}, tokenB));
    assert.equal(((await last.json()) as { ended: boolean }).ended, true);
    assert.equal(claimHolder(accountKeyFor(6302, "BROKER-DEMO")), null);
  });

  it("does not release a link whose terminal stopped beating", async () => {
    const session = browser("a");
    const token = await connect(session, 6401);

    assert.equal(await terminalWentSilent(session), 0, "a silent day must cost the user nothing");
    assert.equal(claimHolder(accountKeyFor(6401, "BROKER-DEMO")) !== null, true, "the claim is not released");

    const status = (await (await as(session, () => get("/status"))).json()) as { linked: boolean; stale: boolean };
    assert.equal(status.linked, true);
    assert.equal(status.stale, true);

    // Beating again is all it takes to clear the stale state — no re-pair.
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "ea-1" }, token))).status, 200);
    const after = (await (await as(session, () => get("/status"))).json()) as { linked: boolean; stale: boolean };
    assert.equal(after.stale, false, "the next beat makes the terminal live again");

    // Sweeping again is still a no-op: there is nothing to end, ever.
    assert.equal(await sweepExpiredLinks(), 0);
  });

  it("does not release a link that is still beating", async () => {
    const session = browser("a");
    const token = await connect(session, 6402);

    // Age the mirror, then beat: the terminal is demonstrably alive.
    for (const record of linkTesting.linkSnapshot()) record.lastSeenAt = Date.now() - BRIDGE_LINK_LEASE_MS - 1_000;
    assert.equal((await as(session, () => post("/sync", { seq: 1, instanceId: "ea-1" }, token))).status, 200);

    assert.equal(await sweepExpiredLinks(), 0, "a terminal that just beat must never be swept");
    assert.equal((await as(session, () => post("/sync", { seq: 2, instanceId: "ea-1" }, token))).status, 200);
  });

  /**
   * ── "Could not check" is not "your credential is dead" ────────────────────
   *
   * The reported failure was `HTTP 503 … The bridge link store could not be
   * reached` arriving on every beat, so the terminal could not make progress
   * even though nothing had been revoked. Two properties matter, and both are
   * asserted here: a live link never needs the store at all (the in-process
   * mirror serves it), and a link this process does not know about is answered
   * "retry", never "invalid".
   */
  it("serves a live link without consulting the store at all", async () => {
    const session = browser("a");
    const token = await connect(session, 6501);

    linkTesting.failStore("simulated outage");
    const during = await as(session, () => post("/sync", { seq: 1, instanceId: "ea-1" }, token));
    assert.equal(during.status, 200, "a beating terminal must not depend on the database being readable");
    linkTesting.healStore();
  });

  it("answers 503 — not 401 — when the store cannot be read, and revokes nothing", async () => {
    const session = browser("a");
    const token = await connect(session, 6502);

    // A restart, so the token is only in the database; then the database stops
    // answering, as it does mid-failover or before the DDL has been applied.
    for (const id of sessions.values()) resetDesk(id);
    linkTesting.forgetProcessMemory();
    pendingPairings.clear();
    resetClaims();
    linkTesting.failStore("simulated outage");

    const during = await as(session, () => post("/sync", { seq: 1, instanceId: "ea-a" }, token));
    assert.equal(during.status, 503, "an unreadable store must be retryable, never a verdict");
    const body = (await during.json()) as { code: string; retryAfterMs: number };
    assert.equal(body.code, "bridge_store_unavailable");
    assert.ok(body.retryAfterMs > 0, "the terminal is told when to come back");

    // The link itself is untouched: no revocation was written, so the SAME token
    // reconnects as soon as the store can be read again.
    linkTesting.healStore();
    const after = await as(session, () => post("/sync", { seq: 2, instanceId: "ea-a" }, token));
    assert.equal(after.status, 200, "a store outage must not cost the terminal its link");
  });

  /**
   * ── A DEGRADED SCHEMA IS NOT AN UNREADABLE STORE ───────────────────────────
   *
   * This is the reported failure, at the route level. The bootstrap script is
   * applied statement by statement, so a statement that cannot apply (a unique
   * index over duplicate legacy rows) leaves the flag `schemaApplied()` false
   * while every table that COULD be created — including the bridge's — exists
   * and holds the terminal's link row.
   *
   * The read used to be gated on that flag, so the row was never even looked
   * for: /sync answered `503 the bridge link store could not be reached`, the
   * EA kept its token and retried forever (a 503 revokes nothing — that part of
   * the contract is right), and the terminal could neither connect nor fall
   * back to pairing. The store was fine. The gate was wrong.
   */
  it("serves a link from the store while the bootstrap flag says the schema is unfinished", async () => {
    const session = browser("a");
    const token = await connect(session, 6504);

    // A restart: this process has never seen the token, so the store must answer.
    for (const id of sessions.values()) resetDesk(id);
    linkTesting.forgetProcessMemory();
    pendingPairings.clear();
    resetClaims();

    // …and the schema is in the degraded state: the script ran to the end, but a
    // statement in it did not apply, so the process-local flag is false.
    schemaTesting.setSchemaApplied(false);
    try {
      const beat = await as(session, () => post("/sync", { seq: 1, instanceId: "ea-degraded" }, token));
      assert.equal(
        beat.status,
        200,
        "a readable row must be served even when the bootstrap flag is false — the flag is not the store",
      );
    } finally {
      schemaTesting.setSchemaApplied(true);
    }

    // And the flag is not quietly ignored when the ROW really is absent: the
    // same state answers "unknown", which is a verdict the EA can act on.
    assert.equal(
      (await as(session, () => post("/sync", { seq: 2, instanceId: "ea-degraded" }, "nt_not-a-real-token"))).status,
      401,
    );
  });

  it("does not condemn a live pairing code when the store cannot be read", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);

    for (const id of sessions.values()) resetDesk(id);
    linkTesting.forgetProcessMemory();
    pendingPairings.clear();
    linkTesting.failStore("simulated outage");

    const during = await pair(session, pairingCode, 6503);
    assert.equal(during.status, 503, "the code was never checked, so it must not be reported as expired");
    assert.equal(((await during.json()) as { code: string }).code, "bridge_store_unavailable");

    linkTesting.healStore();
    const after = await pair(session, pairingCode, 6503);
    assert.equal(after.status, 201, "the same code still pairs once the store answers");
  });

  it("says 'revoked' only for a revocation, and 'unknown' for a token it has never issued", async () => {
    const session = browser("a");
    const token = await connect(session, 6601);

    // The one final answer: the user pressed "Unlink terminal".
    assert.equal((await as(session, () => post("/unpair", {}))).status, 200);
    const revoked = await as(session, () => post("/sync", { seq: 1 }, token));
    assert.equal(revoked.status, 401);
    assert.equal(
      ((await revoked.json()) as { code: string }).code,
      "bridge_link_revoked",
      "the EA may discard its saved credentials for this answer and no other",
    );

    // A token nobody ever issued is a different statement, and must not claim
    // the user unlinked anything.
    const unknown = await as(session, () => post("/sync", { seq: 1 }, "nt_neverissued"));
    assert.equal(unknown.status, 401);
    assert.equal(((await unknown.json()) as { code: string }).code, "bridge_token_unknown");
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
    // Read from the route, not pinned here: a literal in two places is how the
    // banner came to compare against a version nobody maintained.
    assert.equal(status.expectedEaVersion, EXPECTED_EA_VERSION);
    assert.equal(status.eaUpdateAvailable, true);

    // A terminal that reports the current version is not nagged. It is a
    // different account on the same Desk, so it gets its own code — the spent
    // one belongs to the terminal above.
    const rotated = await requestCode(session, { rotate: true });
    const currentResponse = await pair(session, rotated.pairingCode, 6113);
    assert.equal(currentResponse.status, 201);
    const current = ((await currentResponse.json()) as { bridgeToken: string }).bridgeToken;
    await as(session, () => post("/sync", { seq: 1, version: EXPECTED_EA_VERSION }, current));
    const fresh = (await (await as(session, () => get("/status"))).json()) as { eaUpdateAvailable: boolean };
    assert.equal(fresh.eaUpdateAvailable, false);
  });

  it("tells the Desk — and the EA — the two reasons a link can end", async () => {
    const session = browser("a");
    const { pairingCode } = await requestCode(session);
    const pairResponse = await pair(session, pairingCode, 6701);
    const pairBody = (await pairResponse.json()) as {
      linkModel: string;
      linkEndsWithTerminal: boolean;
      durableLink: boolean;
      resumesAutomatically: boolean;
      leaseMs: number;
    };
    assert.equal(pairBody.linkModel, "unlink-or-terminal-close");
    assert.equal(pairBody.linkEndsWithTerminal, false, "the terminal is not the thing that ends this link");
    assert.equal(pairBody.durableLink, true, "the rows, the code and the claim outlive the terminal process");
    assert.equal(pairBody.resumesAutomatically, true);
    assert.equal(pairBody.leaseMs, BRIDGE_LINK_LEASE_MS);

    const linked = (await (await as(session, () => get("/status"))).json()) as {
      linked: boolean;
      durable: boolean;
      linkEndsWithTerminal: boolean;
      resumesAutomatically: boolean;
      leaseMs: number;
      store: { backend: string; reachable: boolean };
    };
    assert.equal(linked.linked, true);
    assert.equal(linked.durable, true);
    assert.equal(linked.linkEndsWithTerminal, false);
    assert.equal(linked.resumesAutomatically, true);
    assert.equal(linked.leaseMs, BRIDGE_LINK_LEASE_MS);
    assert.ok(linked.store, "the dialog still needs to know WHERE live links are tracked");
    assert.equal(linked.store.reachable, true);

    // The same truth is available before anything is linked, which is when the
    // user is reading the pairing code and about to trust it.
    const unlinked = (await (await as(browser("b"), () => get("/status"))).json()) as {
      linked: boolean;
      durable: boolean;
      linkEndsWithTerminal: boolean;
      resumesAutomatically: boolean;
      leaseMs: number;
    };
    assert.equal(unlinked.linked, false);
    assert.equal(unlinked.durable, true);
    assert.equal(unlinked.linkEndsWithTerminal, false);
    assert.equal(unlinked.resumesAutomatically, true);
    assert.equal(unlinked.leaseMs, BRIDGE_LINK_LEASE_MS);
  });
});
