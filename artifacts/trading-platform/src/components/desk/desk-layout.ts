/**
 * v5 Desk — the layout contract, in ONE place.
 *
 * Every band height, row height, grid placement and table column template the
 * Desk renders is defined here, and components READ from this module instead
 * of choosing their own numbers. That is what keeps panels from drifting: a
 * misalignment is a diff in this file, not a mystery spread across twenty
 * components.
 *
 * The pure test beside this file (desk-layout.test.ts) proves the placements
 * tile each workspace grid exactly — no overlap, no gap, every span inside
 * 1–12 — and that every table height is one of the documented set.
 *
 * This module must stay free of React (and of any import) so the test can run
 * under `tsx --test` without a DOM.
 */

// ── workspaces ──────────────────────────────────────────────────────────────

export type DeskTab = "command" | "markets" | "learning" | "journal";

export const DESK_TABS: DeskTab[] = ["command", "markets", "learning", "journal"];

export const DESK_TAB_LABELS: Record<DeskTab, string> = {
  command: "Command",
  markets: "Markets",
  learning: "Learning",
  journal: "Journal & performance",
};

/** The panel ids of each workspace, in reading order (also the small-screen stack order). */
export const WORKSPACE_PANELS: Record<DeskTab, string[]> = {
  command: ["opportunities", "decision", "risk", "positions", "calendar"],
  markets: ["universe", "scanner", "autoselect", "health"],
  learning: ["governance", "calibration", "week", "regime", "refused", "safety", "learning-journal"],
  journal: ["closed", "by-symbol", "decision-journal"],
};

// ── the frame (exact band heights) ─────────────────────────────────────────

export const BANDS = {
  /** Title bar: chips, key numbers, mode/timezone/auto, MT5, Flatten. */
  titleBar: 48,
  /** Workspace tabs. */
  tabs: 40,
  /** Status bar. */
  statusBar: 28,
  /** Work-area padding on every side. */
  workPad: 12,
  /** Context strip (pipeline on Command, stat strip elsewhere). */
  contextStrip: 60,
  /** Optional alert strip; when present the grid shrinks, never overlaps. */
  alertStrip: 32,
  /** Column and row gap of the panel grid. */
  gridGap: 12,
  /** The panel grid is always twelve columns. */
  gridColumns: 12,
  /** Panel header, exactly. */
  panelHeader: 36,
  /** Filter-chip rows (Opportunities, universe class chips). */
  chipRow: 36,
  /** Universe search row. */
  searchRow: 44,
  /** Sub-headers inside a panel body. */
  subHeader: 28,
  /** Table header row. */
  tableHeader: 24,
  /** Panel footers (totals). */
  footer: 34,
  /** Decision panel's top block (price + verdict). */
  decisionTop: 70,
  /** Decision panel's footer (entry/stop/targets/size + Arm). */
  decisionFooter: 62,
  /** Calendar's amber blackout line. */
  calendarBlackout: 34,
  /** Panel radius; badges/buttons 4; filter chips 11. */
  radiusPanel: 6,
  radiusBadge: 4,
  radiusChip: 11,
  /** Breakpoints. */
  mediumMinWidth: 1024,
  largeMinWidth: 1280,
  /** Below this VIEWPORT HEIGHT the work area scrolls and rows get a floor. */
  shortViewportHeight: 800,
  shortRowMinHeight: 300,
} as const;

/** Grid row templates per workspace (fr units, filling the viewport). */
export const GRID_ROWS: Record<DeskTab, string> = {
  command: "1fr 1fr",
  markets: "1fr 1fr",
  learning: "250fr 214fr 200fr",
  journal: "1fr 1fr",
};

/** Command's three-row template between 1024 and 1279px. */
export const GRID_ROWS_MEDIUM_COMMAND = "1fr 1fr 1fr";

// ── placements ──────────────────────────────────────────────────────────────

export interface PanelPlacement {
  id: string;
  /** Inclusive 1-based grid columns. */
  cols: [number, number];
  /** Inclusive 1-based grid rows. */
  rows: [number, number];
}

/** CSS grid-area values for a placement (rows count is implicit). */
export function placementStyle(p: PanelPlacement): { gridColumn: string; gridRow: string } {
  return {
    gridColumn: `${p.cols[0]} / ${p.cols[1] + 1}`,
    gridRow: `${p.rows[0]} / ${p.rows[1] + 1}`,
  };
}

/**
 * ≥1280px — the reference layouts, exactly.
 * Command: Opportunities 1–3 × rows 1–2 | Decision 4–8 r1 | Risk 9–12 r1 |
 *          Positions 4–8 r2 | Calendar 9–12 r2.
 */
export const PLACEMENTS_LARGE: Record<DeskTab, PanelPlacement[]> = {
  command: [
    { id: "opportunities", cols: [1, 3], rows: [1, 2] },
    { id: "decision", cols: [4, 8], rows: [1, 1] },
    { id: "risk", cols: [9, 12], rows: [1, 1] },
    { id: "positions", cols: [4, 8], rows: [2, 2] },
    { id: "calendar", cols: [9, 12], rows: [2, 2] },
  ],
  markets: [
    { id: "universe", cols: [1, 4], rows: [1, 2] },
    { id: "scanner", cols: [5, 12], rows: [1, 1] },
    { id: "autoselect", cols: [5, 8], rows: [2, 2] },
    { id: "health", cols: [9, 12], rows: [2, 2] },
  ],
  learning: [
    { id: "governance", cols: [1, 6], rows: [1, 1] },
    { id: "calibration", cols: [7, 9], rows: [1, 1] },
    { id: "week", cols: [10, 12], rows: [1, 1] },
    { id: "regime", cols: [1, 6], rows: [2, 2] },
    { id: "refused", cols: [7, 9], rows: [2, 2] },
    { id: "safety", cols: [10, 12], rows: [2, 2] },
    { id: "learning-journal", cols: [1, 12], rows: [3, 3] },
  ],
  journal: [
    { id: "closed", cols: [1, 8], rows: [1, 2] },
    { id: "by-symbol", cols: [9, 12], rows: [1, 1] },
    { id: "decision-journal", cols: [9, 12], rows: [2, 2] },
  ],
};

/**
 * 1024–1279px — same grid, but Command's Opportunities widens to 1–4 and the
 * Decision takes 5–12; Risk & safety moves to row 2 beside Positions and the
 * calendar moves under Risk. The other workspaces already fit and are unchanged.
 */
export const PLACEMENTS_MEDIUM: Record<DeskTab, PanelPlacement[]> = {
  command: [
    { id: "opportunities", cols: [1, 4], rows: [1, 3] },
    { id: "decision", cols: [5, 12], rows: [1, 1] },
    { id: "risk", cols: [5, 8], rows: [2, 2] },
    { id: "positions", cols: [9, 12], rows: [2, 2] },
    { id: "calendar", cols: [5, 12], rows: [3, 3] },
  ],
  markets: PLACEMENTS_LARGE.markets,
  learning: PLACEMENTS_LARGE.learning,
  journal: PLACEMENTS_LARGE.journal,
};

export const MEDIUM_COMMAND_ROW_COUNT = 3;

/**
 * <1024px — single column: every panel spans all twelve columns and takes one
 * natural-height row, in the workspace's reading order.
 */
export function placementsSmall(tab: DeskTab): PanelPlacement[] {
  return WORKSPACE_PANELS[tab].map((id, index) => ({
    id,
    cols: [1, 12] as [number, number],
    rows: [index + 1, index + 1] as [number, number],
  }));
}

export function rowCount(tab: DeskTab, size: "large" | "medium" | "small"): number {
  if (size === "small") return WORKSPACE_PANELS[tab].length;
  if (size === "medium" && tab === "command") return MEDIUM_COMMAND_ROW_COUNT;
  return tab === "learning" ? 3 : 2;
}

// ── tables: ONE column template and ONE row height per table ───────────────

/**
 * The documented row-height set. A table picks exactly one row height and
 * applies it to every row; 24 is the table header, 28 the sub-header, 34 the
 * footer. Nothing in between exists.
 */
export const TABLE_ROW_HEIGHTS = [28, 29, 30, 32, 34, 36, 40, 44, 48] as const;
export const TABLE_HEADER_HEIGHT = 24;
export const SUB_HEADER_HEIGHT = 28;
export const FOOTER_HEIGHT = 34;

export interface TableSpec {
  /** CSS grid-template-columns, applied to the header AND every row. */
  columns: string;
  /** Row height in px — one of TABLE_ROW_HEIGHTS. */
  rowHeight: number;
}

export const TABLES = {
  opportunities: { columns: "8px minmax(0,1fr) 72px 64px", rowHeight: 48 },
  decisionGates: { columns: "14px minmax(0,1fr) 88px", rowHeight: 28 },
  risk: { columns: "minmax(0,1fr) 128px", rowHeight: 44 },
  positions: { columns: "minmax(0,1fr) 36px 36px 74px 74px 112px 70px", rowHeight: 36 },
  plans: { columns: "minmax(0,1fr) 36px 74px 74px 52px 62px 56px", rowHeight: 36 },
  calendar: { columns: "62px 36px minmax(0,1fr) 50px", rowHeight: 40 },
  universe: { columns: "20px minmax(0,1fr) 72px", rowHeight: 32 },
  scanner: { columns: "1.1fr 64px 36px 44px 40px 52px 62px 40px 46px 48px 1.7fr", rowHeight: 30 },
  autoSelect: { columns: "84px minmax(0,1fr) 62px 52px", rowHeight: 34 },
  governance: { columns: "132px 66px minmax(0,1fr) 54px 70px", rowHeight: 40 },
  calibration: { columns: "58px 30px minmax(0,1fr) 44px 68px", rowHeight: 28 },
  weekSymbols: { columns: "minmax(0,1fr) 40px 60px", rowHeight: 28 },
  regime: { columns: "70px minmax(0,1fr) 62px 52px 90px", rowHeight: 30 },
  refusals: { columns: "minmax(0,1fr) 70px 34px", rowHeight: 29 },
  learningJournal: { columns: "52px 76px 96px minmax(0,1fr)", rowHeight: 28 },
  closedTrades: { columns: "170px minmax(0,1fr) 54px 54px 110px 70px 70px", rowHeight: 34 },
  bySymbol: { columns: "minmax(0,1fr) 40px 44px 56px 36px", rowHeight: 28 },
  byAgent: { columns: "minmax(0,1fr) 40px 60px", rowHeight: 28 },
  decisionJournal: { columns: "52px 76px 96px minmax(0,1fr)", rowHeight: 44 },
} as const satisfies Record<string, TableSpec>;

export type TableId = keyof typeof TABLES;

// ── thresholds the UI prints that NO API supplies ──────────────────────────
//
// Everything else comes from the wire: gate thresholds from the gatekeeper's
// own `reasons`, policy limits from /state `policy`, e-value bars from
// `halveAt`/`disableAt`, minRrFill/minCostCoverage from /analysis
// `thresholds`. These five are documented rollout gates from the v4 brief
// (docs/mt5-live-desk-v4.md) that no endpoint exposes; they live in this ONE
// exported constant so a change is a single reviewable diff.

export const DESK_THRESHOLDS = {
  /** The rollout kill rule: mean slippage ≤ 0.15R. */
  slippageMaxR: 0.15,
  /** The documented demo→live gate: 200 measured trades. */
  rolloutDemoMinTrades: 200,
  /** A meter at or beyond this fraction of its limit reads "near a limit". */
  nearLimitFraction: 0.8,
  /** Regime break risk at or above this reads amber. */
  breakRiskWarnFraction: 0.3,
  /** A calibration bucket below this many trades shows "-", "n too small". */
  calibrationMinBucketTrades: 10,
  /** Resume-agent requires a reason of at least this many characters. */
  resumeReasonMinChars: 3,
} as const;

/** The rollout stepper's stages, in order. */
export const ROLLOUT_STAGES = ["Shadow", "Demo", "0.10%", "0.25%", "0.35%"] as const;
