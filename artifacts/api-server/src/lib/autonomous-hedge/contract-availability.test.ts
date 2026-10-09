import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  clearQuarantine,
  filterQuarantined,
  hasTradeableContract,
  inferQuarantineScope,
  quarantineReasonFor,
  rememberQuarantined,
  summarizeQuarantine,
} from "./contract-availability";

function quarantine(sessionId: string, input: Parameters<typeof rememberQuarantined>[1]) {
  return rememberQuarantined(sessionId, { code: "", reason: "Unknown contract proposal", kind: "contract-unavailable", ...input });
}

describe("capability-rejection scope inference", () => {
  it("quarantines only the exact combination when both probes quote fine", () => {
    assert.equal(
      inferQuarantineScope({ sameContractOtherMarket: "ok", sameMarketOtherContract: "ok" }),
      "candidate",
    );
  });

  it("widens to the family when the same contract fails on another market", () => {
    assert.equal(
      inferQuarantineScope({ sameContractOtherMarket: "rejected", sameMarketOtherContract: "ok" }),
      "family",
    );
  });

  it("widens to the market when another contract fails on the same market", () => {
    assert.equal(
      inferQuarantineScope({ sameContractOtherMarket: "ok", sameMarketOtherContract: "rejected" }),
      "market",
    );
  });

  it("widens to the whole account when both probes are rejected", () => {
    assert.equal(
      inferQuarantineScope({ sameContractOtherMarket: "rejected", sameMarketOtherContract: "rejected" }),
      "account",
    );
  });

  it("never widens on an unanswered probe — a transport hiccup is not a capability verdict", () => {
    assert.equal(
      inferQuarantineScope({ sameContractOtherMarket: "unknown", sameMarketOtherContract: "unknown" }),
      "candidate",
    );
    assert.equal(
      inferQuarantineScope({ sameContractOtherMarket: "unknown", sameMarketOtherContract: "rejected" }),
      "market",
    );
  });
});

describe("quarantine store", () => {
  it("candidate scope blocks the contract on that market only", () => {
    const sessionId = randomUUID();
    clearQuarantine(sessionId);
    quarantine(sessionId, { scope: "candidate", symbol: "R_100", contract: "DIGITOVER" });

    assert.ok(quarantineReasonFor(sessionId, { symbol: "R_100", contract: "DIGITOVER" }));
    assert.equal(quarantineReasonFor(sessionId, { symbol: "R_50", contract: "DIGITOVER" }), null);
    assert.equal(quarantineReasonFor(sessionId, { symbol: "R_100", contract: "DIGITEVEN" }), null);
  });

  it("ignores the barrier: one rejected digit blocks the family on that market", () => {
    const sessionId = randomUUID();
    clearQuarantine(sessionId);
    quarantine(sessionId, { scope: "candidate", symbol: "R_100", contract: "DIGITOVER" });

    const rows = [
      { symbol: "R_100", contract: "DIGITOVER", barrier: 3 },
      { symbol: "R_100", contract: "DIGITOVER", barrier: 4 },
      { symbol: "R_100", contract: "DIGITUNDER", barrier: 5 },
    ];
    assert.deepEqual(
      filterQuarantined(sessionId, rows).map((r) => `${r.contract}:${r.barrier}`),
      ["DIGITUNDER:5"],
    );
  });

  it("family scope blocks the contract on every market", () => {
    const sessionId = randomUUID();
    clearQuarantine(sessionId);
    quarantine(sessionId, { scope: "family", symbol: "R_100", contract: "DIGITMATCH" });

    assert.ok(quarantineReasonFor(sessionId, { symbol: "1HZ100V", contract: "DIGITMATCH" }));
    assert.equal(quarantineReasonFor(sessionId, { symbol: "1HZ100V", contract: "DIGITDIFF" }), null);
  });

  it("account scope blocks everything and says so in the summary", () => {
    const sessionId = randomUUID();
    clearQuarantine(sessionId);
    quarantine(sessionId, {
      scope: "account", symbol: "R_100", contract: "DIGITOVER",
      code: "UnknownContract", reason: "Unknown contract proposal",
    });

    assert.ok(quarantineReasonFor(sessionId, { symbol: "JD50", contract: "CALL" }));
    assert.deepEqual(summarizeQuarantine(sessionId), [
      "every selected contract: Unknown contract proposal (Deriv code UnknownContract)",
    ]);
  });

  it("hasTradeableContract is false only when the whole selection is covered", () => {
    const sessionId = randomUUID();
    clearQuarantine(sessionId);
    const selection = { symbols: ["R_100", "R_50"], contracts: ["DIGITOVER", "DIGITEVEN"] };
    assert.equal(hasTradeableContract(sessionId, selection), true);

    quarantine(sessionId, { scope: "family", symbol: "R_100", contract: "DIGITOVER" });
    quarantine(sessionId, { scope: "family", symbol: "R_100", contract: "DIGITEVEN" });
    assert.equal(
      hasTradeableContract(sessionId, selection),
      false,
      "both families quarantined on both markets — nothing left to trade",
    );

    clearQuarantine(sessionId);
    quarantine(sessionId, { scope: "candidate", symbol: "R_100", contract: "DIGITOVER" });
    assert.equal(hasTradeableContract(sessionId, selection), true, "DIGITOVER still trades on R_50");
  });

  it("an empty selection is never reported as nothing left", () => {
    const sessionId = randomUUID();
    clearQuarantine(sessionId);
    quarantine(sessionId, { scope: "account", symbol: "R_100", contract: "CALL" });
    assert.equal(hasTradeableContract(sessionId, { symbols: [], contracts: ["CALL"] }), true);
    assert.equal(hasTradeableContract(sessionId, { symbols: ["R_100"], contracts: [] }), true);
  });

  it("does not duplicate an entry that already covers the combination", () => {
    const sessionId = randomUUID();
    clearQuarantine(sessionId);
    quarantine(sessionId, { scope: "family", symbol: "R_100", contract: "DIGITOVER" });
    quarantine(sessionId, { scope: "family", symbol: "R_50", contract: "DIGITOVER" });
    assert.equal(summarizeQuarantine(sessionId).length, 1);
  });

  it("clearQuarantine releases everything for one session only", () => {
    const a = randomUUID();
    const b = randomUUID();
    quarantine(a, { scope: "account", symbol: "R_100", contract: "CALL" });
    quarantine(b, { scope: "account", symbol: "R_100", contract: "CALL" });
    clearQuarantine(a);
    assert.equal(quarantineReasonFor(a, { symbol: "R_100", contract: "CALL" }), null);
    assert.ok(quarantineReasonFor(b, { symbol: "R_100", contract: "CALL" }));
  });
});
