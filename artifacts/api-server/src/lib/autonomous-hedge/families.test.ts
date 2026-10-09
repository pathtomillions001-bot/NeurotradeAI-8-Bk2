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

describe("autonomous families — user-chosen sets per mode", () => {
  const base = { ...settings, preferredContractTypes: ["CALL"] };

  it("normal and recovery trade independent user sets (Even normal, Matches recovery)", () => {
    const withSets = {
      ...base,
      autonomousNormalContracts: [{ type: "DIGITEVEN", digit: -1 }],
      autonomousRecoveryContracts: [{ type: "DIGITMATCH", digit: -1 }],
    };
    assert.deepEqual(familySpecsFor({ settings: withSets, mode: "NORMAL", digitEnabled: true }),
      [{ type: "DIGITEVEN", barrier: -1 }]);
    assert.deepEqual(familySpecsFor({ settings: withSets, mode: "RECOVERY", digitEnabled: true }),
      [{ type: "DIGITMATCH", barrier: -1 }]);
  });

  it("each user entry keeps its own barrier, so two Overs can differ by digit", () => {
    const specs = familySpecsFor({
      settings: { ...base, autonomousNormalContracts: [{ type: "DIGITOVER", digit: 1 }, { type: "DIGITOVER", digit: 3 }] },
      mode: "NORMAL",
      digitEnabled: true,
    });
    assert.deepEqual(specs, [{ type: "DIGITOVER", barrier: 1 }, { type: "DIGITOVER", barrier: 3 }]);
  });

  it("drops out-of-range digits, duplicates and digit contracts on markets without a digit tape", () => {
    const set = [
      { type: "DIGITOVER", digit: 9 },   // Over 9 is impossible
      { type: "DIGITUNDER", digit: 0 },  // Under 0 is impossible
      { type: "DIGITEVEN", digit: -1 },
      { type: "DIGITEVEN", digit: 5 },   // duplicate of Even
      { type: "RISE", digit: -1 },       // maps to CALL
    ];
    assert.deepEqual(
      familySpecsFor({ settings: { ...base, autonomousNormalContracts: set }, mode: "NORMAL", digitEnabled: true }),
      [{ type: "DIGITEVEN", barrier: -1 }, { type: "CALL", barrier: -1 }],
    );
    assert.deepEqual(
      familySpecsFor({ settings: { ...base, autonomousNormalContracts: set }, mode: "NORMAL", digitEnabled: false }),
      [{ type: "CALL", barrier: -1 }],
    );
  });

  it("falls back to the legacy shared list when a mode's set is empty", () => {
    const legacy = familySpecsFor({
      settings: { ...base, preferredContractTypes: ["DIGITOVER"], autonomousRecoveryContracts: [] },
      mode: "RECOVERY",
      digitEnabled: true,
    });
    assert.deepEqual(legacy, [{ type: "DIGITOVER", barrier: 4 }]);
  });
});
