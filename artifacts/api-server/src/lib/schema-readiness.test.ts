import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSchemaBootstrap,
  SchemaNotReadyError,
} from "@workspace/db";

describe("database schema readiness", () => {
  it("stays unready after a failed DDL attempt, then resolves only after recovery", async () => {
    let attempts = 0;
    let reportFailure!: () => void;
    let releaseRetry!: () => void;
    const failedOnce = new Promise<void>((resolve) => {
      reportFailure = resolve;
    });
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const bootstrap = createSchemaBootstrap({
      apply: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("database_url=password must not be reported"), {
            code: "ECONNREFUSED",
          });
        }
      },
      retryDelayMs: () => 0,
      sleep: () => retryGate,
      onFailure: () => reportFailure(),
    });

    bootstrap.start();
    bootstrap.start(); // only one background retry loop may own readiness
    await failedOnce;

    const failedStatus = bootstrap.status();
    assert.equal(failedStatus.ready, false);
    assert.equal(failedStatus.attempts, 1);
    assert.equal(failedStatus.readyAt, null);
    assert.ok(typeof failedStatus.lastAttemptAt === "number");
    assert.ok(typeof failedStatus.lastFailureAt === "number");
    assert.equal(failedStatus.lastFailureCode, "ECONNREFUSED");
    let readyResolved = false;
    void bootstrap.ready.then(() => { readyResolved = true; });
    await Promise.resolve();
    assert.equal(readyResolved, false);
    await assert.rejects(bootstrap.waitForReady(5), SchemaNotReadyError);

    releaseRetry();
    await bootstrap.ready;
    assert.equal(attempts, 2);
    assert.equal(bootstrap.status().ready, true);
    assert.ok(bootstrap.status().readyAt !== null);
    assert.equal(bootstrap.status().lastFailureCode, "ECONNREFUSED");
  });

  it("reports a bounded not-ready timeout without exposing raw database details", async () => {
    const bootstrap = createSchemaBootstrap({
      apply: async () => {
        throw Object.assign(new Error("postgres://user:secret@host/db"), {
          code: "28P01",
        });
      },
      retryDelayMs: () => 50,
      sleep: () => new Promise<void>(() => {}),
    });
    bootstrap.start();

    await assert.rejects(bootstrap.waitForReady(5), (error: unknown) => {
      assert.ok(error instanceof SchemaNotReadyError);
      assert.equal((error as SchemaNotReadyError).code, "SCHEMA_NOT_READY");
      assert.doesNotMatch((error as Error).message, /secret|postgres:|host/i);
      return true;
    });
    assert.equal(bootstrap.status().lastFailureCode, "28P01");
  });
});
