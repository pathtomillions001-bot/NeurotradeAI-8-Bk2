import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contractSetError,
  cleanDigit,
  decodeContractSet,
  encodeContractSet,
  firstDigitOf,
  specLabel,
} from "./autonomous-contracts";

describe("autonomous contract sets (settings editor)", () => {
  it("encodes and decodes the API form, dropping junk and duplicates", () => {
    const specs = decodeContractSet(["DIGITOVER:3", "RISE:-1", "BOGUS:1", "DIGITOVER:3", "DIGITOVER:9", "DIGITMATCH:-1"]);
    assert.deepEqual(specs, [
      { type: "DIGITOVER", digit: 3 },
      { type: "CALL", digit: -1 },
      { type: "DIGITMATCH", digit: -1 },
    ]);
    assert.deepEqual(encodeContractSet(specs), ["DIGITOVER:3", "CALL:-1", "DIGITMATCH:-1"]);
  });

  it("applies the digit rules per contract type", () => {
    assert.equal(cleanDigit("DIGITOVER", 8), 8);
    assert.equal(cleanDigit("DIGITOVER", 9), null);
    assert.equal(cleanDigit("DIGITUNDER", 0), null);
    assert.equal(cleanDigit("DIGITMATCH", -1), -1);
    assert.equal(cleanDigit("DIGITDIFF", 4), 4);
    assert.equal(cleanDigit("DIGITEVEN", 7), -1);
  });

  it("labels, first-digit lookup and the 8-entry cap", () => {
    assert.equal(specLabel({ type: "DIGITMATCH", digit: -1 }), "Matches auto");
    assert.equal(specLabel({ type: "DIGITOVER", digit: 2 }), "Over 2");
    assert.equal(firstDigitOf([{ type: "DIGITUNDER", digit: 7 }], "DIGITUNDER"), 7);
    assert.equal(firstDigitOf([{ type: "CALL", digit: -1 }], "DIGITOVER"), null);
    assert.equal(contractSetError([], "Normal") !== null, true);
    const nine = Array.from({ length: 9 }, (_, i) => ({ type: "DIGITMATCH" as const, digit: i }));
    assert.equal(contractSetError(nine, "Recovery") !== null, true);
    assert.equal(contractSetError(nine.slice(0, 8), "Recovery"), null);
  });
});
