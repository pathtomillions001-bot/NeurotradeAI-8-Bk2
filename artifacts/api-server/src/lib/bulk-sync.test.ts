/**
 * The synchrony verdict is the part of the bulk feature most likely to be
 * quietly wrong — a batch that half-opened, or opened across two ticks, must
 * never be reported to the user as "5× executed together". These tests pin the
 * verdict to the broker's own data.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideLegSettlement, summarizeBulkSync, type BulkSyncLegInput } from "./bulk-sync.ts";

function leg(
  index: number,
  opts: { opened?: boolean; startedAtMs?: number; burst?: number; splitTick?: boolean; exitedAtMs?: number } = {},
): BulkSyncLegInput {
  return {
    opened: opts.opened ?? true,
    receipt: {
      index,
      startedAtMs: opts.startedAtMs ?? 1_700_000_000_000,
      confirmedAtMs: 1_700_000_000_100 + index,
      burst: opts.burst ?? 0,
      splitTick: opts.splitTick ?? false,
    },
    exitedAtMs: opts.exitedAtMs,
  };
}

describe("summarizeBulkSync", () => {
  it("calls a batch synchronized only when every leg shares Deriv's start time", () => {
    const report = summarizeBulkSync([leg(0), leg(1), leg(2), leg(3), leg(4)]);
    assert.equal(report.verdict, "synchronized");
    assert.equal(report.sameEntryTick, true);
    assert.equal(report.opened, 5);
    assert.deepEqual(report.entryTimesMs, [1_700_000_000_000]);
  });

  it("says split — never synchronized — when legs landed on different start times", () => {
    const report = summarizeBulkSync([
      leg(0),
      leg(1),
      leg(2, { startedAtMs: 1_700_000_002_000, burst: 1, splitTick: true }),
    ]);
    assert.equal(report.verdict, "split");
    assert.equal(report.sameEntryTick, false);
    assert.deepEqual(report.splitTickLegs, [2]);
    assert.match(report.summary, /did NOT all share one entry tick/);
  });

  it("reports partial when only some legs reached Deriv", () => {
    const report = summarizeBulkSync([
      leg(0),
      leg(1, { opened: false }),
      leg(2, { opened: false }),
    ]);
    assert.equal(report.verdict, "partial");
    assert.equal(report.opened, 1);
    assert.equal(report.sameEntryTick, null, "one leg is not a synchrony claim");
    assert.match(report.summary, /1\/3 legs opened/);
  });

  it("reports failed when nothing opened", () => {
    const report = summarizeBulkSync([
      leg(0, { opened: false }),
      leg(1, { opened: false }),
    ]);
    assert.equal(report.verdict, "failed");
    assert.equal(report.opened, 0);
    assert.match(report.summary, /No leg of the 2-leg batch reached Deriv/);
  });

  it("reports unverified when Deriv gave no start time — never a false success", () => {
    const report = summarizeBulkSync([
      leg(0, { startedAtMs: 0 }),
      leg(1, { startedAtMs: 0 }),
    ]);
    assert.equal(report.verdict, "unverified");
    assert.equal(report.sameEntryTick, null);
    assert.match(report.summary, /could not be verified/);
  });

  it("separates entry synchrony from exit synchrony", () => {
    const together = summarizeBulkSync([
      leg(0, { exitedAtMs: 1_700_000_030_000 }),
      leg(1, { exitedAtMs: 1_700_000_030_000 }),
    ]);
    assert.equal(together.verdict, "synchronized");
    assert.equal(together.sameExitTick, true);

    const closedApart = summarizeBulkSync([
      leg(0, { exitedAtMs: 1_700_000_030_000 }),
      leg(1, { exitedAtMs: 1_700_000_032_000 }),
    ]);
    // Same entry tick is still a sync; the differing close is surfaced too.
    assert.equal(closedApart.verdict, "synchronized");
    assert.equal(closedApart.sameExitTick, false);
    assert.match(closedApart.summary, /closed at different times/);
  });

  it("measures the local confirmation spread as a diagnostic", () => {
    const report = summarizeBulkSync([leg(0), leg(4)]);
    assert.equal(report.localConfirmSpreadMs, 4);
  });

  it("honours the confirmed count independently of opened legs", () => {
    const report = summarizeBulkSync([leg(0), leg(1)], { confirmed: 1 });
    assert.equal(report.opened, 2);
    assert.equal(report.confirmed, 1);
  });
});

describe("decideLegSettlement", () => {
  it("settles a confirmed leg with Deriv's exact profit", () => {
    const won = decideLegSettlement({
      opened: true, contractId: 42, buyPrice: 1, stake: 1,
      result: { won: true, profit: 1.43, entrySpot: 0, exitSpot: 0 },
    });
    assert.equal(won.status, "won");
    if (won.status !== "won") throw new Error("unreachable");
    assert.equal(won.profit, 1.43);
    assert.equal(won.payout, 2.43, "payout = stake + net profit");
    assert.equal(won.derivContractId, 42);

    const lost = decideLegSettlement({
      opened: true, contractId: 43, buyPrice: 1, stake: 1,
      result: { won: false, profit: -1, entrySpot: 1, exitSpot: 1 },
    });
    assert.equal(lost.status, "lost");
    if (lost.status !== "lost") throw new Error("unreachable");
    assert.equal(lost.payout, 0);
  });

  it("keeps a BOUGHT leg open (never error) when Deriv has not journalled it yet", () => {
    const pending = decideLegSettlement({
      opened: true, contractId: 77, buyPrice: 1, stake: 1,
      result: { won: false, profit: 0, missing: true },
    });
    assert.equal(pending.status, "open", "a live contract is never written off as an error");
    if (pending.status !== "open") throw new Error("unreachable");
    assert.equal(pending.derivContractId, 77, "the contract id is kept so it can be settled later");
    assert.match(pending.note, /settle automatically/);

    // No result object at all is the same situation.
    const noResult = decideLegSettlement({ opened: true, contractId: 78, buyPrice: 1, stake: 1 });
    assert.equal(noResult.status, "open");
  });

  it("writes error only when Deriv refused the leg or it never opened", () => {
    const refused = decideLegSettlement({
      opened: false,
      failureMessage: "Insufficient balance.",
      stake: 1,
    });
    assert.equal(refused.status, "error");
    if (refused.status !== "error") throw new Error("unreachable");
    assert.equal(refused.note, "Insufficient balance.");

    const unknown = decideLegSettlement({ opened: false, stake: 1 });
    assert.equal(unknown.status, "error");
    if (unknown.status !== "error") throw new Error("unreachable");
    assert.match(unknown.note, /never opened/);
  });
});
