import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { familySpecsFor, normalizePreferredTypes } from "./families";

const settings = {
  preferredContractTypes: ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"],
  normalOverDigit: 2,
  normalUnderDigit: 7,
  recoveryOverDigit: 4,
  recoveryUnderDigit: 5,
};

describe("autonomous families", () => {
  it("maps RISE/FALL onto CALL/PUT, de-duplicates and drops unknown types", () => {
    assert.deepEqual(
      normalizePreferredTypes(["RISE", "CALL", "FALL", "PUT", "BOGUS", "DIGITEVEN", "RISE"]),
      ["CALL", "PUT", "DIGITEVEN"],
    );
  });

  it("uses the normal digit pair in normal mode and the recovery pair in recovery", () => {
    const normal = familySpecsFor({ settings: { ...settings, preferredContractTypes: ["DIGITOVER", "DIGITUNDER"] }, mode: "NORMAL", digitEnabled: true });
    const recovery = familySpecsFor({ settings: { ...settings, preferredContractTypes: ["DIGITOVER", "DIGITUNDER"] }, mode: "RECOVERY", digitEnabled: true });
    assert.deepEqual(normal, [{ type: "DIGITOVER", barrier: 2 }, { type: "DIGITUNDER", barrier: 7 }]);
    assert.deepEqual(recovery, [{ type: "DIGITOVER", barrier: 4 }, { type: "DIGITUNDER", barrier: 5 }]);
  });

  it("omits digit families on markets without a digit tape", () => {
    const specs = familySpecsFor({ settings, mode: "NORMAL", digitEnabled: false });
    assert.deepEqual(specs.map((s) => s.type), ["CALL", "PUT"]);
  });

  it("Matches and Differs use the data-driven digit (barrier -1 means auto)", () => {
    const specs = familySpecsFor({
      settings: { ...settings, preferredContractTypes: ["DIGITMATCH", "DIGITDIFF"] },
      mode: "NORMAL",
      digitEnabled: true,
    });
    assert.deepEqual(specs, [{ type: "DIGITMATCH", barrier: -1 }, { type: "DIGITDIFF", barrier: -1 }]);
  });
});
