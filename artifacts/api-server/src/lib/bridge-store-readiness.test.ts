import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REQUIRED_TABLES,
  applyDdlStatements,
  bootstrapDdlStatements,
  pool,
  requiredTablesPresent,
  schemaReady,
  splitSqlStatements,
} from "@workspace/db";
import { __testing as linkTesting, lookupBridgeLink, saveBridgeLink } from "./multiasset/bridge-links";

/**
 * THE FAILURE THIS PINS
 *
 * A terminal was refused on every heartbeat with
 *
 *     HTTP 503 from /api/bridge/sync — The bridge link store could not be
 *     reached, so this terminal's link could not be verified.
 *
 * while its link row sat in the database, readable and un-revoked. The server
 * was not unable to read it: `storeConsultable()` refused to try, because the
 * bootstrap script's success flag was false — and that flag was false forever,
 * because Postgres runs a multi-statement simple query in ONE implicit
 * transaction, so a single `CREATE UNIQUE INDEX` that the existing rows will not
 * accept rolled back the script and silently skipped every statement after it,
 * on every boot, on that database.
 *
 * TWO PROPERTIES, and both are asserted here against the real script and the
 * real test database:
 *
 *   1. one statement the data will not accept cannot cost the deployment the
 *      rest of its schema (the statements after it still run);
 *   2. a store that can answer is READ — a schema statement that cannot be
 *      applied is never reported as "the link store could not be reached".
 *
 * A CONNECTION failure is deliberately NOT swallowed: a dead database must keep
 * the old behaviour (abort the pass, back off, try the whole script again),
 * which is what `ddlRetryLoop()` in `@workspace/db` does.
 */
describe("the bootstrap DDL cannot be denied by one bad statement", () => {
  it("splits the script into whole statements — a `;` in a comment or a literal is not a boundary", () => {
    // The real script contains `;` inside `--` comments; a naive split(";")
    // cuts those statements in half.
    assert.equal(splitSqlStatements("SELECT 1 -- the lease is measured from here; and here\n; SELECT 2").length, 2);
    assert.equal(splitSqlStatements("INSERT INTO t VALUES ('a; b'); SELECT 1").length, 2);
    assert.equal(splitSqlStatements("SELECT \"odd;name\" FROM t; SELECT 1").length, 2);
    assert.equal(splitSqlStatements("DO $body$ BEGIN PERFORM 1; END $body$; SELECT 1").length, 2);
    assert.equal(splitSqlStatements("/* a ; b */ SELECT 1").length, 1);
    assert.equal(splitSqlStatements("-- only a comment; nothing to run").length, 0);

    const statements = bootstrapDdlStatements();
    assert.ok(
      statements.length > 50,
      `the bootstrap script should be dozens of statements, got ${statements.length}`,
    );
    for (const statement of statements) {
      assert.equal(
        splitSqlStatements(statement).length,
        1,
        `not a single statement: ${statement.trim().slice(0, 80)}`,
      );
    }
    // The bridge's own tables are the ones the 503 was about; they are in there.
    assert.ok(statements.some((s) => /CREATE TABLE IF NOT EXISTS mt5_bridge_links/.test(s)));
    assert.ok(statements.some((s) => /CREATE TABLE IF NOT EXISTS mt5_pairing_codes/.test(s)));
  });

  it("applies every statement after one that the data will not accept", async () => {
    const statements = bootstrapDdlStatements();
    const attempted: string[] = [];
    const result = await applyDdlStatements(async (statement) => {
      attempted.push(statement);
      if (/accounts_session_login_unique/.test(statement)) {
        throw Object.assign(new Error('could not create unique index "accounts_session_login_unique"'), {
          code: "23505",
        });
      }
    });

    assert.equal(result.failed, 1);
    assert.equal(result.applied, statements.length - 1);
    assert.equal(
      attempted.length,
      statements.length,
      "a failing statement must not stop the ones after it — that is the whole bug",
    );
    assert.ok(
      attempted.some((s) => /CREATE TABLE IF NOT EXISTS mt5_bridge_links/.test(s)),
      "the bridge's table must still be created when an earlier statement fails",
    );
  });

  it("still aborts the pass on a CONNECTION failure, so the retry loop can back off", async () => {
    const attempted: string[] = [];
    await assert.rejects(
      () =>
        applyDdlStatements(async (statement) => {
          attempted.push(statement);
          if (attempted.length === 3) {
            throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
          }
        }),
      /ECONNREFUSED/,
    );
    assert.equal(attempted.length, 3, "a dead database is not a per-statement problem");
  });

  it("builds the bridge's tables — and keeps them readable — when a statement over legacy rows can never succeed", async () => {
    await schemaReady;

    // The deployment's state, exactly: rows that make one CREATE UNIQUE INDEX
    // impossible, and the bridge's own tables not yet created (they are below
    // it in the script, so the aborted batch never reached them).
    await pool.query("DROP INDEX IF EXISTS accounts_session_login_unique");
    await pool.query("DROP TABLE IF EXISTS mt5_bridge_links, mt5_pairing_codes");
    await pool.query(
      `INSERT INTO accounts (session_id, login_id, is_active)
       VALUES ('legacy-dup', 'VRTC90210', TRUE), ('legacy-dup', 'VRTC90210', TRUE)`,
    );

    const { failed } = await applyDdlStatements((statement) => pool.query(statement));
    assert.ok(failed >= 1, "the fixture must really poison one statement");
    assert.equal(
      await requiredTablesPresent(),
      true,
      "readiness means the tables exist — not that the script returned without throwing",
    );
    for (const table of REQUIRED_TABLES) {
      const { rows } = await pool.query(`SELECT to_regclass($1) AS oid`, [`public.${table}`]);
      assert.ok(rows[0].oid, `${table} should exist`);
    }

    // And the store is READ, not refused: a cold process (no in-process mirror)
    // finds the terminal's own row.
    const token = "readiness-test-token";
    await saveBridgeLink({
      token,
      sessionId: "s-readiness",
      accountKey: "2001244359@JUSTMARKETS-DEMO",
      login: 2001244359,
      server: "JustMarkets-Demo",
      company: "JustMarkets",
      code: "ABCD-2345",
    });
    linkTesting.forgetLinkMemory();

    const lookup = await lookupBridgeLink(token);
    assert.equal(
      lookup.checked,
      true,
      "a schema statement that cannot be applied must never be reported as an unreadable store",
    );
    assert.equal(lookup.record?.login, 2001244359, "the terminal's link must be found");

    // Leave the database exactly as it was found.
    await pool.query("DELETE FROM accounts WHERE session_id = 'legacy-dup'");
    await pool.query("DELETE FROM mt5_bridge_links WHERE session_id = 's-readiness'");
    linkTesting.forgetLinkMemory();
    await applyDdlStatements((statement) => pool.query(statement));
    const restored = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'accounts_session_login_unique'`,
    );
    assert.equal(restored.rows.length, 1, "the cleanup must leave the schema exactly as it found it");
  });
});
