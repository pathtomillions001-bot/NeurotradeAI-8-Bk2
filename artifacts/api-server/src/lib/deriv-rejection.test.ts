import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyDerivRejection, DerivApiError } from "./deriv";

/**
 * The classifier is what decides whether a rejection costs the autonomous
 * engine a strike or quarantines a contract, so the exact sentence the user
 * reported must land on the right side of that line.
 */
describe("classifyDerivRejection", () => {
  it('reads "Unknown contract proposal" as this account cannot quote that contract', () => {
    const verdict = classifyDerivRejection(new Error("Unknown contract proposal"));
    assert.equal(verdict.kind, "contract-unavailable");
    assert.match(verdict.hint, /cannot quote/i);
  });

  it("keeps the broker's code when the rejection carries one", () => {
    const err = new DerivApiError({
      message: "Unknown contract proposal",
      code: "UnknownContract",
      phase: "buy",
      request: { buy: "123", price: 0.35 },
    });
    const verdict = classifyDerivRejection(err);
    assert.equal(verdict.kind, "contract-unavailable");
    assert.equal(verdict.code, "UnknownContract");
    assert.equal(err.phase, "buy");
    assert.deepEqual(err.request, { buy: "123", price: 0.35 });
  });

  it("classifies the known capability codes", () => {
    for (const code of ["InvalidContractProposal", "ContractBuyValidationError", "MarketClosed", "UnknownSymbol"]) {
      const verdict = classifyDerivRejection(new DerivApiError({
        message: "rejected", code, phase: "proposal", request: {},
      }));
      assert.equal(verdict.kind, "contract-unavailable", `${code} should be a capability verdict`);
    }
  });

  it("classifies the wording variants that mean the same thing", () => {
    for (const message of [
      "Contract type is not available for this account",
      "This contract is not offered on this market",
      "Market is closed",
      "Invalid contract parameters",
    ]) {
      assert.equal(
        classifyDerivRejection(new Error(message)).kind,
        "contract-unavailable",
        `"${message}" should be a capability verdict`,
      );
    }
  });

  it("never reads a throttled or restarting broker as a capability verdict", () => {
    for (const message of [
      "Rate limit exceeded, please try again",
      "Too many requests",
      "Service temporarily unavailable",
      "Price has moved, please try again",
    ]) {
      assert.equal(classifyDerivRejection(new Error(message)).kind, "transient", `"${message}" is transient`);
    }
    assert.equal(
      classifyDerivRejection(new DerivApiError({ message: "busy", code: "CircuitBreakerBusy", phase: "proposal", request: {} })).kind,
      "transient",
    );
  });

  it("separates stake and balance problems from capability problems", () => {
    assert.equal(classifyDerivRejection(new Error("Stake is below the minimum stake")).kind, "stake-out-of-bounds");
    assert.equal(classifyDerivRejection(new Error("Amount exceeds the maximum allowed")).kind, "stake-out-of-bounds");
    assert.equal(classifyDerivRejection(new Error("Insufficient balance")).kind, "funds");
    assert.equal(
      classifyDerivRejection(new DerivApiError({ message: "no", code: "InsufficientFund", phase: "buy", request: {} })).kind,
      "funds",
    );
  });

  it("reports auth failures as auth", () => {
    assert.equal(
      classifyDerivRejection(new DerivApiError({ message: "expired", code: "AuthorizationRequired", phase: "proposal", request: {} })).kind,
      "auth",
    );
    assert.equal(classifyDerivRejection(new Error("Session expired — please reconnect")).kind, "auth");
  });

  it("stays unknown for anything unrecognised, so it cannot silence a contract", () => {
    const verdict = classifyDerivRejection(new Error("something nobody has seen before"));
    assert.equal(verdict.kind, "unknown");
    assert.equal(classifyDerivRejection(null).kind, "unknown");
  });
});
