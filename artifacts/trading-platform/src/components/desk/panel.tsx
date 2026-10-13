/**
 * v5 Desk — the panel frame.
 *
 * Every panel on every workspace is this component: a 36px header, a body
 * that is the ONLY scroller, and an optional 34px footer. Panels never choose
 * their own heights, borders or scroll behaviour — that is what keeps rows
 * aligned across the grid, and it means a misalignment is a diff in
 * desk.css / desk-layout.ts, not a mystery spread across twenty components.
 */
import type { ReactNode } from "react";

export interface PanelProps {
  /** The panel id from desk-layout's WORKSPACE_PANELS (used by tests and Playwright). */
  id: string;
  title: ReactNode;
  /** Right side of the header: counts, chips, small buttons. */
  right?: ReactNode;
  /** Optional 34px footer (totals, aggregate lines). */
  footer?: ReactNode;
  /** The Decision panel's cyan focus treatment. */
  focus?: boolean;
  /** Extra classes on the scrolling body (e.g. "flex flex-col"). */
  bodyClassName?: string;
  children: ReactNode;
}

export function Panel({ id, title, right, footer, focus, bodyClassName, children }: PanelProps) {
  return (
    <section
      className={`desk-panel${focus ? " desk-panel-focus" : ""}`}
      data-panel={id}
      aria-label={typeof title === "string" ? title : undefined}
    >
      <header className="desk-panel-header">
        <h2 className="t-title d-tx truncate">{title}</h2>
        {right ? <div className="t-cap d-mute ml-auto flex shrink-0 items-center gap-2">{right}</div> : null}
      </header>
      <div className={`desk-panel-body desk-scroll${bodyClassName ? ` ${bodyClassName}` : ""}`}>{children}</div>
      {footer ? <footer className="desk-footer">{footer}</footer> : null}
    </section>
  );
}
