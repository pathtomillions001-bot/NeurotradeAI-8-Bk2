import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { familySpecsFor, normalizePreferredTypes } from "./families";
import {
  cleanContractSpec,
  contractSetFor,
  legacyBarriersFrom,
  parseContractSpecs,
  preferredTypesFromSets,
  resolveContractSets,
  validateContractSet,
} from "./contract-sets";

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

  it("legacy derivation: the normal digit pair in normal mode and the recovery pair in recovery", () => {
    const only = { ...settings, preferredContractTypes: ["DIGITOVER", "DIGITUNDER"] };
    assert.deepEqual(
      familySpecsFor({ settings: only, mode: "NORMAL", digitEnabled: true }),
      [{ type: "DIGITOVER", barrier: 2 }, { type: "DIGITUNDER", barrier: 7 }],
    );
    assert.deepEqual(
      familySpecsFor({ settings: only, mode: "RECOVERY", digitEnabled: true }),
      [{ type: "DIGITOVER", barrier: 4 }, { type: "DIGITUNDER", barrier: 5 }],
    );
  });

  it("omits digit families on markets without a digit tape", () => {
    const specs = familySpecsFor({ settings, mode: "NORMAL", digitEnabled: false });
    assert.deepEqual(specs.map((s) => s.type), ["CALL", "PUT"]);
  });

  it("legacy Matches and Differs use the data-driven digit (barrier -1 means auto)", () => {
    const specs = familySpecsFor({
      settings: { ...settings, preferredContractTypes: ["DIGITMATCH", "DIGITDIFF"] },
      mode: "NORMAL",
      digitEnabled: true,
    });
    assert.deepEqual(specs, [{ type: "DIGITMATCH", barrier: -1 }, { type: "DIGITDIFF", barrier: -1 }]);
  });

  it("uses the chosen normal and recovery sets independently — Even normally, Matches in recovery", () => {
    const sets = resolveContractSets({
      normal: "DIGITEVEN:-1",
      recovery: "DIGITMATCH:3,DIGITMATCH:-1",
      legacy: settings,
    });
    assert.deepEqual(
      familySpecsFor({ settings, mode: "NORMAL", digitEnabled: true, sets }),
      [{ type: "DIGITEVEN", barrier: -1 }],
    );
    assert.deepEqual(
      familySpecsFor({ settings, mode: "RECOVERY", digitEnabled: true, sets }),
      [{ type: "DIGITMATCH", barrier: -1 }, { type: "DIGITMATCH", barrier: 3 }],
    );
  });

  it("a chosen set's per-contract digits replace the legacy barrier columns", () => {
    const sets = resolveContractSets({ normal: "DIGITOVER:6", recovery: "DIGITUNDER:9", legacy: settings });
    assert.deepEqual(familySpecsFor({ settings, mode: "NORMAL", digitEnabled: true, sets }), [{ type: "DIGITOVER", barrier: 6 }]);
    assert.deepEqual(familySpecsFor({ settings, mode: "RECOVERY", digitEnabled: true, sets }), [{ type: "DIGITUNDER", barrier: 9 }]);
  });

  it("validates a client set: 1–8 entries, legal digits, no duplicates", () => {
    assert.ok("error" in validateContractSet([], "normal"));
    assert.ok("error" in validateContractSet(Array.from({ length: 9 }, (_, i) => `DIGITMATCH:${i % 10}`), "recovery"));
    assert.ok("error" in validateContractSet(["DIGITOVER:9"], "normal"));
    assert.ok("error" in validateContractSet(["DIGITUNDER:0"], "normal"));
    assert.ok("error" in validateContractSet(["DIGITOVER:2", "DIGITOVER:2"], "normal"));
    assert.ok("error" in validateContractSet(["BOGUS:1"], "normal"));
    const ok = validateContractSet(["RISE:-1", "DIGITMATCH:-1", "DIGITOVER:0"], "normal");
    assert.ok(!("error" in ok));
    if (!("error" in ok)) assert.deepEqual(ok.specs.map((s) => s.type), ["CALL", "DIGITOVER", "DIGITMATCH"]);
  });

  it("cleanContractSpec forces −1 on digit-less types and rejects out-of-range digits", () => {
    assert.deepEqual(cleanContractSpec("DIGITEVEN", 5), { type: "DIGITEVEN", digit: -1 });
    assert.equal(cleanContractSpec("DIGITOVER", 9), null);
    assert.equal(cleanContractSpec("DIGITUNDER", 0), null);
    assert.deepEqual(cleanContractSpec("DIGITDIFF", -1), { type: "DIGITDIFF", digit: -1 });
  });

  it("the stored text round-trips and tolerates junk, and the union feeds preferredContractTypes", () => {
    const parsed = parseContractSpecs("DIGITMATCH:-1, RISE:-1, junk, DIGITMATCH:-1");
    assert.deepEqual(parsed, [{ type: "CALL", digit: -1 }, { type: "DIGITMATCH", digit: -1 }]);
    const sets = resolveContractSets({ normal: "DIGITOVER:6,CALL:-1", recovery: "DIGITMATCH:-1", legacy: settings });
    assert.deepEqual(preferredTypesFromSets(sets), ["CALL", "DIGITOVER", "DIGITMATCH"]);
    assert.deepEqual(legacyBarriersFrom(contractSetFor(sets, "NORMAL")), { over: 6, under: undefined });
  });
});
