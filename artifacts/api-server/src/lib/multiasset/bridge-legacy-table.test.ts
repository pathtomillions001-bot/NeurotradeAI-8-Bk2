import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SCHEMA_BOOTSTRAP_DDL, reconcileLegacyBridgeTables } from "@workspace/db";

const runner = (db: PGlite) => async (text: string, params?: unknown[]) => ({
  rows: (await db.query(text, params)).rows,
});

const legacyShapes = [
  {
    name: "A (code hashes and nullable token hash)",
    ddl: `CREATE TABLE mt5_bridge_links (
      session_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      token_hash TEXT UNIQUE,
      terminal JSONB,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      code_account_key TEXT,
      connector_id TEXT,
      connector_seen_ms BIGINT NOT NULL DEFAULT 0
    );
    INSERT INTO mt5_bridge_links (session_id, code_hash) VALUES ('old-session', 'old-code');`,
  },
  {
    name: "B (raw bridge token)",
    ddl: `CREATE TABLE mt5_bridge_links (
      session_id TEXT PRIMARY KEY,
      bridge_token TEXT NOT NULL,
      login BIGINT NOT NULL,
      server TEXT NOT NULL,
      company TEXT,
      paired_at_ms BIGINT NOT NULL,
      last_sync_at_ms BIGINT NOT NULL,
      sync_interval_ms INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO mt5_bridge_links
      (session_id, bridge_token, login, server, paired_at_ms, last_sync_at_ms)
      VALUES ('old-session', 'old-token', 123, 'Demo', 100, 200);`,
  },
];

const upsertLink = (db: PGlite, lastSeen = 2000) => db.query(
  `INSERT INTO mt5_bridge_links
    (token_hash, session_id, account_key, login, server, company, code,
     paired_at_ms, last_seen_at_ms, revoked_at_ms)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)
   ON CONFLICT (token_hash) DO UPDATE SET last_seen_at_ms = EXCLUDED.last_seen_at_ms`,
  ["token-hash", "desk-session", "123@DEMO", 123, "Demo", "Company", "NEW-CODE", 1000, lastSeen],
);

for (const shape of legacyShapes) {
  test(`legacy bridge shape ${shape.name}: bootstrap alone fails on account_key`, async () => {
    const db = new PGlite();
    try {
      await db.exec(shape.ddl);
      await assert.rejects(db.exec(SCHEMA_BOOTSTRAP_DDL), /account_key/);
    } finally {
      await db.close();
    }
  });

  test(`legacy bridge shape ${shape.name}: reconciliation preserves old rows and repairs bootstrap`, async () => {
    const db = new PGlite();
    try {
      await db.exec(shape.ddl);
      // Existing schema-wide index names must be available to the new table.
      await db.exec(`CREATE INDEX mt5_bridge_links_session_idx ON mt5_bridge_links (session_id)`);
      assert.deepEqual(await reconcileLegacyBridgeTables(runner(db), 1234), ["mt5_bridge_links"]);
      await db.exec(SCHEMA_BOOTSTRAP_DDL);
      await db.exec(SCHEMA_BOOTSTRAP_DDL);
      await upsertLink(db);
      await upsertLink(db, 3000);
      const { rows } = await db.query(`SELECT * FROM mt5_bridge_links`);
      assert.deepEqual(rows, [{
        token_hash: "token-hash", session_id: "desk-session", account_key: "123@DEMO",
        login: 123, server: "Demo", company: "Company", code: "NEW-CODE",
        paired_at_ms: 1000, last_seen_at_ms: 3000, revoked_at_ms: null,
      }]);
      const legacy = await db.query(`SELECT to_regclass('mt5_bridge_links_legacy_1234') AS name`);
      assert.notEqual(legacy.rows[0].name, null);
      assert.deepEqual(
        (await db.query(`SELECT session_id FROM mt5_bridge_links_legacy_1234`)).rows,
        [{ session_id: "old-session" }],
      );
    } finally {
      await db.close();
    }
  });
}

test("reconciliation leaves absent and current bridge tables alone, preserving current rows", async () => {
  const db = new PGlite();
  try {
    assert.deepEqual(await reconcileLegacyBridgeTables(runner(db), 1234), []);
    await db.exec(SCHEMA_BOOTSTRAP_DDL);
    await upsertLink(db);
    const before = (await db.query(`SELECT * FROM mt5_bridge_links`)).rows;
    assert.equal(before.length, 1);
    assert.deepEqual(await reconcileLegacyBridgeTables(runner(db), 1234), []);
    assert.deepEqual((await db.query(`SELECT * FROM mt5_bridge_links`)).rows, before);
  } finally {
    await db.close();
  }
});
