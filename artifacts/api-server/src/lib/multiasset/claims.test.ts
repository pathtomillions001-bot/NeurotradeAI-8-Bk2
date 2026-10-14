import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { schemaReady } from "@workspace/db";
import {
  CLAIM_IDLE_RELEASE_MS,
  __testing,
  accountKeyFor,
  claimHolder,
  claimsForSession,
  releaseClaim,
  releaseClaimsForSession,
  resetClaims,
  touchClaim,
  tryClaimAccount,
} from "./claims";

/**
 * One MT5 account, one Desk.
 *
 * These run against whatever storage is available. With DATABASE_URL set the
 * Postgres unique index is exercised; without it the in-process map alone must
 * still enforce the same rule. Every assertion holds in both cases, which is
 * the point — the guarantee must not depend on the database being up.
 */
describe("MT5 account claims", () => {
  before(async () => {
    await schemaReady;
  });

  beforeEach(() => {
    resetClaims();
  });

  const claim = (login: number, server: string, sessionId: string, company = "") =>
    tryClaimAccount({ login, server, company, sessionId });

  it("normalises the account identity so one server is never two accounts", () => {
    assert.equal(accountKeyFor(12345, "Broker-Demo"), accountKeyFor(12345, "broker-demo"));
    assert.equal(accountKeyFor(12345, " Broker Demo "), accountKeyFor(12345, "BROKER   DEMO"));
    assert.notEqual(accountKeyFor(12345, "Broker-Demo"), accountKeyFor(12345, "Broker-Live"));
    assert.notEqual(accountKeyFor(12345, "Broker-Demo"), accountKeyFor(54321, "Broker-Demo"));
  });

  it("the first session to pair an account owns it", async () => {
    const result = await claim(1001, "BROKER-DEMO", "session-a");
    assert.equal(result.ok, true);
    assert.equal(claimHolder(accountKeyFor(1001, "BROKER-DEMO"))?.sessionId, "session-a");
  });

  it("a second browser pairing the same account is refused", async () => {
    await claim(1002, "BROKER-DEMO", "session-a");
    const second = await claim(1002, "BROKER-DEMO", "session-b");

    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "held");
    assert.equal(second.ok === false && second.holder.sessionId, "session-a");
    // The refusal must not transfer ownership.
    assert.equal(claimHolder(accountKeyFor(1002, "BROKER-DEMO"))?.sessionId, "session-a");
  });

  it("a different login or server is a different account", async () => {
    await claim(1003, "BROKER-DEMO", "session-a");
    assert.equal((await claim(1004, "BROKER-DEMO", "session-b")).ok, true);
    assert.equal((await claim(1003, "BROKER-LIVE", "session-c")).ok, true);
  });

  it("the owning session may re-pair — an EA restart must not lock it out", async () => {
    await claim(1005, "BROKER-DEMO", "session-a");
    for (let i = 0; i < 3; i++) {
      assert.equal((await claim(1005, "BROKER-DEMO", "session-a")).ok, true);
    }
    assert.equal(claimsForSession("session-a").length, 1);
  });

  it("pairing a second account in one session releases the first", async () => {
    await claim(1006, "BROKER-DEMO", "session-a");
    await claim(1007, "BROKER-DEMO", "session-a");

    assert.equal(claimHolder(accountKeyFor(1006, "BROKER-DEMO")), null);
    assert.equal(claimHolder(accountKeyFor(1007, "BROKER-DEMO"))?.sessionId, "session-a");
    assert.equal(claimsForSession("session-a").length, 1);

    // The released account is now available to anyone.
    assert.equal((await claim(1006, "BROKER-DEMO", "session-z")).ok, true);
  });

  it("unlinking releases the account for another browser", async () => {
    await claim(1008, "BROKER-DEMO", "session-a");
    await releaseClaimsForSession("session-a");

    assert.equal(claimHolder(accountKeyFor(1008, "BROKER-DEMO")), null);
    assert.equal((await claim(1008, "BROKER-DEMO", "session-b")).ok, true);
  });

  it("releasing is scoped to the owning session", async () => {
    const key = accountKeyFor(1009, "BROKER-DEMO");
    await claim(1009, "BROKER-DEMO", "session-a");

    await releaseClaim(key, "session-b");
    assert.equal(claimHolder(key)?.sessionId, "session-a", "another session must not release a claim");

    await releaseClaim(key, "session-a");
    assert.equal(claimHolder(key), null);
  });

  it("a heartbeat from the owner keeps the claim alive", async () => {
    const key = accountKeyFor(1010, "BROKER-DEMO");
    await claim(1010, "BROKER-DEMO", "session-a");

    assert.equal(touchClaim("session-a", key), true);
    assert.equal(claimHolder(key)?.sessionId, "session-a");
    assert.equal((await claim(1010, "BROKER-DEMO", "session-b")).ok, false);
  });

  it("a heartbeat from a session that no longer owns the account is rejected", async () => {
    const key = accountKeyFor(1011, "BROKER-DEMO");
    await claim(1011, "BROKER-DEMO", "session-a");
    await releaseClaimsForSession("session-a");
    await claim(1011, "BROKER-DEMO", "session-b");

    // session-a's terminal is still heartbeating with a valid token. It must be
    // told to stop, or two Desks would keep streaming one account.
    assert.equal(touchClaim("session-a", key), false);
    assert.equal(touchClaim("session-b", key), true);
  });

  it("an abandoned claim is released once the terminal stops heartbeating", async () => {
    const key = accountKeyFor(1012, "BROKER-DEMO");
    await claim(1012, "BROKER-DEMO", "session-a");

    // Still held while the terminal is live.
    await __testing.ageClaim(key, Date.now() - CLAIM_IDLE_RELEASE_MS + 60_000);
    assert.equal((await claim(1012, "BROKER-DEMO", "session-b")).ok, false);

    // A browser that is simply closed must never lock the account out forever.
    await __testing.ageClaim(key, Date.now() - CLAIM_IDLE_RELEASE_MS - 1);
    const takeover = await claim(1012, "BROKER-DEMO", "session-b");
    assert.equal(takeover.ok, true);
    assert.equal(claimHolder(key)?.sessionId, "session-b");
  });

  it("a refused takeover leaves the original owner untouched", async () => {
    const key = accountKeyFor(1013, "BROKER-DEMO");
    await claim(1013, "BROKER-DEMO", "session-a");
    const before = claimHolder(key);

    await claim(1013, "BROKER-DEMO", "session-b");

    const after = claimHolder(key);
    assert.equal(after?.sessionId, "session-a");
    assert.equal(after?.pairedAt, before?.pairedAt, "a refusal must not restart the pairing clock");
  });

  it("tracks every concurrently held account, one owner each", async () => {
    for (const [index, session] of ["session-a", "session-b", "session-c"].entries()) {
      assert.equal((await claim(2000 + index, "BROKER-DEMO", session)).ok, true);
    }

    const snapshot = __testing.snapshot();
    assert.equal(snapshot.length, 3);
    // One row per account, and no account with two owners.
    assert.equal(new Set(snapshot.map((entry) => entry.accountKey)).size, 3);
    assert.equal(new Set(snapshot.map((entry) => entry.sessionId)).size, 3);
    for (const entry of snapshot) {
      assert.notEqual(entry.lastSeenAt, 0);
      assert.notEqual(entry.sessionId, "");
    }
  });
});
