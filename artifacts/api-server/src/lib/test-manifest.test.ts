/**
 * Test-manifest guard.
 *
 * WHY: `pnpm test` runs an EXPLICIT list of files. During the phase 1/2 work it
 * was discovered that four files existed on disk and passed, but were absent from
 * that list — including `autonomous-hedge/recovery-v2.test.ts`, the pin test for
 * the recovery pipeline. Every "the suite is green" claim made while it was
 * missing was therefore not evidence about that pipeline, and a real regression
 * sat undetected in it.
 *
 * The fix is mechanical: every `*.test.ts` in the project must appear in the
 * `test` script, and this test fails the suite the moment one does not.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", ".."); // src/lib -> project root

/** Files the `test` script actually executes. */
function listedTestFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts.test!.split(/\s+/).filter((token) => token.endsWith(".test.ts"));
}

/** Every `*.test.ts` that exists under src/. */
function testFilesOnDisk(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === "coverage") continue;
        walk(full);
      } else if (name.endsWith(".test.ts")) {
        found.push(relative(projectRoot, full));
      }
    }
  };
  walk(join(projectRoot, "src"));
  return found;
}

describe("test manifest", () => {
  it("runs every test file that exists in the project", () => {
    const listed = new Set(listedTestFiles());
    const missing = testFilesOnDisk().filter((f) => !listed.has(f));
    assert.deepEqual(
      missing,
      [],
      `These test files exist but are NOT run by \`pnpm test\`. Add them to the explicit list in package.json:\n  ${missing.join("\n  ")}`,
    );
  });

  it("does not list test files that no longer exist", () => {
    const onDisk = new Set(testFilesOnDisk());
    const ghosts = listedTestFiles().filter((f) => !onDisk.has(f));
    assert.deepEqual(ghosts, [], `\`pnpm test\` lists files that do not exist:\n  ${ghosts.join("\n  ")}`);
  });
});
