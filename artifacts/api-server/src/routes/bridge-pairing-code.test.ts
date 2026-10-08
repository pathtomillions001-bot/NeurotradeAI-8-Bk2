import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { after, before, describe, it } from "node:test";
import { pool, schemaReady } from "@workspace/db";
import { browserSession } from "../lib/session";
import { findPairing } from "../lib/multiasset/bridge-links";
import bridgeRouter from "./bridge";

const app = express();
app.use(express.json());
app.use(browserSession);
app.use("/api/bridge", bridgeRouter);

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

before(async () => {
  await schemaReady;
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

async function requestPairingCode(sessionId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/bridge/pairing-code`, {
    method: "POST",
    headers: { "x-tab-session": sessionId, "content-type": "application/json" },
    body: "{}",
  });
}

describe("POST /api/bridge/pairing-code", () => {
  it("saves a hashed durable code and returns the matching session on success", async () => {
    const sessionId = randomUUID();
    const response = await requestPairingCode(sessionId);
    assert.equal(response.status, 200);
    const payload = await response.json() as { pairingCode?: unknown };
    assert.equal(typeof payload.pairingCode, "string");
    assert.ok((payload.pairingCode as string).trim().length > 0);

    const pairingCode = payload.pairingCode as string;
    const pairing = await findPairing(pairingCode);
    assert.equal(pairing?.sessionId, sessionId);
    const stored = await pool.query(
      "SELECT code_hash FROM mt5_bridge_links WHERE session_id = $1",
      [sessionId],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(
      stored.rows[0].code_hash,
      createHash("sha256").update(pairingCode).digest("hex"),
    );
    assert.notEqual(stored.rows[0].code_hash, pairingCode);
  });

  it("returns safe structured 503 on a failed durable write, then recovers on an explicit retry", async () => {
    const sessionId = randomUUID();
    const originalQuery = pool.query;
    let failNextPairingWrite = true;
    pool.query = async (text: string, params?: unknown[]) => {
      if (
        failNextPairingWrite &&
        text.includes("INSERT INTO mt5_bridge_links")
      ) {
        failNextPairingWrite = false;
        throw Object.assign(new Error("must not return or log raw database details"), {
          code: "42P01",
        });
      }
      return originalQuery(text, params);
    };

    try {
      const failed = await requestPairingCode(sessionId);
      assert.equal(failed.status, 503);
      const errorBody = await failed.json() as {
        error?: { code?: string; message?: string; retryable?: boolean; requestId?: string };
      };
      assert.equal(errorBody.error?.code, "pairing_code_unavailable");
      assert.equal(errorBody.error?.retryable, true);
      assert.ok(errorBody.error?.requestId);
      assert.match(errorBody.error?.message ?? "", /retry/i);
      assert.doesNotMatch(
        JSON.stringify(errorBody),
        /must not return|42P01|database_url|password/i,
      );

      // A failed durable insert must not manufacture a process-local fallback.
      const absent = await originalQuery(
        "SELECT session_id FROM mt5_bridge_links WHERE session_id = $1",
        [sessionId],
      );
      assert.equal(absent.rows.length, 0);

      // The retry is an explicit second request after the injected storage
      // failure; the schema/code insert recovers without deleting other rows.
      const retried = await requestPairingCode(sessionId);
      assert.equal(retried.status, 200);
      const successBody = await retried.json() as { pairingCode?: unknown };
      assert.equal(typeof successBody.pairingCode, "string");
      assert.ok((successBody.pairingCode as string).trim().length > 0);
      assert.equal(
        (await findPairing(successBody.pairingCode as string))?.sessionId,
        sessionId,
      );
    } finally {
      pool.query = originalQuery;
    }
  });
});
