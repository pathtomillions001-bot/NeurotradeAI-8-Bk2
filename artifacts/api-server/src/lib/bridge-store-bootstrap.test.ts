/**
 * The bootstrap DDL must be applied ONE STATEMENT AT A TIME.
 *
 * WHY THIS TEST EXISTS (the incident it pins): the whole script used to be sent
 * as a single query. Postgres runs a multi-statement simple query in an implicit
 * transaction, so the first statement that failed on an existing database — a
 * `CREATE UNIQUE INDEX` over legacy rows that duplicate each other is the usual
 * one — rolled back everything before it and skipped everything after it. On
 * that database the failure repeated on every boot, so every table and column
 * the script still had to add was never added and `schemaApplied()` could never
 * become true.
 *
 * That is invisible almost everywhere (the app's tables already exist), so it
 * surfaced exactly where the flag was load-bearing: the MT5 bridge, which gated
 * its link lookups on it and therefore answered
 * `503 bridge_store_unavailable` to a terminal whose link row was in the table
 * the whole time. The Desk could never re-attach a live terminal.
 *
 * The invariants: splitting must never cut a statement in half, applying the
 * real script per statement must leave every table the API needs, and a
 * poisoned statement must cost only itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import { bootstrapDdlStatements, splitSqlStatements } from "@workspace/db";

/** The tables `/api/healthz` and the bridge both depend on existing. */
const REQUIRED_TABLES = [
  "accounts",
  "settings",
  "trades",
  "mt5_account_claims",
  "mt5_bridge_links",
  "mt5_pairing_codes",
];

test("the bootstrap script splits at statement boundaries, never inside one", () => {
  const statements = bootstrapDdlStatements();

  assert.ok(
    statements.length >= 60,
    `the whole script must be split into statements, got ${statements.length}`,
  );
  for (const statement of statements) {
    assert.ok(
      statement.trimEnd().endsWith(";"),
      `every statement ends with ';': ${statement.slice(0, 70)}`,
    );
  }

  // A table is created by exactly one statement...
  for (const table of REQUIRED_TABLES) {
    const created = statements.filter((statement) =>
      statement.includes(`CREATE TABLE IF NOT EXISTS ${table} `),
    );
    assert.equal(created.length, 1, `${table} must be created by one statement`);
  }

  // ...and a multi-line CREATE TABLE survives whole: every column is in it, so
  // the splitter cannot have cut the statement at an inner line break.
  const links = statements.find((statement) =>
    statement.includes("CREATE TABLE IF NOT EXISTS mt5_bridge_links "),
  );
  assert.ok(links, "mt5_bridge_links is created by the script");
  for (const column of [
    "token_hash",
    "session_id",
    "account_key",
    "login",
    "server",
    "company",
    "code",
    "paired_at_ms",
    "last_seen_at_ms",
    "revoked_at_ms",
  ]) {
    assert.ok(links.includes(column), `mt5_bridge_links carries ${column}`);
  }
});

test("the real script, applied per statement, leaves every required table", async () => {
  const db = new PGlite();
  try {
    for (const statement of bootstrapDdlStatements()) await db.exec(statement);
    const result = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const created = new Set(result.rows.map((row) => String(row.table_name)));
    for (const table of REQUIRED_TABLES) {
      assert.ok(created.has(table), `${table} exists after the bootstrap`);
    }
  } finally {
    await db.close();
  }
});

test("a poisoned statement no longer takes the rest of the schema with it", async () => {
  const script = `
CREATE TABLE ok_before (a INT);
CREATE TABLE poisoned (a INT, a INT);
CREATE TABLE ok_after (b INT);
`;

  // The old behaviour, for the record: one query, one implicit transaction, and
  // BOTH neighbours are lost — this is what left a real database half-built
  // while the flag that reports it stayed false forever.
  const batched = new PGlite();
  try {
    await assert.rejects(() => batched.exec(script), /specified more than once/);
    for (const table of ["ok_before", "ok_after"]) {
      const result = await batched.query(`SELECT to_regclass('${table}') AS t`);
      assert.equal(
        result.rows[0].t,
        null,
        `${table} is lost when the script is sent as one query`,
      );
    }
  } finally {
    await batched.close();
  }

  // What the bootstrap does now: a failing statement costs only itself.
  const perStatement = new PGlite();
  try {
    const failures: string[] = [];
    for (const statement of splitSqlStatements(script)) {
      try {
        await perStatement.exec(statement);
      } catch {
        failures.push(statement);
      }
    }
    assert.equal(failures.length, 1, "exactly the poisoned statement failed");
    for (const table of ["ok_before", "ok_after"]) {
      const result = await perStatement.query(`SELECT to_regclass('${table}') AS t`);
      assert.equal(
        result.rows[0].t,
        table,
        `${table} survives a sibling statement failing`,
      );
    }
  } finally {
    await perStatement.close();
  }
});
