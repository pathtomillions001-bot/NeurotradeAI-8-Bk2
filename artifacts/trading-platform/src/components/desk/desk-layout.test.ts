/**
 * v5 Desk — the layout contract test.
 *
 * Pure, no DOM: it proves the claims the frame makes. A misaligned panel is a
 * defect this test catches before a browser ever renders it — the placements
 * must TILE each workspace grid exactly (every cell covered once, no overlaps,
 * every span inside 1–12), and the only heights tables may use are the
 * documented set (rows 28/29/30/32/34/36/40/44/48, header 24, sub-header 28,
 * footer 34).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BANDS,
  DESK_TABS,
  DESK_TAB_LABELS,
  DESK_THRESHOLDS,
  FOOTER_HEIGHT,
  GRID_ROWS,
  GRID_ROWS_MEDIUM_COMMAND,
  MEDIUM_COMMAND_ROW_COUNT,
  PLACEMENTS_LARGE,
  PLACEMENTS_MEDIUM,
  ROLLOUT_STAGES,
  SUB_HEADER_HEIGHT,
  TABLE_HEADER_HEIGHT,
  TABLE_ROW_HEIGHTS,
  TABLES,
  WORKSPACE_PANELS,
  placementStyle,
  placementsSmall,
  rowCount,
  type DeskTab,
  type PanelPlacement,
} from "./desk-layout";

/** Build the occupancy map of a workspace grid and assert it tiles exactly. */
function assertTiles(placements: PanelPlacement[], rows: number, label: string): void {
  const covered = new Map<string, string>();
  for (const p of placements) {
    assert.ok(p.cols[0] >= 1 && p.cols[1] <= 12, `${label}/${p.id}: columns must sit inside 1–12`);
    assert.ok(p.cols[0] <= p.cols[1], `${label}/${p.id}: column span inverted`);
    assert.ok(p.rows[0] >= 1 && p.rows[1] <= rows, `${label}/${p.id}: row span outside 1–${rows}`);
    assert.ok(p.rows[0] <= p.rows[1], `${label}/${p.id}: row span inverted`);
    for (let c = p.cols[0]; c <= p.cols[1]; c++) {
      for (let r = p.rows[0]; r <= p.rows[1]; r++) {
        const key = `${r}:${c}`;
        assert.equal(covered.has(key), false, `${label}: cell ${key} claimed by both ${covered.get(key)} and ${p.id} — panels must never overlap`);
        covered.set(key, p.id);
      }
    }
  }
  // No gaps: every cell of the 12 × rows area is claimed exactly once.
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= 12; c++) {
      assert.ok(covered.has(`${r}:${c}`), `${label}: cell ${r}:${c} is empty — the grid must have no gaps`);
    }
  }
  assert.equal(covered.size, 12 * rows, `${label}: coverage must equal the whole grid`);
  // Every workspace panel is placed exactly once.
  const ids = placements.map((p) => p.id).sort();
  assert.ok(ids.length === new Set(ids).size, `${label}: a panel is placed twice`);
}

test("T1 — the large layouts tile their grids exactly", () => {
  for (const tab of DESK_TABS) {
    assertTiles(PLACEMENTS_LARGE[tab], rowCount(tab, "large"), `large/${tab}`);
    // The placements must be exactly the workspace's panel list.
    assert.deepEqual(
      [...PLACEMENTS_LARGE[tab].map((p) => p.id)].sort(),
      [...WORKSPACE_PANELS[tab]].sort(),
      `large/${tab} must place every panel of the workspace`,
    );
  }
});

test("T2 — the medium (1024–1279px) layouts tile their grids exactly", () => {
  for (const tab of DESK_TABS) {
    assertTiles(PLACEMENTS_MEDIUM[tab], rowCount(tab, "medium"), `medium/${tab}`);
  }
  // Command specifically: three rows, Opportunities widened to 1–4, Decision 5–12.
  const command = PLACEMENTS_MEDIUM.command;
  assert.equal(rowCount("command", "medium"), MEDIUM_COMMAND_ROW_COUNT);
  assert.deepEqual(command.find((p) => p.id === "opportunities")?.cols, [1, 4]);
  assert.deepEqual(command.find((p) => p.id === "decision")?.cols, [5, 12]);
  assert.equal(GRID_ROWS_MEDIUM_COMMAND.split(" ").length, MEDIUM_COMMAND_ROW_COUNT);
});

test("T3 — the small (<1024px) stack is one panel per row, full width, in reading order", () => {
  for (const tab of DESK_TABS) {
    const small = placementsSmall(tab);
    assertTiles(small, rowCount(tab, "small"), `small/${tab}`);
    assert.deepEqual(small.map((p) => p.id), WORKSPACE_PANELS[tab], "small-screen order is the workspace's reading order");
    for (const p of small) assert.deepEqual(p.cols, [1, 12]);
  }
});

test("T4 — the documented reference placements are literally the brief's", () => {
  const at = (tab: DeskTab, id: string) => PLACEMENTS_LARGE[tab].find((p) => p.id === id);
  assert.deepEqual(at("command", "opportunities"), { id: "opportunities", cols: [1, 3], rows: [1, 2] });
  assert.deepEqual(at("command", "decision"), { id: "decision", cols: [4, 8], rows: [1, 1] });
  assert.deepEqual(at("command", "risk"), { id: "risk", cols: [9, 12], rows: [1, 1] });
  assert.deepEqual(at("command", "positions"), { id: "positions", cols: [4, 8], rows: [2, 2] });
  assert.deepEqual(at("command", "calendar"), { id: "calendar", cols: [9, 12], rows: [2, 2] });
  assert.deepEqual(at("markets", "universe"), { id: "universe", cols: [1, 4], rows: [1, 2] });
  assert.deepEqual(at("markets", "scanner"), { id: "scanner", cols: [5, 12], rows: [1, 1] });
  assert.deepEqual(at("markets", "autoselect"), { id: "autoselect", cols: [5, 8], rows: [2, 2] });
  assert.deepEqual(at("markets", "health"), { id: "health", cols: [9, 12], rows: [2, 2] });
  assert.deepEqual(at("learning", "governance"), { id: "governance", cols: [1, 6], rows: [1, 1] });
  assert.deepEqual(at("learning", "calibration"), { id: "calibration", cols: [7, 9], rows: [1, 1] });
  assert.deepEqual(at("learning", "week"), { id: "week", cols: [10, 12], rows: [1, 1] });
  assert.deepEqual(at("learning", "regime"), { id: "regime", cols: [1, 6], rows: [2, 2] });
  assert.deepEqual(at("learning", "refused"), { id: "refused", cols: [7, 9], rows: [2, 2] });
  assert.deepEqual(at("learning", "safety"), { id: "safety", cols: [10, 12], rows: [2, 2] });
  assert.deepEqual(at("learning", "learning-journal"), { id: "learning-journal", cols: [1, 12], rows: [3, 3] });
  assert.deepEqual(at("journal", "closed"), { id: "closed", cols: [1, 8], rows: [1, 2] });
  assert.deepEqual(at("journal", "by-symbol"), { id: "by-symbol", cols: [9, 12], rows: [1, 1] });
  assert.deepEqual(at("journal", "decision-journal"), { id: "decision-journal", cols: [9, 12], rows: [2, 2] });
});

test("T5 — table heights are only the documented ones", () => {
  const allowed = new Set<number>(TABLE_ROW_HEIGHTS);
  for (const [id, spec] of Object.entries(TABLES)) {
    assert.ok(allowed.has(spec.rowHeight), `table ${id}: row height ${spec.rowHeight} is not a documented height (${[...allowed].join(", ")})`);
    assert.ok(spec.columns.trim().length > 0, `table ${id}: needs a column template`);
    assert.match(spec.columns, /minmax\(0,1fr\)|fr|px/, `table ${id}: column template must be explicit`);
    // A flexible column must be min-clamped so long symbols cannot force
    // horizontal overflow inside a panel body.
    for (const part of spec.columns.split(/\s+(?![^(]*\))/)) {
      if (part.includes("fr") && !part.includes("px")) {
        assert.match(part, /minmax\(0,|^\d+(\.\d+)?fr$/, `table ${id}: flexible column "${part}" must be minmax(0,…) or a plain fr track`);
      }
    }
  }
  assert.equal(TABLE_HEADER_HEIGHT, 24);
  assert.equal(SUB_HEADER_HEIGHT, 28);
  assert.equal(FOOTER_HEIGHT, 34);
});

test("T6 — the frame bands are exactly the brief's numbers", () => {
  assert.equal(BANDS.titleBar, 48);
  assert.equal(BANDS.tabs, 40);
  assert.equal(BANDS.statusBar, 28);
  assert.equal(BANDS.workPad, 12);
  assert.equal(BANDS.contextStrip, 60);
  assert.equal(BANDS.alertStrip, 32);
  assert.equal(BANDS.gridGap, 12);
  assert.equal(BANDS.gridColumns, 12);
  assert.equal(BANDS.panelHeader, 36);
  assert.equal(BANDS.shortViewportHeight, 800);
  assert.equal(BANDS.shortRowMinHeight, 300);
  // Learning's rows are the reference's fr triple.
  assert.equal(GRID_ROWS.learning, "250fr 214fr 200fr");
  for (const tab of DESK_TABS) {
    const rows = GRID_ROWS[tab].split(" ").length;
    assert.equal(rows, rowCount(tab, "large"), `${tab}: the row template must match the placement row count`);
  }
});

test("T7 — placementStyle produces whole-column grid areas", () => {
  const style = placementStyle({ id: "x", cols: [4, 8], rows: [1, 1] });
  assert.equal(style.gridColumn, "4 / 9");
  assert.equal(style.gridRow, "1 / 2");
});

test("T8 — tabs, labels and the documented thresholds are consistent", () => {
  assert.deepEqual(DESK_TABS, ["command", "markets", "learning", "journal"]);
  for (const tab of DESK_TABS) assert.ok(DESK_TAB_LABELS[tab].length > 0);
  assert.equal(DESK_TAB_LABELS.journal, "Journal & performance");
  // The rollout stepper's "200" is the exported constant, never a literal.
  assert.equal(DESK_THRESHOLDS.rolloutDemoMinTrades, 200);
  assert.equal(DESK_THRESHOLDS.slippageMaxR, 0.15);
  assert.equal(DESK_THRESHOLDS.resumeReasonMinChars, 3);
  assert.deepEqual([...ROLLOUT_STAGES], ["Shadow", "Demo", "0.10%", "0.25%", "0.35%"]);
});
