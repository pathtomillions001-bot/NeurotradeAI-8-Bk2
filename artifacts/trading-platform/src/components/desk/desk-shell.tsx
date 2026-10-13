/**
 * v5 Desk — the frame.
 *
 * Title bar 48 | workspace tabs 40 | work area (pad 12: context strip 60,
 * optional alert strip 32, gap 12, twelve-column panel grid) | status bar 28.
 * The shell owns the two things that must never disagree with each other:
 * the viewport size class (large ≥1280, medium ≥1024, small) that selects
 * the placement set from desk-layout, and the CSS custom properties the
 * stylesheet reads for row templates. Below 800px of viewport HEIGHT the
 * stylesheet itself switches the work area to scrolling rows with a 300px
 * floor — no JS involved, so the two cannot drift.
 *
 * The grid is the workspace's tabpanel: role/aria live here, once, instead of
 * in every panel.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import type { DeskAlert } from "@/lib/desk-ui";

import "./desk.css";

import { AlertStrip } from "./alert-strip";
import {
  GRID_ROWS,
  GRID_ROWS_MEDIUM_COMMAND,
  PLACEMENTS_LARGE,
  PLACEMENTS_MEDIUM,
  placementStyle,
  placementsSmall,
  rowCount,
  BANDS,
  type DeskTab,
  type PanelPlacement,
} from "./desk-layout";

export type DeskSize = "large" | "medium" | "small";

function sizeFromWidth(width: number): DeskSize {
  if (width >= BANDS.largeMinWidth) return "large";
  if (width >= BANDS.mediumMinWidth) return "medium";
  return "small";
}

/**
 * The viewport size class, from matchMedia (no resize-event churn, no layout
 * reads). Returns "large" during SSR/first paint in a non-browser context.
 */
export function useDeskSize(): DeskSize {
  const [size, setSize] = useState<DeskSize>(() =>
    typeof window === "undefined" ? "large" : sizeFromWidth(window.innerWidth),
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const queries = [
      { query: window.matchMedia(`(min-width: ${BANDS.largeMinWidth}px)`), size: "large" as const },
      { query: window.matchMedia(`(min-width: ${BANDS.mediumMinWidth}px)`), size: "medium" as const },
    ];
    const apply = () => {
      const large = queries[0].query.matches;
      if (large) {
        setSize("large");
        return;
      }
      setSize(queries[1].query.matches ? "medium" : "small");
    };
    apply();
    for (const entry of queries) entry.query.addEventListener("change", apply);
    return () => {
      for (const entry of queries) entry.query.removeEventListener("change", apply);
    };
  }, []);
  return size;
}

/** The placement set the shell renders for a tab at a size. */
export function placementsFor(tab: DeskTab, size: DeskSize): PanelPlacement[] {
  if (size === "large") return PLACEMENTS_LARGE[tab];
  if (size === "medium") return PLACEMENTS_MEDIUM[tab];
  return placementsSmall(tab);
}

export interface DeskShellProps {
  tab: DeskTab;
  /** The 48px title bar (title-bar.tsx). */
  titleBar: ReactNode;
  /** The 40px workspace tab bar (workspace-tabs.tsx). */
  tabs: ReactNode;
  /** The 60px context strip: pipeline on Command, stat strip elsewhere. */
  context?: ReactNode;
  /** Alert-strip content, most severe first; empty hides the strip entirely. */
  alerts?: DeskAlert[];
  /** Panels by their desk-layout id; a missing id renders an empty cell. */
  panels: Partial<Record<string, ReactNode>>;
  /** The 28px status bar (status-bar.tsx). */
  status: ReactNode;
  /** Forced size class — only for visual tests; production reads the viewport. */
  size?: DeskSize;
}

export function DeskShell({ tab, titleBar, tabs, context, alerts, panels, status, size: forcedSize }: DeskShellProps) {
  const measured = useDeskSize();
  const size = forcedSize ?? measured;
  const placements = placementsFor(tab, size);
  const rows = size === "medium" && tab === "command" ? GRID_ROWS_MEDIUM_COMMAND : GRID_ROWS[tab];
  const rowsCount = rowCount(tab, size);

  return (
    <div className="desk-root h-full min-h-0">
      <div className="desk-frame" data-desk-size={size}>
        {titleBar}
        {tabs}
        <div className="desk-work desk-scroll">
          <div
            className="desk-workspace"
            role="tabpanel"
            id={`desk-workspace-${tab}`}
            aria-labelledby={`desk-tab-${tab}`}
            tabIndex={-1}
            data-workspace={tab}
          >
            {context ? <div className="desk-context">{context}</div> : null}
            {alerts && alerts.length > 0 ? <AlertStrip alerts={alerts} /> : null}
            <div
              className="desk-grid"
              style={
                {
                  "--desk-rows": rows,
                  "--desk-row-count": String(rowsCount),
                } as CSSProperties
              }
            >
              {placements.map((placement) => (
                <div key={placement.id} className="desk-cell" style={placementStyle(placement)} data-cell={placement.id}>
                  {panels[placement.id] ?? null}
                </div>
              ))}
            </div>
          </div>
        </div>
        {status}
      </div>
    </div>
  );
}
