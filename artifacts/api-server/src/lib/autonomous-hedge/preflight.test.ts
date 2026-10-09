import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  preflightRefusalMessage,
  runAutonomousPreflight,
  selectedFamilies,
  shouldRefuseStart,
  type ProbeFn,
} from "./preflight";
import { clearQuarantine, quarantineReasonFor } from "./contract-availability";
import type { ContractProbe } from "../deriv";

const SETTINGS = {
  preferredContractTypes: ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"],
  normalOverDigit: 2,
  normalUnderDigit: 7,
  recoveryOverDigit: 4,
  recoveryUnderDigit: 5,
};

const MARKETS = [
  { symbol: "R_100", digitEnabled: true },
  { symbol: "R_50", digitEnabled: true },
  { symbol: "1HZ100V", digitEnabled: true },
  { symbol: "JD50", digitEnabled: true },
];

const ok: ContractProbe = { ok: true, code: "", message: "", kind: "unknown", askPrice: 0.35, payout: 0.95 };
const unknownContract: ContractProbe = {
  ok: false, code: "UnknownContract", message: "Unknown contract proposal", kind: "contract-unavailable",
};
const throttled: ContractProbe = {
  ok: false, code: "RateLimit", message: "Rate limit exceeded, try again", kind: "transient",
};

function probeWith(answer: ContractProbe | ((contractType: string) => ContractProbe)): ProbeFn {
  return async (_token, _accountId, params) =>
    typeof answer === "function" ? answer(params.contractType) : answer;
}

function args(sessionId: string, probe: ProbeFn, markets = MARKETS) {
  return {
    sessionId,
    token: "bearer-token",
    accountId: "CR1234567",
    currency: "USD",
    markets,
    settings: SETTINGS,
    probe,
  };
}

describe("autonomous pre-flight", () => {
  it("lists every family the user selected, in canonical order", () => {
    assert.deepEqual(selectedFamilies(SETTINGS), [
      "CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD",
    ]);
  });

  it("quotes each selected family on a different market", async () => {
    const seen: string[] = [];
    const result = await runAutonomousPreflight(args(randomUUID(), async (_t, _a, params) => {
      seen.push(`${params.contractType}@${params.symbol}`);
      return ok;
    }));

    assert.equal(result.ran, true);
    assert.equal(result.quotable.length, 6);
    assert.equal(result.blocked.length, 0);
    assert.equal(shouldRefuseStart(result), false);
    assert.equal(new Set(seen.map((s) => s.split("@")[1])).size, 4, "spread over the watched markets");
    assert.deepEqual(seen, [
      "CALL@R_100", "PUT@R_50", "DIGITOVER@1HZ100V", "DIGITUNDER@JD50", "DIGITEVEN@R_100", "DIGITODD@R_100",
    ], "families rotate across the watched markets");
  });

  it("sends a valid barrier per family and a 1-tick duration", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await runAutonomousPreflight(args(randomUUID(), async (_t, _a, params) => {
      sent.push(params as unknown as Record<string, unknown>);
      return ok;
    }));

    const over = sent.find((p) => p.contractType === "DIGITOVER");
    const rise = sent.find((p) => p.contractType === "CALL");
    assert.equal(over?.barrier, 4);
    assert.equal(over?.duration, 1);
    assert.equal(over?.durationUnit, "t");
    assert.equal(over?.currency, "USD");
    assert.equal(rise?.barrier, null, "Rise/Fall carry no barrier");
  });

  it("quarantines a family the account cannot quote and keeps trading the rest", async () => {
    const sessionId = randomUUID();
    const result = await runAutonomousPreflight(
      args(sessionId, probeWith((type) => (type === "DIGITOVER" ? unknownContract : ok))),
    );

    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0]!.contract, "DIGITOVER");
    assert.equal(result.blocked[0]!.code, "UnknownContract");
    assert.equal(result.quotable.length, 5);
    assert.equal(shouldRefuseStart(result), false, "five families still trade — the engine must start");
    // The rejected combination is quarantined on the market it was refused on,
    // so the ranker cannot pick it there again and the broker is never asked
    // twice for the same impossible quote. One market's verdict deliberately
    // does not silence the family everywhere — the cycle's own follow-up probes
    // widen the scope when the evidence supports it.
    const blockedOn = result.blocked[0]!.symbol;
    assert.ok(quarantineReasonFor(sessionId, { symbol: blockedOn, contract: "DIGITOVER" }));
    assert.equal(quarantineReasonFor(sessionId, { symbol: blockedOn, contract: "DIGITEVEN" }), null);
  });

  it("refuses a start only when nothing selected is quotable", async () => {
    const result = await runAutonomousPreflight(args(randomUUID(), probeWith(unknownContract)));

    assert.equal(result.quotable.length, 0);
    assert.equal(result.blocked.length, 6);
    assert.equal(result.marketsProbed, 4, "the verdicts span every watched market");
    assert.equal(shouldRefuseStart(result), true);
    assert.match(preflightRefusalMessage(result), /Unknown contract proposal/);
    assert.match(preflightRefusalMessage(result), /Deriv code UnknownContract/);
  });

  it("never refuses a start because Deriv was throttling", async () => {
    const result = await runAutonomousPreflight(args(randomUUID(), probeWith(throttled)));

    assert.equal(result.blocked.length, 0, "a throttle is not a capability verdict");
    assert.equal(result.inconclusive.length, 6);
    assert.equal(shouldRefuseStart(result), false);
  });

  it("does not run at all without a connected account (paper mode)", async () => {
    const result = await runAutonomousPreflight({ ...args(randomUUID(), probeWith(ok)), token: null, accountId: null });
    assert.equal(result.ran, false);
    assert.equal(shouldRefuseStart(result), false);
  });

  it("skips digit families on markets that offer no digits", async () => {
    const sessionId = randomUUID();
    clearQuarantine(sessionId);
    const seen: string[] = [];
    const result = await runAutonomousPreflight(args(sessionId, async (_t, _a, params) => {
      seen.push(`${params.contractType}@${params.symbol}`);
      return ok;
    }, [{ symbol: "frxEURUSD", digitEnabled: false }, { symbol: "R_100", digitEnabled: true }]));

    assert.equal(result.quotable.length, 6);
    assert.ok(seen.includes("CALL@frxEURUSD"), "direction contracts need no digits");
    assert.ok(seen.some((s) => s.startsWith("DIGITOVER@R_100")), "digit contracts need a digit market");
    assert.ok(!seen.some((s) => s.startsWith("DIGITOVER@frxEURUSD")), "no digit quote on a market without digits");
  });

  it("re-verifies on every start: a previous start's verdicts are dropped", async () => {
    const sessionId = randomUUID();
    const first = await runAutonomousPreflight(
      args(sessionId, probeWith((type) => (type === "DIGITOVER" ? unknownContract : ok))),
    );
    const blockedOn = first.blocked[0]!.symbol;
    assert.ok(quarantineReasonFor(sessionId, { symbol: blockedOn, contract: "DIGITOVER" }));

    // The account may have gained market access since; ask again.
    const second = await runAutonomousPreflight(args(sessionId, probeWith(ok)));
    assert.equal(second.blocked.length, 0);
    assert.equal(quarantineReasonFor(sessionId, { symbol: blockedOn, contract: "DIGITOVER" }), null);
    assert.equal(first.blocked.length, 1);
  });
});
