import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOT_CONSOLE_CONTRACT_VERSION } from "@workspace/deployment-contract";

import { botDeploymentIssue, shortCommit } from "./deployment-compatibility";

describe("bot deployment compatibility guard", () => {
  it("accepts matching browser/API console contracts", () => {
    assert.equal(
      botDeploymentIssue({
        botConsoleContract: BOT_CONSOLE_CONTRACT_VERSION,
        release: {
          commit: "abc",
          service: "api",
          botConsoleContract: BOT_CONSOLE_CONTRACT_VERSION,
        },
      }),
      null,
    );
  });

  it("rejects an old API that has no contract marker", () => {
    assert.match(botDeploymentIssue({}) ?? "", /older service release/i);
  });

  it("rejects a different specialist-console protocol", () => {
    assert.match(
      botDeploymentIssue({ botConsoleContract: "bot-console/old" }) ?? "",
      /mismatch/i,
    );
  });

  it("prints compact deployment commits", () => {
    assert.equal(
      shortCommit("1d7b39fcfc519f1d4b712865c3f830e4fc2fd6ea"),
      "1d7b39fcfc51",
    );
    assert.equal(shortCommit(undefined), "unknown");
  });
});
