/** Regression coverage for Desk → Link MT5 pairing-code UI behavior. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DeskApiError,
  PairingCodeResponseError,
  deskApiErrorFromResponse,
  pairingRequestView,
  parsePairingCodeResponse,
  shouldRequestInitialPairingCode,
} from "./pairing-code.js";

describe("MT5 pairing response validation", () => {
  it("accepts and trims a successful durable pairing code", () => {
    assert.deepEqual(
      parsePairingCodeResponse({ pairingCode: "  A1B2-C3D4  ", expiresInMs: null }),
      { pairingCode: "A1B2-C3D4", expiresInMs: null },
    );
  });

  it("rejects absent, non-string and whitespace-only codes even on HTTP 2xx", () => {
    for (const response of [
      {},
      { pairingCode: null },
      { pairingCode: 12345 },
      { pairingCode: "  \n  " },
      null,
    ]) {
      assert.throws(() => parsePairingCodeResponse(response), PairingCodeResponseError);
    }
  });

  it("parses structured server errors without losing their actionable message", () => {
    const error = deskApiErrorFromResponse(503, "Service Unavailable", {
      error: {
        code: "pairing_code_unavailable",
        message: "Pairing service is temporarily unavailable. Retry in a moment.",
        retryable: true,
        requestId: "safe-request-id",
      },
    });
    assert.ok(error instanceof DeskApiError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "pairing_code_unavailable");
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, "safe-request-id");
  });
});

describe("MT5 pairing dialog states", () => {
  it("shows a clear loading state and does not offer retry while a request is pending", () => {
    assert.deepEqual(
      pairingRequestView({ isPending: true }),
      { kind: "loading", showRetry: false },
    );
  });

  it("shows a successful code only when one is present", () => {
    assert.deepEqual(
      pairingRequestView({ isPending: false, data: { pairingCode: "ABCD-EFGH" } }),
      { kind: "ready", code: "ABCD-EFGH", showRetry: false },
    );
  });

  it("surfaces actionable failures and enables the explicit retry action", () => {
    const apiError = deskApiErrorFromResponse(503, "Service Unavailable", {
      error: {
        code: "database_not_ready",
        message: "The database is still initializing. Retry in a few seconds.",
        retryable: true,
        requestId: "support-ref",
      },
    });
    assert.deepEqual(pairingRequestView({ isPending: false, error: apiError }), {
      kind: "error",
      message: "The database is still initializing. Retry in a few seconds. Reference: support-ref",
      showRetry: true,
    });
  });

  it("offers retry for a malformed success instead of showing a fake code", () => {
    const view = pairingRequestView({
      isPending: false,
      error: new PairingCodeResponseError(),
    });
    assert.equal(view.kind, "error");
    if (view.kind !== "error") return;
    assert.equal(view.showRetry, true);
    assert.match(view.message, /empty code.*Retry/i);
  });

  it("requests one automatic code only; reopening or status polling cannot rotate it", () => {
    const firstOpen = shouldRequestInitialPairingCode({
      open: true,
      linked: false,
      alreadyAttempted: false,
    });
    assert.equal(firstOpen, true);
    assert.equal(
      shouldRequestInitialPairingCode({
        open: true,
        linked: false,
        alreadyAttempted: true,
      }),
      false,
    );
    assert.equal(
      shouldRequestInitialPairingCode({
        open: false,
        linked: false,
        alreadyAttempted: false,
      }),
      false,
    );
    assert.equal(
      shouldRequestInitialPairingCode({
        open: true,
        linked: true,
        alreadyAttempted: false,
      }),
      false,
    );
  });
});
