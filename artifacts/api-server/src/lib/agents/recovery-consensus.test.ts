import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { windowsChooseSameDigit } from "./recovery-consensus.ts";

describe("recovery exact-contract consensus", () => {
  it("requires the same non-null barrier in every analysis window", () => {
    assert.equal(windowsChooseSameDigit([7, 7, 7]), true);
    assert.equal(windowsChooseSameDigit([7, 8, 7]), false);
    assert.equal(windowsChooseSameDigit([null, 7, 7]), false);
    assert.equal(windowsChooseSameDigit([7, 7, null]), false);
    assert.equal(windowsChooseSameDigit([]), false);
  });
});
