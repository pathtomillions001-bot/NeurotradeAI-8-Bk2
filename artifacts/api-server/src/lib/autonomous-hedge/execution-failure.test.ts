import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideExecutionFailure,
  EXEC_FAILURE_LIMIT,
  QUOTE_FAILURE_LIMIT,
  type ExecutionFailureState,
} from "./execution-failure";

function state(overrides: Partial<ExecutionFailureState> = {}): ExecutionFailureState {
  return {
    execFailures: 0,
    quoteFailures: 0,
    blocked: [],
    candidateKeys: ["R_100:DIGITOVER:3", "R_100:CALL:-1", "1HZ100V:DIGITEVEN:-1"],
    ...overrides,
  };
}

const UNKNOWN_PROPOSAL = {
  code: "InvalidContractProposal",
  message: "Unknown contract proposal",
  stage: "buy",
  symbol: "R_100",
  contractType: "DIGITOVER",
  barrier: 3,
  candidateKey: "R_100:DIGITOVER:3",
  contractLabel: "Over 3",
} as const;

describe("autonomous execution-failure policy", () => {
  it("does NOT kill the engine for a rejected quote→purchase handoff", () => {
    // This is the reported bug: three of these stopped the engine for good and
    // the stop reason was the broker's raw text with no market, contract or code.
    for (let failures = 0; failures < QUOTE_FAILURE_LIMIT - 1; failures++) {
      const action = decideExecutionFailure({ ...UNKNOWN_PROPOSAL, state: state({ quoteFailures: failures }) });
      assert.equal(action.kind, "unknown-proposal");
      assert.equal(action.stop, false, `must keep running after ${failures + 1} handoff refusals`);
      assert.equal(action.countAsExecFailure, false, "a stale quote is not a definite rejection");
      assert.equal(action.countAsQuoteFailure, true);
      assert.equal(action.quarantine, false, "the contract itself is fine — do not block it");
      assert.match(action.held, /Nothing was purchased/);
      assert.match(action.held, /Over 3 on R_100/);
    }
  });

  it("still stops after a finite run of handoff refusals, and says nothing was bought", () => {
    const action = decideExecutionFailure({
      ...UNKNOWN_PROPOSAL,
      state: state({ quoteFailures: QUOTE_FAILURE_LIMIT - 1 }),
    });
    assert.equal(action.stop, true);
    assert.match(action.reason!, /No contract was created and no money moved/);
    assert.match(action.reason!, /InvalidContractProposal/);
    assert.match(action.reason!, /throttling/);
  });

  it("quarantines a contract the account is not offered and keeps trading the rest", () => {
    const action = decideExecutionFailure({
      ...UNKNOWN_PROPOSAL,
      stage: "proposal",
      state: state(),
    });
    assert.equal(action.kind, "contract-unavailable");
    assert.equal(action.quarantine, true);
    assert.equal(action.stop, false, "two other candidates are still tradeable");
    assert.equal(action.countAsExecFailure, false);
    assert.match(action.held, /trading the rest of your selected set/);
    assert.match(action.held, /Over 3 on R_100/);
  });

  it("stops with an actionable reason once every selected contract is refused", () => {
    const action = decideExecutionFailure({
      ...UNKNOWN_PROPOSAL,
      stage: "proposal",
      state: state({
        blocked: ["R_100:CALL:-1"],
        candidateKeys: ["R_100:DIGITOVER:3", "R_100:CALL:-1"],
      }),
    });
    assert.equal(action.stop, true);
    assert.match(action.reason!, /cannot trade any contract in your selected set/);
    assert.match(action.reason!, /synthetic indices/);
  });

  it("stops on the first account-level refusal, whatever the counters say", () => {
    const action = decideExecutionFailure({
      code: "InsufficientBalance",
      message: "Insufficient balance",
      stage: "proposal",
      symbol: "R_100",
      contractType: "CALL",
      barrier: -1,
      candidateKey: "R_100:CALL:-1",
      contractLabel: "Rise",
      state: state(),
    });
    assert.equal(action.kind, "account-blocked");
    assert.equal(action.stop, true);
    assert.equal(action.quarantine, false);
    assert.match(action.reason!, /Lower the stake or top up/);
  });

  it("keeps the three-strike stop for a rejection it cannot classify", () => {
    const unspecified = {
      code: "SomethingNew",
      message: "Unusual refusal",
      stage: "buy",
      symbol: "1HZ100V",
      contractType: "DIGITEVEN",
      barrier: -1,
      candidateKey: "1HZ100V:DIGITEVEN:-1",
      contractLabel: "Even",
    };
    for (let failures = 0; failures < EXEC_FAILURE_LIMIT - 1; failures++) {
      const action = decideExecutionFailure({ ...unspecified, state: state({ execFailures: failures }) });
      assert.equal(action.stop, false);
      assert.equal(action.countAsExecFailure, true);
      assert.equal(action.quarantine, false);
    }
    const stopped = decideExecutionFailure({
      ...unspecified,
      state: state({ execFailures: EXEC_FAILURE_LIMIT - 1 }),
    });
    assert.equal(stopped.stop, true);
    // Same wording the engine has always used, now with the market, contract and code.
    assert.match(stopped.reason!, /Deriv rejected 3 consecutive 1-tick buys/);
    assert.match(stopped.reason!, /Even on 1HZ100V/);
    assert.match(stopped.reason!, /SomethingNew/);
  });

  it("classifies from raw fields when the caller has no DerivTradeError", () => {
    const throttled = decideExecutionFailure({
      code: "RateLimit",
      message: "You have reached the rate limit of requests per second",
      stage: "buy",
      symbol: "R_10",
      contractType: "PUT",
      barrier: -1,
      candidateKey: "R_10:PUT:-1",
      state: state(),
    });
    assert.equal(throttled.kind, "transient");
    assert.equal(throttled.stop, false);
    assert.equal(throttled.countAsQuoteFailure, true);
  });
});
