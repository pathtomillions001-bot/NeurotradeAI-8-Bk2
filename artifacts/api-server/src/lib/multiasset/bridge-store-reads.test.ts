import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { pool, schemaReady, schemaTesting } from "@workspace/db";
import {
  PAIRING_CODE_TABLE,
  __testing as linkTesting,
  lookupBridgeLink,
  lookupPairingCode,
  saveBridgeLink,
} from "./bridge-links";

/**
 * What `checked: false` is allowed to mean.
 *
 * `checked: false` is a promise to the MT5 terminal: "I could not check, so
 * nothing is revoked — come back". It is therefore reserved for the two things
 * that are actually true about a broken STORE (no pool, the query did not run).
 *
 * It used to also mean "the process-local bootstrap flag is false" — an opinion
 * about a SCRIPT. On a database where one statement of that script could not
 * apply, the flag never became true, and every read of a link row that was
 * right there was answered `503 the bridge link store could not be reached`.
 * The terminal retried forever and could not re-pair either, because a 503
 * correctly revokes nothing. The store was fine. See
 * docs/mt5-bridge-schema-bootstrap.md.
 */
describe("bridge store reads — the schema flag is not the store", () => {
  before(async () => {
    await schemaReady;
  });

  after(() => {
    linkTesting.healStore();
    schemaTesting.setSchemaApplied(true);
    linkTesting.forgetProcessMemory();
  });

  it("serves a link row while the bootstrap flag is false", async () => {
    await linkTesting.forgetProcessMemory();
    const token = "nt_store_read_flag_false";
    await saveBridgeLink({
      token,
      sessionId: "session-read",
      accountKey: "7001@BROKER-DEMO",
      login: 7001,
      server: "BROKER-DEMO",
      company: "Broker Ltd",
      code: "READ-TEST",
    });

    // The degraded schema state: the script ran to the end, a statement in it did
    // not apply. Every table that COULD be created exists — including this one.
    schemaTesting.setSchemaApplied(false);
    // Only the store can answer now: the in-process mirror has been cleared.
    linkTesting.forgetLinkMemory();

    const lookup = await lookupBridgeLink(token);
    assert.equal(
      lookup.checked,
      true,
      "the row is readable, so the answer about it is trustworthy — regardless of the flag",
    );
    assert.equal(lookup.health, "ok");
    assert.equal(lookup.record?.login, 7001);
    schemaTesting.setSchemaApplied(true);
  });

  it("names a table that does not exist, instead of blaming the connection", async () => {
    await linkTesting.forgetProcessMemory();
    // The state a failing statement leaves behind: the table itself never arrived.
    await pool.query(`DROP TABLE IF EXISTS ${PAIRING_CODE_TABLE}`);

    const lookup = await lookupPairingCode("NOPE-NOPE");
    assert.equal(lookup.checked, false);
    assert.equal(lookup.health, "not-ready", "a missing table is a schema answer, not a store outage");
    assert.match(
      String(lookup.detail),
      new RegExp(PAIRING_CODE_TABLE),
      "the detail says WHICH table is missing, which is what makes it fixable",
    );

    // Put it back, so the rest of the suite (and any later test file sharing this
    // process's store) sees the schema it expects.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${PAIRING_CODE_TABLE} (
         code TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         created_at_ms BIGINT NOT NULL,
         expires_at_ms BIGINT NOT NULL,
         redeemed_at_ms BIGINT
       )`,
    );
    assert.equal((await lookupPairingCode("NOPE-NOPE")).health, "ok");
  });

  it("still answers 'retry, nothing revoked' when the store really cannot answer", async () => {
    linkTesting.failStore("simulated outage");
    try {
      const lookup = await lookupBridgeLink("nt_anything");
      assert.equal(lookup.checked, false);
      assert.equal(lookup.health, "error");
      assert.match(String(lookup.detail), /simulated outage/);
    } finally {
      linkTesting.healStore();
    }
    assert.equal(
      lookupHoldsNothing(),
      true,
      "no revocation was written by a store that could not answer",
    );
  });
});

/** No link row is ever written with a revocation by a failed read. */
function lookupHoldsNothing(): boolean {
  return linkTesting.linkSnapshot().every((record) => record.revokedAt === null);
}
