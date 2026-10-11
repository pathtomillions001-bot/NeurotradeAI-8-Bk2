import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profitTablePageReachedWindow } from "./trade-reconciler";

/**
 * The walk-back contract behind the "settling previous 1-tick trade" deadlock.
 *
 * The reconciler's broker lookup used to be ONE newest-first page of 100
 * transactions. The account is shared with every bot, the FAB and manual
 * trades, so a stuck autonomous row was pushed out of that page and could never
 * be seen again — the page only moves forward, the row only gets older — which
 * left the row `open` and the autonomous engine gated forever.
 *
 * Paging walks backwards in time; the loop may only stop early when a page has
 * genuinely reached past the row's own era.
 */
describe("profit table walk-back", () => {
  const tx = (at: number) => ({ purchase_time: at, sell_time: at + 1 });
  const DATE_FROM = 1_000_000;

  it("keeps paging while the page is still newer than the window", () => {
    assert.equal(
      profitTablePageReachedWindow([tx(DATE_FROM + 500), tx(DATE_FROM + 50), tx(DATE_FROM + 10)], DATE_FROM),
      false,
      "a page that is entirely newer than the row must not end the walk-back",
    );
  });

  it("stops as soon as the page reaches the row's era", () => {
    assert.equal(
      profitTablePageReachedWindow([tx(DATE_FROM + 500), tx(DATE_FROM - 1)], DATE_FROM),
      true,
    );
    assert.equal(profitTablePageReachedWindow([tx(DATE_FROM)], DATE_FROM), true);
  });

  it("stops on an empty page (the table is exhausted)", () => {
    assert.equal(profitTablePageReachedWindow([], DATE_FROM), true);
  });

  it("falls back to the sell time when a transaction carries no purchase time", () => {
    assert.equal(profitTablePageReachedWindow([{ sell_time: DATE_FROM - 5 }], DATE_FROM), true);
    assert.equal(profitTablePageReachedWindow([{ sell_time: DATE_FROM + 5 }], DATE_FROM), false);
  });

  it("keeps paging when no page entry carries a usable timestamp", () => {
    assert.equal(
      profitTablePageReachedWindow([{ purchase_time: 0 }, {}], DATE_FROM),
      false,
      "an unparsable page must not be mistaken for 'we reached the row'",
    );
  });
});
