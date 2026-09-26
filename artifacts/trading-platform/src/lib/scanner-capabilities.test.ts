import assert from "node:assert/strict";
import { test } from "node:test";
import { DIGIT45_SCANNER_PATH, hasCreateDbotScanner } from "./scanner-capabilities";

test("Scanner badge means this console really contains Create DBot", () => {
  assert.equal(hasCreateDbotScanner({ console: "overunder-turbo@2" }), true);
  for (const consoleId of ["omni@2", "overunder-navigator@1", "apex@1", "specialist@1", undefined]) {
    assert.equal(hasCreateDbotScanner({ console: consoleId }), false);
  }
  assert.equal(DIGIT45_SCANNER_PATH, "/scanners/digit-45");
});
