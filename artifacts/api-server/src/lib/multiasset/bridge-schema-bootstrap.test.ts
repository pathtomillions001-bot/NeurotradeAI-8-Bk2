import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  INIT_DDL,
  applySchemaStatements,
  isConnectionLevelFailure,
  splitSqlStatements,
} from "@workspace/db";

/**
 * The bootstrap script must not be all-or-nothing.
 *
 * THE FAILURE THIS FILE PINS (a real one, reproduced against Postgres before
 * the fix): `INIT_DDL` was handed to the driver as ONE query. `pg` sends a
 * parameterless query over the simple protocol, and Postgres runs a
 * multi-statement simple query in ONE IMPLICIT TRANSACTION — so the first
 * statement that fails rolls back everything before it and SKIPS EVERYTHING
 * AFTER IT, on every boot, forever.
 *
 * Several statements in the script are DATA-DEPENDENT — a `CREATE UNIQUE INDEX`
 * over legacy rows that duplicate each other cannot be built, and no amount of
 * retrying will change that. The MT5 bridge's tables (`mt5_account_claims`,
 * `mt5_bridge_links`, `mt5_pairing_codes`) sit near the END of the script, so
 * on such a database they were never created. Pairing still appeared to work
 * (the code lived in process memory), the EA still got a token and saved it,
 * and the terminal only fell over at the next restart — when the lookup had
 * nowhere to go and the Desk answered
 * `503 the bridge link store could not be reached … nothing was revoked`,
 * which the EA correctly treats as transient and retries forever.
 *
 * So the properties below are not style: the bridge's tables must be created
 * even when an unrelated statement cannot apply, and a socket failure must
 * still abort the pass so the caller's back-off does the retrying.
 */
describe("bootstrap DDL — one failing statement must not disable the rest", () => {
  /** A database that has been around a while: legacy duplicates, no bridge tables. */
  async function legacyDatabase(): Promise<PGlite> {
    const db = new PGlite();
    await db.exec(INIT_DDL);
    // The unique index that entered the script later, and the rows that make it
    // impossible to build — the exact state a production database can be in.
    await db.exec(`DROP INDEX IF EXISTS accounts_session_login_unique`);
    await db.exec(`
      INSERT INTO accounts (session_id, login_id, token, is_active)
      VALUES ('legacy', 12345, 'a', TRUE), ('legacy', 12345, 'b', TRUE)
    `);
    // The state this deployment is in: the tables the LATEST release adds do not
    // exist yet, because no pass has ever reached the end of the script.
    for (const table of ["mt5_account_claims", "mt5_bridge_links", "mt5_pairing_codes", "session_links"]) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    return db;
  }

  async function tableExists(db: PGlite, table: string): Promise<boolean> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    return rows[0].n > 0;
  }

  it("creates the bridge's tables even when another statement in the script cannot apply", async () => {
    const db = await legacyDatabase();
    try {
      const failures = await applySchemaStatements(async (sql) => {
        await db.exec(sql);
      });

      assert.equal(failures.length, 1, "exactly the statement Postgres cannot apply should be reported");
      assert.match(failures[0].message.toLowerCase(), /could not create unique index/);
      assert.ok(failures[0].statement.includes("CREATE UNIQUE INDEX"), "the report names the statement");

      // The point of the whole change: the statements AFTER the failure ran.
      for (const table of ["mt5_account_claims", "mt5_bridge_links", "mt5_pairing_codes", "session_links"]) {
        assert.equal(
          await tableExists(db, table),
          true,
          `${table} must exist — it is created after the failing statement, and it is what the MT5 bridge reads`,
        );
      }
    } finally {
      await db.close();
    }
  });

  it("…while the same script as ONE batch still loses every table after the failure", async () => {
    // Not a style preference — this is the primitive that caused the outage.
    // Kept as a test so that going back to a single query fails here first.
    const db = await legacyDatabase();
    try {
      await assert.rejects(
        () => db.exec(INIT_DDL),
        /could not create unique index/,
        "one query, one implicit transaction: the batch throws",
      );
      assert.equal(
        await tableExists(db, "mt5_bridge_links"),
        false,
        "and the tables after the failure are skipped — this is the outage",
      );
      assert.equal(await tableExists(db, "session_links"), false);
    } finally {
      await db.close();
    }
  });

  it("carries on past a statement-level failure but aborts the pass on a connection failure", async () => {
    const applied: string[] = [];
    const failures = await applySchemaStatements(async (sql) => {
      applied.push(sql);
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS trades")) {
        const refused: Error & { code?: string } = new Error("permission denied for schema public");
        refused.code = "42501";
        throw refused;
      }
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "42501");
    assert.ok(
      applied.length === splitSqlStatements(INIT_DDL).length,
      "every statement was still attempted",
    );

    // A dead socket is different: the answer for the remaining statements would
    // be the same, so the pass stops and the caller retries it as a whole.
    const connectionError: Error & { code?: string } = new Error("Connection terminated unexpectedly");
    connectionError.code = "ECONNRESET";
    assert.equal(isConnectionLevelFailure(connectionError), true);
    assert.equal(isConnectionLevelFailure(new Error("permission denied for schema public")), false);

    let reached = 0;
    await assert.rejects(
      () =>
        applySchemaStatements(async (sql) => {
          reached += 1;
          if (sql.startsWith("CREATE TABLE IF NOT EXISTS ai_insights")) throw connectionError;
        }),
      /Connection terminated unexpectedly/,
    );
    assert.ok(reached < splitSqlStatements(INIT_DDL).length, "the rest of the pass was not attempted");
  });

  it("splits on statement boundaries only — never inside a literal, a comment or a quoted block", () => {
    assert.deepEqual(splitSqlStatements(`SELECT 'a;b'; SELECT 2;`), ["SELECT 'a;b'", "SELECT 2"]);
    // '' escapes the quote, so the literal does not end early.
    assert.deepEqual(splitSqlStatements(`INSERT INTO t VALUES ('it''s; fine');`), [
      `INSERT INTO t VALUES ('it''s; fine')`,
    ]);
    // A chunk that is only a comment has nothing to execute, so it is dropped
    // rather than handed to the driver as an empty query.
    assert.deepEqual(splitSqlStatements(`SELECT 1; -- trailing comment\n`), ["SELECT 1"]);
    assert.deepEqual(splitSqlStatements(`/* only a comment; with a semicolon */`), []);
    assert.deepEqual(splitSqlStatements(`DO $$ BEGIN PERFORM 1; END $$; SELECT 3;`), [
      `DO $$ BEGIN PERFORM 1; END $$`,
      "SELECT 3",
    ]);
  });

  it("states the contract of the script it ships", () => {
    const statements = splitSqlStatements(INIT_DDL);
    assert.ok(statements.length > 50, "the script is a script, not a handful of statements");
    // The bridge tables must exist as their own statements, after the
    // data-dependent index over accounts that can fail on a legacy database.
    const bridgeAt = statements.findIndex((s) => s.includes("CREATE TABLE IF NOT EXISTS mt5_bridge_links"));
    const accountsIndexAt = statements.findIndex((s) =>
      s.includes("CREATE UNIQUE INDEX IF NOT EXISTS accounts_session_login_unique"),
    );
    assert.ok(bridgeAt > accountsIndexAt, "the bridge tables come after the statement that can fail");
  });
});
