import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OMNI_CONTRACTS, omniConfigError, type OmniConfig } from "./omni";
import { openPathForBot, stopPathForBot } from "./live-bots";

const config: OmniConfig = {
  enabledContracts: ["DIGITOVER", "DIGITUNDER", "DIGITMATCH"],
  stake: 1,
  stopLoss: 10,
  takeProfit: 10,
  marketMode: "switching",
  executionMode: "live",
};

describe("Omni console controls", () => {
  it("offers eight independently selectable contract types, not an implicit recovery override", () => {
    assert.deepEqual(
      OMNI_CONTRACTS.map((c) => c.id).sort(),
      [
        "CALL",
        "PUT",
        "DIGITEVEN",
        "DIGITODD",
        "DIGITMATCH",
        "DIGITDIFF",
        "DIGITOVER",
        "DIGITUNDER",
      ].sort(),
    );
    assert.equal(new Set(OMNI_CONTRACTS.map((c) => c.id)).size, 8);
    assert.equal(omniConfigError(config), null);
    for (const c of OMNI_CONTRACTS)
      assert.equal(
        omniConfigError({ ...config, enabledContracts: [c.id] }),
        null,
      );
  });
  it("prevents empty contract selections and invalid monetary inputs", () => {
    assert.ok(omniConfigError({ ...config, enabledContracts: [] }));
    for (const stake of [0, -1, 0.34, 0.355, NaN, Infinity])
      assert.ok(omniConfigError({ ...config, stake }));
    assert.ok(omniConfigError({ ...config, stopLoss: 0.5 }));
    assert.ok(omniConfigError({ ...config, takeProfit: 0 }));
    assert.ok(omniConfigError({ ...config, stopLoss: NaN }));
    assert.equal(
      omniConfigError({ ...config, stake: 0.35, stopLoss: 0.35 }),
      null,
    );
  });
  it("never accepts paper execution from a stale client configuration", () => {
    assert.equal(omniConfigError(config), null);
    assert.ok(
      omniConfigError({
        ...config,
        executionMode: "paper",
      } as unknown as OmniConfig),
    );
  });
  it("opens and stops the dedicated engine from the global live indicator", () => {
    assert.equal(stopPathForBot("omni"), "/api/bots/omni/stop");
    assert.equal(openPathForBot("omni"), "/bots?open=omni");
  });
});
