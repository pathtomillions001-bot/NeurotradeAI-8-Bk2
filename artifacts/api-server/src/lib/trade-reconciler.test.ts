import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, schemaReady, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  fetchAutonomousTransactions,
  profitTablePageReachedWindow,
  settleAutonomousRows,
  settleFromJournalBatch,
  type UnsettledRow,
} from "./trade-reconciler";
import { AUTONOMOUS_HEDGE_PREFIX } from "./autonomous-hedge/constants";

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

/**
 * The SECOND production hold bug ("HOLD: settling previous 1-tick trade …
 * waiting 4m32s" on a trade Deriv had already closed).
 *
 * The paged walk was all-or-nothing: one failed page (Deriv's account-wide
 * profit_table RateLimit trips on any back-to-back burst) threw away the pages
 * ALREADY fetched — including page 1, which is exactly where a seconds-old
 * settled 1-tick contract sits. The row then stayed `open`, the exposure gate
 * kept HOLDing, and the next sweep repeated the same burst. These tests pin
 * the properties that make that impossible.
 */
describe("autonomous profit-table walk", () => {
  const EARLIEST_MS = 1_000_000_000_000;
  const PURCHASE_SEC = Math.floor(EARLIEST_MS / 1000) + 10; // newer than the window start
  const row = (id: number, derivContractId: string | null): UnsettledRow => ({
    id,
    sessionId: "s",
    symbol: "JD25",
    contractType: "CALL",
    barrier: null,
    stake: "1",
    derivContractId,
    entryPayout: "1.9",
    agentReasoning: `${AUTONOMOUS_HEDGE_PREFIX}walk (test)`,
    createdAt: new Date(EARLIEST_MS),
  });
  const fullPage = (fromId: number) =>
    Array.from({ length: 500 }, (_, i) => ({ contract_id: fromId + i, purchase_time: PURCHASE_SEC }));

  it("a failed page never discards the pages already fetched", async () => {
    let calls = 0;
    const walk = await fetchAutonomousTransactions("t", "a", [row(1, "77")], EARLIEST_MS, {
      pageDelayMs: 0,
      fetchProfitTable: async () => {
        calls += 1;
        if (calls === 1) return fullPage(1000);
        throw new Error("profit_table unavailable: You have reached the rate limit.");
      },
    });
    assert.equal(calls, 2);
    assert.equal(walk.complete, false, "a cut-short walk must never claim 'no such trade'");
    assert.equal(walk.transactions.length, 500, "page 1 survives the page-2 failure — the settled contract on it can still settle");
  });

  it("stops early once every row has found its exact transaction", async () => {
    let calls = 0;
    const page = [...fullPage(2000).slice(0, 499), { contract_id: 77, purchase_time: PURCHASE_SEC }];
    const walk = await fetchAutonomousTransactions("t", "a", [row(1, "77")], EARLIEST_MS, {
      pageDelayMs: 0,
      fetchProfitTable: async () => {
        calls += 1;
        return page;
      },
    });
    assert.equal(calls, 1, "the common case costs one request — a stale row can no longer force the full walk");
    assert.equal(walk.complete, true);
    assert.equal(walk.transactions.length, 500);
  });

  it("a walk cut short by the page cap is not a complete lookup", async () => {
    let calls = 0;
    const walk = await fetchAutonomousTransactions("t", "a", [row(1, "never")], EARLIEST_MS, {
      pageDelayMs: 0,
      fetchProfitTable: async () => {
        calls += 1;
        return fullPage(3000);
      },
    });
    assert.equal(calls, 4);
    assert.equal(walk.complete, false);
  });

  it("an exhausted table is a complete lookup", async () => {
    const walk = await fetchAutonomousTransactions("t", "a", [row(1, "77")], EARLIEST_MS, {
      pageDelayMs: 0,
      fetchProfitTable: async () => [{ contract_id: 77, purchase_time: PURCHASE_SEC }],
    });
    assert.equal(walk.complete, true);
  });
});

/** Real-time settle path: the journal's batch is what "Deriv confirms" looks like. */
describe("real-time journal settle", () => {
  before(async () => {
    await schemaReady;
  });

  async function insertOpen(overrides: Record<string, unknown> = {}): Promise<number> {
    const [r] = await db.insert(tradesTable).values({
      sessionId: randomUUID(),
      symbol: "JD25",
      displayName: "Jump 25 Index",
      contractType: "CALL",
      stake: "1",
      direction: "up",
      status: "open",
      entryPayout: "1.9",
      derivContractId: "900",
      isAutonomous: true,
      agentReasoning: `${AUTONOMOUS_HEDGE_PREFIX}READY CALL on JD25 (test)`,
      ...overrides,
    } as any).returning({ id: tradesTable.id });
    return r.id;
  }

  it("settles a still-open autonomous row the moment the journal shows its settled contract", async () => {
    const id = await insertOpen();
    try {
      const settled = await settleFromJournalBatch("acct", [
        { contract_id: 900, buy_price: 1, sell_price: 1.9, purchase_time: 1, sell_time: 2 },
      ]);
      assert.equal(settled, 1);
      const [row] = await db.select().from(tradesTable).where(eq(tradesTable.id, id));
      assert.equal(row.status, "won");
      assert.equal(Number(row.profit), 0.9);
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.id, id));
    }
  });

  it("never settles from an unsettled payload and never fuzzy-matches a different contract", async () => {
    const id = await insertOpen({ derivContractId: "901" });
    try {
      const settled = await settleFromJournalBatch("acct", [
        { contract_id: 901, buy_price: 1 },
        { contract_id: 902, buy_price: 1, sell_price: 1.9, purchase_time: 1, sell_time: 2 },
      ]);
      assert.equal(settled, 0);
      const [row] = await db.select().from(tradesTable).where(eq(tradesTable.id, id));
      assert.equal(row.status, "open", "an unsettled or different contract must never settle the row");
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.id, id));
    }
  });

  it("records the outcome exactly once — the claim-unique writer blocks the second settle", async () => {
    const id = await insertOpen({ derivContractId: "903" });
    try {
      const batch = [{ contract_id: 903, buy_price: 1, sell_price: 0, purchase_time: 1, sell_time: 2 }];
      assert.equal(await settleFromJournalBatch("acct", batch), 1);
      assert.equal(await settleFromJournalBatch("acct", batch), 0, "the row is claimed once");
      const [row] = await db.select().from(tradesTable).where(eq(tradesTable.id, id));
      assert.equal(row.status, "lost");
      assert.equal(Number(row.profit), -1);
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.id, id));
    }
  });
});

describe("no-id release is gated on a complete lookup", () => {
  before(async () => {
    await schemaReady;
  });

  it("an incomplete lookup keeps the row open; only a complete one releases a ghost buy", async () => {
    const sessionId = randomUUID();
    const createdAt = new Date(Date.now() - 11 * 60 * 1000); // past the 10-minute grace
    const reasoning = `${AUTONOMOUS_HEDGE_PREFIX}unacknowledged buy (test)`;
    const [r] = await db.insert(tradesTable).values({
      sessionId,
      symbol: "JD25",
      displayName: "Jump 25 Index",
      contractType: "CALL",
      stake: "1",
      direction: "up",
      status: "open",
      entryPayout: "1.9",
      derivContractId: null,
      isAutonomous: true,
      agentReasoning: reasoning,
      createdAt,
    }).returning({ id: tradesTable.id });
    const row: UnsettledRow = {
      id: r.id,
      sessionId,
      symbol: "JD25",
      contractType: "CALL",
      barrier: null,
      stake: "1",
      derivContractId: null,
      entryPayout: "1.9",
      agentReasoning: reasoning,
      createdAt,
    };
    try {
      await settleAutonomousRows(sessionId, [row], [], 3, false);
      let [after] = await db.select().from(tradesTable).where(eq(tradesTable.id, r.id));
      assert.equal(after.status, "open", "an outage or cut-short walk must never be read as 'no such trade'");

      await settleAutonomousRows(sessionId, [row], [], 3, true);
      [after] = await db.select().from(tradesTable).where(eq(tradesTable.id, r.id));
      assert.equal(after.status, "error", "a complete lookup past the grace releases the ghost buy");
    } finally {
      await db.delete(tradesTable).where(eq(tradesTable.id, r.id));
    }
  });
});
