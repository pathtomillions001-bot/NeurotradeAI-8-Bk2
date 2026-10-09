import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDerivRejection,
  describeDerivRejection,
  explainRejectionKind,
  isUnknownProposalRejection,
  rejectionFromEnvelope,
} from "./trade-rejection";

/**
 * The regression that matters most: "Unknown contract proposal" is Deriv's
 * `InvalidContractProposal`, and it means two opposite things depending on which
 * request produced it. Getting this wrong is what made the autonomous engine
 * hard-stop with "Deriv rejected 3 consecutive 1-tick buys" and then fail the
 * same way on every restart.
 */
describe("classifyDerivRejection", () => {
  it("reads a rejected PURCHASE of an unknown proposal id as a broken handoff", () => {
    const kind = classifyDerivRejection({
      stage: "buy",
      code: "InvalidContractProposal",
      message: "Unknown contract proposal",
    });
    assert.equal(kind, "unknown-proposal");
    assert.equal(isUnknownProposalRejection({ stage: "buy", code: "InvalidContractProposal", message: "Unknown contract proposal" }), true);
  });

  it("reads the SAME text out of a rejected PROPOSAL as an untradeable contract", () => {
    const kind = classifyDerivRejection({
      stage: "proposal",
      code: "InvalidContractProposal",
      message: "Unknown contract proposal",
    });
    assert.equal(kind, "contract-unavailable");
  });

  it("classifies UnknownContract by stage too", () => {
    assert.equal(
      classifyDerivRejection({ stage: "buy", code: "UnknownContract", message: "Unknown contract" }),
      "unknown-proposal",
    );
    assert.equal(
      classifyDerivRejection({ stage: "proposal", code: "UnknownContract", message: "Unknown contract" }),
      "contract-unavailable",
    );
  });

  it("recognises an expired or missing proposal without the exact code", () => {
    for (const message of [
      "Proposal not found",
      "The proposal has expired",
      "Invalid proposal id",
      "Proposal is no longer valid",
    ]) {
      assert.equal(
        classifyDerivRejection({ stage: "buy", code: null, message }),
        "unknown-proposal",
        message,
      );
    }
  });

  it("never calls a throttled or repriced quote an untradeable contract", () => {
    assert.equal(classifyDerivRejection({ stage: "buy", code: "RateLimit", message: "Too many requests" }), "transient");
    assert.equal(classifyDerivRejection({ stage: "proposal", code: "RateLimit", message: "Too many requests" }), "transient");
    assert.equal(classifyDerivRejection({ stage: "buy", code: "TemporaryUnavailable", message: "Temporarily unavailable" }), "transient");
    assert.equal(classifyDerivRejection({ stage: "buy", code: "CircuitBreakerBusy", message: "Health check" }), "transient");
    assert.equal(classifyDerivRejection({ stage: "buy", code: null, message: "Price moved, please try again" }), "transient");
  });

  it("treats account-level refusals as definite, whatever the stage", () => {
    assert.equal(
      classifyDerivRejection({ stage: "proposal", code: "InsufficientBalance", message: "Insufficient balance" }),
      "account-blocked",
    );
    assert.equal(
      classifyDerivRejection({ stage: "buy", code: null, message: "This account is disabled for trading" }),
      "account-blocked",
    );
    assert.equal(
      classifyDerivRejection({ stage: "buy", code: "SelfExclusion", message: "Self-excluded" }),
      "account-blocked",
    );
    assert.equal(
      classifyDerivRejection({ stage: "proposal", code: "AuthorizationRequired", message: "Please authorize" }),
      "account-blocked",
    );
  });

  it("treats market and contract availability refusals as quarantine-able", () => {
    assert.equal(classifyDerivRejection({ stage: "proposal", code: "InvalidSymbol", message: "Invalid symbol" }), "contract-unavailable");
    assert.equal(classifyDerivRejection({ stage: "proposal", code: "MarketClosed", message: "Market is closed" }), "contract-unavailable");
    assert.equal(classifyDerivRejection({ stage: "proposal", code: "InvalidBarrier", message: "Invalid barrier" }), "contract-unavailable");
    assert.equal(
      classifyDerivRejection({ stage: "proposal", code: "InputValidationFailed", message: "This contract is not available on your account" }),
      "contract-unavailable",
    );
  });

  it("falls back to unspecified for a rejection it cannot name", () => {
    assert.equal(classifyDerivRejection({ stage: "buy", code: "SomethingNew", message: "Unusual" }), "unspecified");
    assert.equal(classifyDerivRejection({ stage: "unknown", code: null, message: "" }), "unspecified");
  });

  it("reads stage and code straight off a Deriv envelope", () => {
    const envelope = {
      msg_type: "buy",
      echo_req: { buy: "abc", price: 1 },
      error: { code: "InvalidContractProposal", message: "Unknown contract proposal" },
    };
    const rejection = rejectionFromEnvelope(envelope, "proposal");
    assert.deepEqual(rejection, { stage: "buy", code: "InvalidContractProposal", message: "Unknown contract proposal" });
    assert.equal(classifyDerivRejection(rejection), "unknown-proposal");
    // A missing msg_type keeps the caller's own stage.
    assert.equal(rejectionFromEnvelope({ error: { code: "X" } }, "buy").stage, "buy");
    assert.equal(rejectionFromEnvelope(null, "proposal").stage, "proposal");
  });
});

describe("describeDerivRejection", () => {
  it("names the market and contract the broker text never mentions", () => {
    const text = describeDerivRejection({
      kind: "contract-unavailable",
      code: "InvalidContractProposal",
      message: "Unknown contract proposal",
      symbol: "R_100",
      contractLabel: "Over 3",
      stage: "proposal",
    });
    assert.match(text, /Unknown contract proposal/);
    assert.match(text, /Deriv code InvalidContractProposal/);
    assert.match(text, /Over 3 on R_100/);
    assert.match(text, /not offered that contract/);
  });

  it("explains the stale-quote handoff in words a trader can act on", () => {
    const text = describeDerivRejection({
      kind: "unknown-proposal",
      code: "InvalidContractProposal",
      message: "Unknown contract proposal",
      symbol: "1HZ100V",
      contractLabel: "Rise",
      stage: "buy",
    });
    assert.match(text, /no contract was created/);
    assert.match(text, /Rise on 1HZ100V/);
  });

  it("stays readable without a market or a code", () => {
    assert.equal(
      describeDerivRejection({ kind: "unspecified", message: null }),
      `Deriv rejected the trade — ${explainRejectionKind("unspecified")}.`,
    );
  });
});
